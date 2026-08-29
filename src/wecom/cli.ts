import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type { WsFrame } from '@wecom/aibot-node-sdk';
import { CodexAdapter } from '../agent/codex/adapter';
import type { AgentRun } from '../agent/types';
import type { CodexSandboxMode } from '../config/permissions';

interface SessionRecord {
  threadId?: string;
  updatedAt: string;
}

type SessionMap = Record<string, SessionRecord>;

const botId = process.env.WECOM_BOT_ID?.trim();
const secret = process.env.WECOM_SECRET?.trim();
if (!botId || !secret) {
  console.error('Missing WECOM_BOT_ID or WECOM_SECRET.');
  process.exit(1);
}

const workspace = path.resolve(process.env.WECOM_WORKSPACE || process.cwd());
const stateDir = path.resolve(
  process.env.WECOM_STATE_DIR || path.join(os.homedir(), '.lark-channel', 'wecom'),
);
const sessionFile = path.join(stateDir, 'sessions.json');
const sandbox = readSandbox(process.env.WECOM_CODEX_SANDBOX);
const model = process.env.WECOM_CODEX_MODEL?.trim() || undefined;

await mkdir(stateDir, { recursive: true });
let sessions = await loadSessions(sessionFile);
const activeRuns = new Map<string, AgentRun>();

const codex = new CodexAdapter({
  binary: process.env.CODEX_BINARY?.trim() || 'codex',
  profileStateDir: stateDir,
  inheritCodexHome: true,
  ignoreUserConfig: false,
  ignoreRules: false,
  sandbox,
});

await codex.prepareRun();

const client = new WSClient({ botId, secret });

client.on('authenticated', () => {
  console.log(`✓ WeCom bot authenticated; workspace=${workspace}; sandbox=${sandbox}`);
});
client.on('reconnecting', (attempt: number) => {
  console.warn(`WeCom reconnecting (attempt ${attempt})`);
});
client.on('error', (err: Error) => {
  console.error(`WeCom error: ${err.message}`);
});
client.on('message.text', (frame: WsFrame) => {
  void handleText(frame).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Message handling failed: ${message}`);
    await replyOnce(frame, `处理失败：${message}`).catch(() => {});
  });
});

client.connect();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function handleText(frame: WsFrame): Promise<void> {
  const body = frame.body as any;
  const text = String(body.text?.content ?? '').trim();
  if (!text) return;

  const key = conversationKey(body);
  const command = text.toLowerCase();

  if (command === '/new' || command === '/reset') {
    delete sessions[key];
    await saveSessions(sessionFile, sessions);
    await replyOnce(frame, '已新建会话。下一条消息会创建新的 Codex thread。');
    return;
  }

  if (command === '/status') {
    const session = sessions[key];
    const running = activeRuns.has(key) ? '运行中' : '空闲';
    await replyOnce(
      frame,
      [`状态：${running}`, `workspace: ${workspace}`, `sandbox: ${sandbox}`, `thread: ${session?.threadId ?? 'new'}`].join('\n'),
    );
    return;
  }

  if (command === '/stop') {
    const run = activeRuns.get(key);
    if (!run) {
      await replyOnce(frame, '当前没有正在运行的任务。');
      return;
    }
    await run.stop();
    activeRuns.delete(key);
    await replyOnce(frame, '已停止当前任务。');
    return;
  }

  if (activeRuns.has(key)) {
    await replyOnce(frame, '上一条任务仍在运行。发送 /stop 停止，或等待完成后再发送。');
    return;
  }

  const streamId = generateReqId('stream');
  await client.replyStream(frame, streamId, '正在处理…', false);

  const run = codex.run({
    runId: randomUUID(),
    prompt: text,
    cwd: workspace,
    threadId: sessions[key]?.threadId,
    model,
    sandbox,
  });
  activeRuns.set(key, run);

  let output = '';
  let lastSent = '';
  let threadId = sessions[key]?.threadId;
  let lastFlushAt = 0;

  try {
    for await (const event of run.events) {
      if (event.type === 'system' && event.threadId) threadId = event.threadId;
      if (event.type === 'text') output += event.delta;
      if (event.type === 'final_text') output = event.content || output;
      if (event.type === 'done' && event.threadId) threadId = event.threadId;
      if (event.type === 'error') throw new Error(event.message);

      const now = Date.now();
      if (output && output !== lastSent && now - lastFlushAt >= 500) {
        lastSent = output;
        lastFlushAt = now;
        await client.replyStream(frame, streamId, truncate(output), false);
      }
    }

    if (threadId) {
      sessions[key] = { threadId, updatedAt: new Date().toISOString() };
      await saveSessions(sessionFile, sessions);
    }

    const finalText = output.trim() || '任务已完成，但 Codex 没有返回文本。';
    await client.replyStream(frame, streamId, truncate(finalText), true);
    await run.waitForExit(1500).catch(() => false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await client.replyStream(frame, streamId, `处理失败：${message}`, true).catch(() => {});
    throw err;
  } finally {
    activeRuns.delete(key);
  }
}

function conversationKey(body: any): string {
  if (body.chattype === 'group' && body.chatid) return `group:${body.chatid}`;
  const userid = body.from?.userid;
  if (!userid) throw new Error('WeCom message missing sender userid');
  return `single:${userid}`;
}

async function replyOnce(frame: WsFrame, text: string): Promise<void> {
  await client.replyStream(frame, generateReqId('stream'), text, true);
}

function truncate(text: string): string {
  const max = Number(process.env.WECOM_STREAM_MAX_CHARS || 15000);
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（内容过长，已截断）`;
}

function readSandbox(value: string | undefined): CodexSandboxMode {
  if (!value) return 'read-only';
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }
  throw new Error(`Invalid WECOM_CODEX_SANDBOX: ${value}`);
}

async function loadSessions(file: string): Promise<SessionMap> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as SessionMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
}

async function saveSessions(file: string, value: SessionMap): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

function shutdown(): void {
  for (const run of activeRuns.values()) void run.stop().catch(() => {});
  client.disconnect();
  process.exit(0);
}
