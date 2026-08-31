import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type {
  EnterChatEvent,
  EventMessageWith,
  TemplateCard,
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
import {
  buildWeComControlCard,
  renderWeComMarkdown,
  renderWeComNotice,
  truncateUtf8,
  type WeComCardStatus,
} from './presentation';
import {
  conversationKey,
  normalizeCardAction,
  normalizeIncomingText,
  readSandbox,
  readStreamMaxBytes,
  sendControlCard,
  templateCardEventDetails,
  WeComStreamReply,
  withActiveRun,
  withReservation,
} from './runtime';
import { WeComSessionStore } from './session-store';

type TextFrame = WsFrame<TextMessage>;
type EnterChatFrame = WsFrame<EventMessageWith<EnterChatEvent>>;
type TemplateCardEventFrame = WsFrame<EventMessageWith<TemplateCardEventData>>;

interface ActiveRunRecord {
  run: AgentRun;
  state: RunState;
  prompt: string;
  taskId: string;
  threadId?: string;
}

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
const sessionStore = new WeComSessionStore(sessionFile);
await sessionStore.load();
const activeRuns = new Map<string, ActiveRunRecord>();
const startingRuns = new Set<string>();

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

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function handleText(frame: TextFrame): Promise<void> {
  const body = frame.body;
  if (!body) return;

  const text = normalizeIncomingText(body.text.content, body.chattype);
  if (!text) return;

  const key = conversationKey(body);
  const command = text.toLowerCase();

  if (command === '/new' || command === '/reset') {
    if (isConversationBusy(key)) {
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
    await sessionStore.clear(key);
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
      const starting = startingRuns.has(key);
      await replyControl(
        frame,
        key,
        starting ? '⏳ Codex 正在启动' : 'ℹ️ 当前没有运行任务',
        [starting ? '任务完成启动后可再次停止。' : '可以直接发送新问题。'],
        starting ? 'running' : 'idle',
        starting ? '任务正在启动' : '当前为空闲状态',
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

  if (isConversationBusy(key)) {
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

  await withReservation(startingRuns, key, () => runCodexPrompt(frame, key, text));
}

async function runCodexPrompt(frame: TextFrame, key: string, text: string): Promise<void> {
  const streamId = generateReqId('stream');
  const stream = new WeComStreamReply(client, frame, streamId);
  const taskId = createTaskId();
  let threadId = sessionStore.threadId(key);
  let state = freshRunState();
  let lastSent = renderStream(state, threadId);
  let lastFlushAt = Date.now();

  await stream.start(lastSent);
  await deliverControlCard(
    frame,
    buildWeComControlCard({
      taskId,
      status: 'running',
      workspace,
      sandbox,
      threadId,
      prompt: text,
    }),
  );

  let run: AgentRun;
  try {
    run = codex.run({
      runId: randomUUID(),
      prompt: text,
      cwd: workspace,
      threadId,
      model,
      sandbox,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = reduce(state, {
      type: 'error',
      message,
      terminationReason: 'failed',
    });
    await stream.finish(renderStream(state, threadId)).catch(() => {});
    console.error(`Failed to start Codex run: ${message}`);
    return;
  }

  const active: ActiveRunRecord = {
    run,
    state,
    prompt: text,
    taskId,
    threadId,
  };
  await withActiveRun(activeRuns, key, active, async () => {
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
          await stream.update(rendered);
        }
      }

      state = finalizeIfRunning(state);
      active.state = state;
      active.threadId = threadId;
      await persistThread(key, threadId);

      const finalText = renderStream(state, threadId);
      await stream.finish(finalText);
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
      await run.stop().catch(() => {});
      await persistThread(key, threadId).catch((persistErr: unknown) => {
        console.error(
          `Failed to persist WeCom thread: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
        );
      });
      await stream.finish(renderStream(state, threadId)).catch(() => {});
      console.error(`Codex run failed: ${message}`);
    }
  });
}

async function handleEnterChat(frame: EnterChatFrame): Promise<void> {
  const body = frame.body;
  if (!body) return;
  const key = conversationKey(body);

  await client.replyWelcome(frame, {
    msgtype: 'template_card',
    template_card: buildWeComControlCard({
      taskId: createTaskId(),
      status: isConversationBusy(key) ? 'running' : 'idle',
      workspace,
      sandbox,
      threadId: currentThreadId(key),
      prompt: '发送消息开始；运行时可停止，也可用 /status、/new、/stop。',
      notice: '发送消息即可调用本机 Codex',
    }),
  });
}

async function handleTemplateCardEvent(frame: TemplateCardEventFrame): Promise<void> {
  const body = frame.body;
  if (!body) return;

  const key = conversationKey(body);
  const { eventKey: rawAction, taskId } = templateCardEventDetails(body.event);
  const action = normalizeCardAction(rawAction);
  if (!taskId) {
    throw new Error('WeCom template card event missing task_id');
  }

  const active = activeRuns.get(key);
  const starting = startingRuns.has(key);

  if (action === 'stop') {
    await client.updateTemplateCard(
      frame,
      buildWeComControlCard({
        taskId,
        status: active ? 'stopping' : starting ? 'running' : 'idle',
        workspace,
        sandbox,
        threadId: currentThreadId(key),
        prompt: active?.prompt,
        notice: active ? '停止请求已发送' : starting ? '任务正在启动' : '当前没有运行任务',
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
    if (active || starting) {
      await client.updateTemplateCard(
        frame,
        buildWeComControlCard({
          taskId,
          status: 'running',
          workspace,
          sandbox,
          threadId: active?.threadId,
          prompt: active?.prompt,
          notice: active ? '任务运行中，请先停止' : '任务正在启动，请稍候',
        }),
      );
      return;
    }

    const clearResult = sessionStore.clear(key).then(
      () => undefined,
      (err: unknown) => err,
    );
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
    const clearError = await clearResult;
    if (clearError) throw clearError;
    return;
  }

  if (action === 'status') {
    await client.updateTemplateCard(
      frame,
      buildWeComControlCard({
        taskId,
        status: active || starting ? 'running' : 'idle',
        workspace,
        sandbox,
        threadId: currentThreadId(key),
        prompt: active?.prompt,
        notice: active ? 'Codex 正在运行' : starting ? 'Codex 正在启动' : '当前为空闲状态',
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
      notice: `未识别的操作：${rawAction ?? 'unknown'}`,
    }),
  );
}

async function replyStatus(frame: WsFrame, key: string): Promise<void> {
  const active = activeRuns.get(key);
  const busy = isConversationBusy(key);
  const threadId = currentThreadId(key);
  await replyControl(
    frame,
    key,
    busy ? '🟡 Codex 正在运行' : '🟢 Codex 当前空闲',
    [
      `工作区：\`${workspace}\``,
      `权限：\`${sandbox}\``,
      `会话：\`${threadId ?? 'new'}\``,
      `模型：\`${model ?? 'Codex default'}\``,
    ],
    busy ? 'running' : 'idle',
    active ? 'Codex 正在运行' : busy ? 'Codex 正在启动' : '当前为空闲状态',
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
  const stream = new WeComStreamReply(client, frame, streamId);
  await stream.finish(content);
  await deliverControlCard(
    frame,
    buildWeComControlCard({
      taskId: createTaskId(),
      status,
      workspace,
      sandbox,
      threadId: currentThreadId(key),
      prompt,
      notice,
    }),
  );
}

async function deliverControlCard(frame: WsFrame, card: TemplateCard): Promise<void> {
  const body = frame.body;
  if (!body) return;
  try {
    await sendControlCard(client, body, card);
  } catch (err) {
    console.error(
      `Failed to send WeCom control card: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  return activeRuns.get(key)?.threadId ?? sessionStore.threadId(key);
}

async function persistThread(key: string, threadId: string | undefined): Promise<void> {
  if (!threadId) return;
  await sessionStore.setThread(key, threadId);
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

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function isConversationBusy(key: string): boolean {
  return startingRuns.has(key) || activeRuns.has(key);
}

let shuttingDown = false;

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const runs = [...activeRuns.values()];
  await Promise.allSettled(runs.map((active) => active.run.stop()));
  await sessionStore.flush().catch((err: unknown) => {
    console.error(
      `Failed to flush WeCom sessions during ${signal}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  client.disconnect();
  process.exit(0);
}
