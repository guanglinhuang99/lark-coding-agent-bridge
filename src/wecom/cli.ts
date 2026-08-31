import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type {
  BaseMessage,
  EnterChatEvent,
  EventMessageWith,
  FileMessage,
  ImageMessage,
  MixedMessage,
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
  messageTarget,
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
import {
  closeLogger,
  configureLogger,
  gcOldLogs,
  log,
  redactDiagnosticText,
} from '../core/logger';
import { inspectWeComHealth, WeComHealthStore, type WeComHealthPhase } from './health';
import {
  buildWeComAgentPrompt,
  collectWeComMediaInputs,
  gcWeComMediaCache,
  textFromWeComMessage,
  WeComMediaStore,
  type WeComMediaInput,
} from './media';
import { sendLinkedWorkspaceArtifacts } from './egress';
import type { NormalizedAttachment } from '../media/attachment';

type TextFrame = WsFrame<TextMessage>;
type ImageFrame = WsFrame<ImageMessage>;
type FileFrame = WsFrame<FileMessage>;
type MixedFrame = WsFrame<MixedMessage>;
type EnterChatFrame = WsFrame<EventMessageWith<EnterChatEvent>>;
type TemplateCardEventFrame = WsFrame<EventMessageWith<TemplateCardEventData>>;

interface ActiveRunRecord {
  run: AgentRun;
  state: RunState;
  prompt: string;
  taskId: string;
  threadId?: string;
}

const workspace = path.resolve(process.env.WECOM_WORKSPACE || process.cwd());
const stateDir = path.resolve(
  process.env.WECOM_STATE_DIR || path.join(os.homedir(), '.lark-channel', 'wecom'),
);
const sessionFile = path.join(stateDir, 'sessions.json');
const healthFile = path.join(stateDir, 'health.json');
const healthStaleMs = readPositiveInt(process.env.WECOM_HEALTH_STALE_MS, 90_000);

if (process.argv.includes('--health')) {
  const inspection = await inspectWeComHealth(healthFile, { staleAfterMs: healthStaleMs });
  console.log(JSON.stringify(inspection));
  process.exit(inspection.healthy ? 0 : 1);
}

const botId = process.env.WECOM_BOT_ID?.trim();
const secret = process.env.WECOM_SECRET?.trim();
if (!botId || !secret) {
  console.error('Missing WECOM_BOT_ID or WECOM_SECRET.');
  process.exit(1);
}

const sandbox = readSandbox(process.env.WECOM_CODEX_SANDBOX);
const model = process.env.WECOM_CODEX_MODEL?.trim() || undefined;
const streamMaxBytes = readStreamMaxBytes(
  process.env.WECOM_STREAM_MAX_BYTES ?? process.env.WECOM_STREAM_MAX_CHARS,
);
const streamFlushIntervalMs = readPositiveInt(process.env.WECOM_STREAM_FLUSH_MS, 500);
const requestTimeoutMs = readPositiveInt(process.env.WECOM_REQUEST_TIMEOUT_MS, 30_000);
const heartbeatMs = readPositiveInt(process.env.WECOM_HEALTH_INTERVAL_MS, 30_000);
const logRetentionDays = readPositiveInt(process.env.WECOM_LOG_RETENTION_DAYS, 30);
const mediaDir = path.join(stateDir, 'media');
const mediaCacheMaxAgeMs = readPositiveInt(
  process.env.WECOM_MEDIA_CACHE_TTL_MS,
  7 * 24 * 60 * 60 * 1000,
);
const attachmentOptions = {
  maxCount: readPositiveInt(process.env.WECOM_ATTACHMENT_MAX_COUNT, 10),
  maxBytes: readPositiveInt(process.env.WECOM_ATTACHMENT_MAX_BYTES, 100 * 1024 * 1024),
  maxFileBytes: readPositiveInt(process.env.WECOM_ATTACHMENT_MAX_FILE_BYTES, 25 * 1024 * 1024),
  imageMaxBytes: readPositiveInt(process.env.WECOM_IMAGE_MAX_BYTES, 10 * 1024 * 1024),
  cacheMaxAgeMs: mediaCacheMaxAgeMs,
};
const artifactOptions = {
  maxCount: readPositiveInt(process.env.WECOM_OUTPUT_MAX_COUNT, 5),
  maxFileBytes: readPositiveInt(process.env.WECOM_OUTPUT_MAX_FILE_BYTES, 25 * 1024 * 1024),
  maxTotalBytes: readPositiveInt(process.env.WECOM_OUTPUT_MAX_BYTES, 50 * 1024 * 1024),
};

await mkdir(stateDir, { recursive: true });
configureLogger({ logsDir: path.join(stateDir, 'logs'), retentionDays: logRetentionDays });
await gcOldLogs();
await gcWeComMediaCache(mediaDir, mediaCacheMaxAgeMs);
const sessionStore = new WeComSessionStore(sessionFile);
await sessionStore.load();
const activeRuns = new Map<string, ActiveRunRecord>();
const startingRuns = new Set<string>();
const healthStore = new WeComHealthStore(healthFile);
let healthPhase: WeComHealthPhase = 'starting';
let connected = false;
let reconnectAttempt: number | undefined;
let lastHealthError: string | undefined;
await refreshHealth();

const codex = new CodexAdapter({
  binary: process.env.CODEX_BINARY?.trim() || 'codex',
  profileStateDir: stateDir,
  inheritCodexHome: true,
  ignoreUserConfig: false,
  ignoreRules: false,
  sandbox,
});

await codex.prepareRun();

const client = new WSClient({ botId, secret, requestTimeout: requestTimeoutMs });
const mediaStore = new WeComMediaStore(client, mediaDir);

client.on('connected', () => {
  healthPhase = 'starting';
  log.info('ws', 'connected');
  void refreshHealth();
});
client.on('authenticated', () => {
  connected = true;
  healthPhase = 'connected';
  reconnectAttempt = undefined;
  lastHealthError = undefined;
  log.info('ws', 'authenticated', { sandbox });
  void refreshHealth();
  console.log(`✓ WeCom bot authenticated; workspace=${workspace}; sandbox=${sandbox}`);
});
client.on('reconnecting', (attempt: number) => {
  connected = false;
  healthPhase = 'reconnecting';
  reconnectAttempt = attempt;
  log.warn('ws', 'reconnecting', { attempt });
  void refreshHealth();
  console.warn(`WeCom reconnecting (attempt ${attempt})`);
});
client.on('disconnected', (reason: string) => {
  connected = false;
  healthPhase = shuttingDown ? 'stopping' : 'disconnected';
  log.warn('ws', 'disconnected', { reason });
  void refreshHealth();
});
client.on('error', (err: Error) => {
  connected = false;
  healthPhase = 'error';
  lastHealthError = redactDiagnosticText(err.message).slice(0, 500);
  log.fail('ws', err);
  void refreshHealth();
  console.error(`WeCom error: ${redactDiagnosticText(err.message)}`);
});
client.on('message.text', (frame: TextFrame) => {
  handleMessageEvent(frame);
});
client.on('message.image', (frame: ImageFrame) => {
  handleMessageEvent(frame);
});
client.on('message.file', (frame: FileFrame) => {
  handleMessageEvent(frame);
});
client.on('message.mixed', (frame: MixedFrame) => {
  handleMessageEvent(frame);
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

const heartbeat = setInterval(() => {
  void refreshHealth();
}, heartbeatMs);
heartbeat.unref();

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

function handleMessageEvent<T extends BaseMessage>(frame: WsFrame<T>): void {
  void handleMessage(frame).catch(async (err: unknown) => {
    const message = redactDiagnosticText(err instanceof Error ? err.message : String(err));
    log.fail('wecom-message', err);
    console.error(`Message handling failed: ${message}`);
    await replyOnce(frame, '⚠️ 处理失败', [`${message}`]).catch(() => {});
  });
}

async function handleMessage<T extends BaseMessage>(frame: WsFrame<T>): Promise<void> {
  const body = frame.body;
  if (!body) return;

  const text = normalizeIncomingText(textFromWeComMessage(body), body.chattype);
  const mediaInputs = collectWeComMediaInputs(body);
  if (!text && mediaInputs.length === 0) return;

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

  try {
    await withReservation(startingRuns, key, async () => {
      await refreshHealth();
      const attachments = await resolveAttachments(mediaInputs);
      const prompt = buildWeComAgentPrompt(text, attachments);
      const displayPrompt = text || attachmentSummary(attachments);
      await runCodexPrompt(frame, key, prompt, displayPrompt, attachments);
    });
  } finally {
    await refreshHealth();
  }
}

async function runCodexPrompt(
  frame: WsFrame,
  key: string,
  prompt: string,
  displayPrompt: string,
  attachments: readonly NormalizedAttachment[],
): Promise<void> {
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
      prompt: displayPrompt,
    }),
  );

  let run: AgentRun;
  try {
    run = codex.run({
      runId: randomUUID(),
      prompt,
      cwd: workspace,
      threadId,
      model,
      sandbox,
      images: attachments
        .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
        .map((attachment) => attachment.absPath),
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
    prompt: displayPrompt,
    taskId,
    threadId,
  };
  await withActiveRun(activeRuns, key, active, async () => {
    await refreshHealth();
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
      if (state.terminal === 'done') {
        await sendGeneratedArtifacts(frame, state, attachments);
      }
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
  await refreshHealth();
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

async function resolveAttachments(
  inputs: readonly WeComMediaInput[],
): Promise<NormalizedAttachment[]> {
  if (inputs.length === 0) return [];
  const attachments = await mediaStore.resolve(inputs, attachmentOptions);
  for (const attachment of attachments) {
    log.info('wecom-media', 'attachment', {
      decision: attachment.decision,
      kind: attachment.kind,
      size: attachment.size,
      hash: attachment.hash,
      rejectionReason: attachment.rejectionReason,
    });
  }
  return attachments;
}

function attachmentSummary(attachments: readonly NormalizedAttachment[]): string {
  const accepted = attachments.filter((attachment) => attachment.decision === 'accepted');
  if (accepted.length === 0) return '收到附件，但附件未通过本地大小或格式校验。';
  const images = accepted.filter((attachment) => attachment.kind === 'image').length;
  const files = accepted.filter((attachment) => attachment.kind === 'file').length;
  return [images ? `${images} 张图片` : '', files ? `${files} 个文件` : '']
    .filter(Boolean)
    .join('、');
}

async function sendGeneratedArtifacts(
  frame: WsFrame,
  state: RunState,
  attachments: readonly NormalizedAttachment[],
): Promise<void> {
  const body = frame.body;
  if (!body) return;
  const markdown = agentOutputText(state);
  if (!markdown) return;
  try {
    const result = await sendLinkedWorkspaceArtifacts(
      client,
      messageTarget(body),
      workspace,
      markdown,
      {
        ...artifactOptions,
        excludedPaths: attachments
          .filter((attachment) => attachment.decision === 'accepted')
          .map((attachment) => attachment.absPath),
      },
    );
    log.info('wecom-media', 'egress', {
      sent: result.sent.length,
      skipped: result.skipped.map((item) => item.reason),
      bytes: result.sent.reduce((sum, item) => sum + item.size, 0),
    });
  } catch (err) {
    log.fail('wecom-media-egress', err);
    await client.sendMessage(messageTarget(body), {
      msgtype: 'markdown',
      markdown: { content: '⚠️ 生成文件回传失败，请查看本机 bridge 日志。' },
    }).catch(() => {});
  }
}

function agentOutputText(state: RunState): string {
  const streamed = state.blocks
    .filter((block): block is Extract<(typeof state.blocks)[number], { kind: 'text' }> =>
      block.kind === 'text',
    )
    .map((block) => block.content)
    .join('\n\n');
  return [streamed, state.finalText ?? ''].filter(Boolean).join('\n\n');
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

async function refreshHealth(): Promise<void> {
  await healthStore.update({
    phase: healthPhase,
    connected,
    activeRuns: activeRuns.size,
    startingRuns: startingRuns.size,
    ...(reconnectAttempt !== undefined ? { reconnectAttempt } : {}),
    ...(lastHealthError ? { lastError: lastHealthError } : {}),
  }).catch((err: unknown) => {
    log.fail('wecom-health', err);
  });
}

let shuttingDown = false;

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  connected = false;
  healthPhase = 'stopping';
  await refreshHealth();
  const runs = [...activeRuns.values()];
  await Promise.allSettled(runs.map((active) => active.run.stop()));
  await sessionStore.flush().catch((err: unknown) => {
    console.error(
      `Failed to flush WeCom sessions during ${signal}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  client.disconnect();
  await healthStore.flush().catch(() => {});
  await closeLogger();
  process.exit(0);
}
