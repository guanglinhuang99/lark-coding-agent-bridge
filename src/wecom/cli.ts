import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type {
  EnterChatEvent,
  EventMessageWith,
  TemplateCardEventData,
  TextMessage,
  WsFrame,
} from '@wecom/aibot-node-sdk';
import { CodexAdapter } from '../agent/codex/adapter';
import type { AgentRun } from '../agent/types';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import type { CodexSandboxMode } from '../config/permissions';
import {
  buildWeComControlCard,
  renderWeComMarkdown,
  renderWeComNotice,
  truncateUtf8,
  type WeComCardStatus,
} from './presentation';

interface SessionRecord {
  threadId?: string;
  updatedAt: string;
}

type SessionMap = Record<string, SessionRecord>;
type TextFrame = WsFrame<TextMessage>;
type EnterChatFrame = WsFrame<EventMessageWith<EnterChatEvent>>;
type TemplateCardEventFrame = WsFrame<EventMessageWith<TemplateCardEventData>>;

interface ConversationBody {
  chattype?: 'single' | 'group';
  chatid?: string;
  from?: { userid?: string };
}

interface ActiveRunRecord {
  run: AgentRun;
  state: RunState;
  prompt: string;
  taskId: string;
  threadId?: string;
}

const WECOM_PROTOCOL_MAX_STREAM_BYTES = 20_480;
const DEFAULT_STREAM_MAX_BYTES = 20_000;

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
const streamMaxBytes = readStreamMaxBytes(
  process.env.WECOM_STREAM_MAX_BYTES ?? process.env.WECOM_STREAM_MAX_CHARS,
);
const streamFlushIntervalMs = readPositiveInt(process.env.WECOM_STREAM_FLUSH_MS, 500);

await mkdir(stateDir, { recursive: true });
let sessions = await loadSessions(sessionFile);
const activeRuns = new Map<string, ActiveRunRecord>();

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
client.on('message.text', (frame: TextFrame) => {
  void handleText(frame).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Message handling failed: ${message}`);
    await replyOnce(frame, '⚠️ 处理失败', [`${message}`]).catch(() => {});
  });
});
client.on('event.enter_chat', (frame: EnterChatFrame) => {
  void handleEnterChat(frame).catch((err: unknown) => {
    console.error(`Welcome card failed: ${err instanceof Error ? err.message : String(err)}`);
  });
});
client.on('event.template_card_event', (frame: TemplateCardEventFrame) => {
  void handleTemplateCardEvent(frame).catch((err: unknown) => {
    console.error(`Template card action failed: ${err instanceof Error ? err.message : String(err)}`);
  });
});

client.connect();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function handleText(frame: TextFrame): Promise<void> {
  const body = frame.body;
  if (!body) return;

  const text = body.text.content.trim();
  if (!text) return;

  const key = conversationKey(body);
  const command = text.toLowerCase();

  if (command === '/new' || command === '/reset') {
    if (activeRuns.has(key)) {
      await replyControl(
        frame,
        key,
        '⏳ 当前任务仍在运行',
        ['请先发送 `/stop`，或点击卡片中的“停止”。'],
        'running',
        '任务运行中，暂不能重置会话',
      );
      return;
    }
    delete sessions[key];
    await saveSessions(sessionFile, sessions);
    await replyControl(
      frame,
      key,
      '✅ 已创建新会话',
      ['下一条消息会创建新的 Codex thread。'],
      'reset',
      '会话已重置',
    );
    return;
  }

  if (command === '/status') {
    await replyStatus(frame, key);
    return;
  }

  if (command === '/stop') {
    const active = activeRuns.get(key);
    if (!active) {
      await replyControl(
        frame,
        key,
        'ℹ️ 当前没有运行任务',
        ['可以直接发送新问题。'],
        'idle',
        '当前为空闲状态',
      );
      return;
    }

    active.state = markInterrupted(active.state);
    await active.run.stop();
    await replyControl(
      frame,
      key,
      '⏹ 已发送停止请求',
      ['当前 Codex 任务正在终止。'],
      'stopping',
      '停止请求已发送',
      active.prompt,
    );
    return;
  }

  if (activeRuns.has(key)) {
    await replyControl(
      frame,
      key,
      '⏳ 上一条任务仍在运行',
      ['发送 `/stop` 停止，或等待完成后再发送。'],
      'running',
      '同一会话一次只运行一个任务',
    );
    return;
  }

  const streamId = generateReqId('stream');
  const taskId = createTaskId();
  let threadId = sessions[key]?.threadId;
  let state = freshRunState();
  let lastSent = renderStream(state, threadId);
  let lastFlushAt = Date.now();

  await client.replyStreamWithCard(frame, streamId, lastSent, false, {
    templateCard: buildWeComControlCard({
      taskId,
      status: 'running',
      workspace,
      sandbox,
      threadId,
      prompt: text,
    }),
  });

  const run = codex.run({
    runId: randomUUID(),
    prompt: text,
    cwd: workspace,
    threadId,
    model,
    sandbox,
  });
  const active: ActiveRunRecord = {
    run,
    state,
    prompt: text,
    taskId,
    threadId,
  };
  activeRuns.set(key, active);

  try {
    for await (const event of run.events) {
      if (event.type === 'system' && event.threadId) threadId = event.threadId;
      if (event.type === 'done' && event.threadId) threadId = event.threadId;

      state = reduce(state, event);
      active.state = state;
      active.threadId = threadId;

      const rendered = renderStream(state, threadId);
      const now = Date.now();
      const terminal = state.terminal !== 'running';
      if (rendered !== lastSent && (terminal || now - lastFlushAt >= streamFlushIntervalMs)) {
        lastSent = rendered;
        lastFlushAt = now;
        await client.replyStream(frame, streamId, rendered, false);
      }
    }

    state = finalizeIfRunning(state);
    active.state = state;
    active.threadId = threadId;
    await persistThread(key, threadId);

    const finalText = renderStream(state, threadId);
    await client.replyStream(frame, streamId, finalText, true);
    await run.waitForExit(1500).catch(() => false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = reduce(state, {
      type: 'error',
      message,
      terminationReason: 'failed',
    });
    active.state = state;
    active.threadId = threadId;
    await persistThread(key, threadId);
    await client.replyStream(frame, streamId, renderStream(state, threadId), true).catch(() => {});
    console.error(`Codex run failed: ${message}`);
  } finally {
    activeRuns.delete(key);
  }
}

async function handleEnterChat(frame: EnterChatFrame): Promise<void> {
  const body = frame.body;
  if (!body) return;
  const key = conversationKey(body);

  await client.replyWelcome(frame, {
    msgtype: 'template_card',
    template_card: buildWeComControlCard({
      taskId: createTaskId(),
      status: activeRuns.has(key) ? 'running' : 'idle',
      workspace,
      sandbox,
      threadId: currentThreadId(key),
      notice: '发送消息即可调用本机 Codex',
    }),
  });
}

async function handleTemplateCardEvent(frame: TemplateCardEventFrame): Promise<void> {
  const body = frame.body;
  if (!body) return;

  const key = conversationKey(body);
  const action = body.event.event_key;
  const taskId = body.event.task_id;
  if (!taskId) {
    throw new Error('WeCom template card event missing task_id');
  }

  const active = activeRuns.get(key);

  if (action === 'stop') {
    await client.updateTemplateCard(
      frame,
      buildWeComControlCard({
        taskId,
        status: active ? 'stopping' : 'idle',
        workspace,
        sandbox,
        threadId: currentThreadId(key),
        prompt: active?.prompt,
        notice: active ? '停止请求已发送' : '当前没有运行任务',
      }),
    );
    if (active) {
      active.state = markInterrupted(active.state);
      void active.run.stop().catch((err: unknown) => {
        console.error(`Failed to stop Codex run: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return;
  }

  if (action === 'new') {
    if (active) {
      await client.updateTemplateCard(
        frame,
        buildWeComControlCard({
          taskId,
          status: 'running',
          workspace,
          sandbox,
          threadId: active.threadId,
          prompt: active.prompt,
          notice: '任务运行中，请先停止',
        }),
      );
      return;
    }

    delete sessions[key];
    await saveSessions(sessionFile, sessions);
    await client.updateTemplateCard(
      frame,
      buildWeComControlCard({
        taskId,
        status: 'reset',
        workspace,
        sandbox,
        notice: '已创建新会话',
      }),
    );
    return;
  }

  if (action === 'status') {
    await client.updateTemplateCard(
      frame,
      buildWeComControlCard({
        taskId,
        status: active ? 'running' : 'idle',
        workspace,
        sandbox,
        threadId: currentThreadId(key),
        prompt: active?.prompt,
        notice: active ? 'Codex 正在运行' : '当前为空闲状态',
      }),
    );
    return;
  }

  await client.updateTemplateCard(
    frame,
    buildWeComControlCard({
      taskId,
      status: 'error',
      workspace,
      sandbox,
      threadId: currentThreadId(key),
      notice: `未识别的操作：${action ?? 'unknown'}`,
    }),
  );
}

async function replyStatus(frame: WsFrame, key: string): Promise<void> {
  const active = activeRuns.get(key);
  const threadId = currentThreadId(key);
  await replyControl(
    frame,
    key,
    active ? '🟡 Codex 正在运行' : '🟢 Codex 当前空闲',
    [
      `工作区：\`${workspace}\``,
      `权限：\`${sandbox}\``,
      `会话：\`${threadId ?? 'new'}\``,
      `模型：\`${model ?? 'Codex default'}\``,
    ],
    active ? 'running' : 'idle',
    active ? 'Codex 正在运行' : '当前为空闲状态',
    active?.prompt,
  );
}

async function replyControl(
  frame: WsFrame,
  key: string,
  title: string,
  lines: readonly string[],
  status: WeComCardStatus,
  notice: string,
  prompt?: string,
): Promise<void> {
  const streamId = generateReqId('stream');
  const content = truncateUtf8(renderWeComNotice(title, lines), streamMaxBytes);
  await client.replyStreamWithCard(frame, streamId, content, true, {
    templateCard: buildWeComControlCard({
      taskId: createTaskId(),
      status,
      workspace,
      sandbox,
      threadId: currentThreadId(key),
      prompt,
      notice,
    }),
  });
}

function conversationKey(body: ConversationBody): string {
  if (body.chatid && body.chattype !== 'single') return `group:${body.chatid}`;
  const userid = body.from?.userid;
  if (!userid) throw new Error('WeCom message missing sender userid');
  return `single:${userid}`;
}

async function replyOnce(frame: WsFrame, title: string, lines: readonly string[]): Promise<void> {
  const content = truncateUtf8(renderWeComNotice(title, lines), streamMaxBytes);
  await client.replyStream(frame, generateReqId('stream'), content, true);
}

function renderStream(state: RunState, threadId: string | undefined): string {
  return truncateUtf8(
    renderWeComMarkdown(state, {
      workspace,
      sandbox,
      threadId,
    }),
    streamMaxBytes,
  );
}

function currentThreadId(key: string): string | undefined {
  return activeRuns.get(key)?.threadId ?? sessions[key]?.threadId;
}

async function persistThread(key: string, threadId: string | undefined): Promise<void> {
  if (!threadId) return;
  sessions[key] = { threadId, updatedAt: new Date().toISOString() };
  await saveSessions(sessionFile, sessions);
}

function createTaskId(): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  return `codex_${Date.now()}_${suffix}`;
}

function freshRunState(): RunState {
  return {
    ...initialState,
    blocks: [],
    reasoning: { ...initialState.reasoning },
  };
}

function readSandbox(value: string | undefined): CodexSandboxMode {
  if (!value) return 'read-only';
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }
  throw new Error(`Invalid WECOM_CODEX_SANDBOX: ${value}`);
}

function readStreamMaxBytes(value: string | undefined): number {
  const parsed = value ? Number(value) : DEFAULT_STREAM_MAX_BYTES;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STREAM_MAX_BYTES;
  return Math.min(Math.floor(parsed), WECOM_PROTOCOL_MAX_STREAM_BYTES);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function loadSessions(file: string): Promise<SessionMap> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as SessionMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return {};
    throw err;
  }
}

async function saveSessions(file: string, value: SessionMap): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error;
}

function shutdown(): void {
  for (const active of activeRuns.values()) void active.run.stop().catch(() => {});
  client.disconnect();
  process.exit(0);
}
