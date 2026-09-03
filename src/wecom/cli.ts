import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
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
  renderWeComAcknowledgement,
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
  WeComConversationQueue,
  WeComConversationQueueError,
  WeComMessageDeduplicator,
  WeComRunCapacityError,
  WeComRunGate,
  WeComStreamReply,
  WeComStreamUpdatePump,
  withActiveRun,
  withReservation,
  waitForCompletion,
  type ConversationBody,
  type WeComConversationSubmission,
} from './runtime';
import { WeComSessionStore } from './session-store';
import {
  closeLogger,
  configureLogger,
  gcOldLogs,
  log,
  redactDiagnosticText,
  reportMetric,
} from '../core/logger';
import { inspectWeComHealth, WeComHealthStore, type WeComHealthPhase } from './health';
import {
  buildWeComAgentPrompt,
  collectWeComMediaInputs,
  gcWeComMediaCache,
  promptContextFromWeComMessage,
  textFromWeComMessage,
  WeComMediaStore,
  type WeComMediaInput,
} from './media';
import { sendLinkedWorkspaceArtifacts } from './egress';
import type { NormalizedAttachment } from '../media/attachment';
import { RiskDirectClient } from './risk/client';
import {
  WeComRiskRouter,
  type RiskRouteResult,
  type RiskSelectionRequest,
} from './risk/router';
import {
  buildRiskSelectionCard,
  buildRiskSelectionStatusCard,
  RiskSelectionTaskRegistry,
} from './risk/card';
import { RiskProgressRelay } from './risk/progress';
import {
  buildIntentSelection,
  buildRiskIntentPrompt,
  canonicalCommand,
  isPretradeIntentCandidate,
  normalizeRiskDraft,
  normalizeSecurity,
  parseRiskIntentOutput,
  RiskIntentClarificationError,
  RiskIntentStateRegistry,
  type RiskAiDraft,
  type RiskIntentState,
} from './risk/intent';

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

const envFile = path.resolve(process.env.WECOM_ENV_FILE?.trim() || '.env');
if (existsSync(envFile)) loadEnvFile(envFile);

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
const messageDedupeTtlMs = readPositiveInt(
  process.env.WECOM_MESSAGE_DEDUPE_TTL_MS,
  30 * 60 * 1000,
);
const messageDedupeMaxEntries = readPositiveInt(
  process.env.WECOM_MESSAGE_DEDUPE_MAX_ENTRIES,
  10_000,
);
const maxConcurrentRuns = readPositiveInt(process.env.WECOM_MAX_CONCURRENT_RUNS, 2);
const maxQueuedRuns = readPositiveInt(process.env.WECOM_RUN_QUEUE_MAX, 4);
const runQueueTimeoutMs = readPositiveInt(process.env.WECOM_RUN_QUEUE_TIMEOUT_MS, 5_000);
const conversationQueueMax = readPositiveInt(process.env.WECOM_CONVERSATION_QUEUE_MAX, 5);
const conversationQueueTimeoutMs = readPositiveInt(
  process.env.WECOM_CONVERSATION_QUEUE_TIMEOUT_MS,
  2 * 60 * 1000,
);
const shutdownTimeoutMs = readPositiveInt(process.env.WECOM_SHUTDOWN_TIMEOUT_MS, 10_000);
const maintenanceIntervalMs = readPositiveInt(
  process.env.WECOM_MAINTENANCE_INTERVAL_MS,
  24 * 60 * 60 * 1000,
);
const sessionMaxAgeMs = readPositiveInt(
  process.env.WECOM_SESSION_TTL_MS,
  90 * 24 * 60 * 60 * 1000,
);
const sessionMaxEntries = readPositiveInt(process.env.WECOM_SESSION_MAX_ENTRIES, 2_000);
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
  downloadConcurrency: readPositiveInt(process.env.WECOM_MEDIA_DOWNLOAD_CONCURRENCY, 2),
  downloadTimeoutMs: readPositiveInt(process.env.WECOM_MEDIA_DOWNLOAD_TIMEOUT_MS, 90_000),
};
const artifactOptions = {
  maxCount: readPositiveInt(process.env.WECOM_OUTPUT_MAX_COUNT, 5),
  maxFileBytes: readPositiveInt(process.env.WECOM_OUTPUT_MAX_FILE_BYTES, 25 * 1024 * 1024),
  maxTotalBytes: readPositiveInt(process.env.WECOM_OUTPUT_MAX_BYTES, 50 * 1024 * 1024),
};
const configuredRiskServiceDir = process.env.WECOM_RISK_SERVICE_DIR?.trim();
const riskServiceDir = path.resolve(configuredRiskServiceDir || path.join(process.cwd(), 'risk-service'));
const riskBridgePath = path.resolve(
  process.env.WECOM_RISK_BRIDGE_PATH?.trim() ||
    path.join(process.cwd(), 'src/wecom/risk/direct_bridge.py'),
);
const riskPython = process.env.WECOM_RISK_PYTHON?.trim();
const riskTimeoutMs = readPositiveInt(process.env.WECOM_RISK_TIMEOUT_MS, 180_000);
const riskStartupTimeoutMs = readPositiveInt(
  process.env.WECOM_RISK_STARTUP_TIMEOUT_MS,
  30_000,
);
const riskDirectWorkers = readPositiveInt(process.env.WECOM_RISK_DIRECT_WORKERS, 4);
const riskProductCacheTtlMs = readPositiveInt(
  process.env.WECOM_RISK_PRODUCT_CACHE_TTL_MS,
  60 * 60_000,
);
const riskAllowedUserIds = new Set(
  (process.env.WECOM_RISK_ALLOWED_USERIDS ?? '')
    .replaceAll('，', ',')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

await mkdir(stateDir, { recursive: true });
configureLogger({ logsDir: path.join(stateDir, 'logs'), retentionDays: logRetentionDays });
await gcOldLogs();
await gcWeComMediaCache(mediaDir, mediaCacheMaxAgeMs);
const sessionStore = new WeComSessionStore(sessionFile, {
  maxAgeMs: sessionMaxAgeMs,
  maxEntries: sessionMaxEntries,
});
await sessionStore.load();
const activeRuns = new Map<string, ActiveRunRecord>();
const startingRuns = new Set<string>();
const messageDeduplicator = new WeComMessageDeduplicator(
  messageDedupeTtlMs,
  messageDedupeMaxEntries,
);
const conversationQueue = new WeComConversationQueue(
  conversationQueueMax,
  conversationQueueTimeoutMs,
);
const runGate = new WeComRunGate(maxConcurrentRuns, maxQueuedRuns, runQueueTimeoutMs);
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
const riskDirectEnabled = Boolean(
  riskPython && existsSync(riskServiceDir) && existsSync(riskBridgePath) && existsSync(riskPython),
);
const riskPythonPath = riskDirectEnabled ? riskPython! : undefined;
const riskClient = riskDirectEnabled
  ? new RiskDirectClient({
      pythonPath: riskPythonPath!,
      serviceDir: riskServiceDir,
      stateDir: path.join(stateDir, 'risk-service'),
      bridgePath: riskBridgePath,
      timeoutMs: riskTimeoutMs,
      startupTimeoutMs: riskStartupTimeoutMs,
      workers: riskDirectWorkers,
      onStage: ({ stage, durationMs, outcome }) => {
        reportMetric('wecom_risk_stage_ms', durationMs, { stage, outcome });
        log.info('wecom-risk-stage', 'completed', { stage, durationMs, outcome });
      },
      onDiagnostic: (line) => {
        log.warn('wecom-risk-direct', 'python', {
          message: redactDiagnosticText(line),
        });
      },
    })
  : undefined;
const riskRouter = riskClient
  ? new WeComRiskRouter(riskClient, { productCacheTtlMs: riskProductCacheTtlMs })
  : undefined;
const riskSelectionTasks = new RiskSelectionTaskRegistry();
const riskIntents = new RiskIntentStateRegistry();
const riskSelectionCardDelayMs = 800;

if (!riskDirectEnabled) {
  const reasons = [
    !riskPython ? 'WECOM_RISK_PYTHON is not configured' : undefined,
    !existsSync(riskServiceDir)
      ? configuredRiskServiceDir
        ? `WECOM_RISK_SERVICE_DIR does not exist: ${riskServiceDir}`
        : `local risk-service fallback does not exist: ${riskServiceDir}`
      : undefined,
    !existsSync(riskBridgePath) ? `risk bridge does not exist: ${riskBridgePath}` : undefined,
    riskPython && !existsSync(riskPython) ? `risk Python does not exist: ${riskPython}` : undefined,
  ].filter((item): item is string => Boolean(item));
  console.warn(`WeCom risk fast path disabled: ${reasons.join('; ')}`);
}

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

const maintenance = setInterval(() => {
  void runMaintenance();
}, maintenanceIntervalMs);
maintenance.unref();

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

function handleMessageEvent<T extends BaseMessage>(frame: WsFrame<T>): void {
  const messageId = frame.body?.msgid;
  if (messageId && !messageDeduplicator.claim(messageId)) {
    log.info('wecom-message', 'duplicate', { messageId });
    reportMetric('wecom_duplicate_message', 1);
    return;
  }
  void handleMessage(frame).catch(async (err: unknown) => {
    const message = redactDiagnosticText(err instanceof Error ? err.message : String(err));
    log.fail('wecom-message', err);
    reportMetric('wecom_message_failures', 1, { kind: failureKind(err) });
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
    riskRouter?.clear(key);
    riskSelectionTasks.clearConversation(key);
    riskIntents.clearConversation(key);
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
      const starting = startingRuns.has(key) || conversationQueue.has(key);
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

  const riskCandidate =
    riskIntents.has(key) ||
    (mediaInputs.length === 0 && isPretradeIntentCandidate(text)) ||
    (riskRouter?.shouldHandle(key, text, mediaInputs.length > 0) ?? false);
  const riskAccessDenied = riskCandidate && !isRiskUserAllowed(body.from?.userid);
  const useRiskFastPath = riskCandidate && !riskAccessDenied;
  const acknowledgement = text
    ? renderWeComAcknowledgement('input', text)
    : `收到，您发送的 ${mediaInputs.length} 个附件已收到。`;
  await new WeComStreamReply(client, frame, generateReqId('ack'))
    .finish(truncateUtf8(acknowledgement, streamMaxBytes))
    .catch((err: unknown) => {
      log.fail('wecom-ack', err, { step: 'input' });
    });
  const stream = new WeComStreamReply(client, frame, generateReqId('stream'));
  let markStreamReady!: () => void;
  let markStreamFailed!: (err: unknown) => void;
  const streamReady = new Promise<void>((resolve, reject) => {
    markStreamReady = resolve;
    markStreamFailed = reject;
  });
  let submission: WeComConversationSubmission;
  try {
    submission = conversationQueue.submit(key, async () => {
      await streamReady;
      await executeConversationMessage(
        frame,
        key,
        text,
        mediaInputs,
        stream,
        useRiskFastPath,
        riskAccessDenied,
      );
    });
  } catch (err) {
    if (!(err instanceof WeComConversationQueueError)) throw err;
    reportMetric('wecom_conversation_queue_rejected', 1, { reason: err.reason });
    await replyControl(
      frame,
      key,
      '⚠️ 当前会话排队较多',
      ['本条消息没有入队，请稍后重新发送。'],
      'error',
      conversationQueueNotice(err.reason),
    );
    return;
  }

  const initialNotice = submission.queued
    ? renderWeComNotice('🕒 已加入会话队列', [
        `当前排队位置：${submission.position}`,
        `最长等待：${Math.ceil(conversationQueueTimeoutMs / 1000)} 秒`,
        '前一项完成后会自动开始，无需重新发送。',
      ])
    : renderWeComNotice('⏳ 正在处理', [
        riskAccessDenied
          ? '正在检查风险查询权限。'
          : useRiskFastPath
            ? '正在准备风险限额查询。'
            : '正在准备 Codex 任务。',
      ]);
  try {
    await stream.start(truncateUtf8(initialNotice, streamMaxBytes));
    markStreamReady();
  } catch (err) {
    if (!submission.cancel(err)) markStreamFailed(err);
    await submission.completion.catch(() => {});
    throw err;
  }

  if (submission.queued) {
    log.info('wecom-conversation-queue', 'queued', {
      conversationType: key.startsWith('group:') ? 'group' : 'single',
      position: submission.position,
      queued: conversationQueue.queued(key),
    });
    reportMetric('wecom_conversation_queued', 1);
  }

  try {
    await submission.completion;
  } catch (err) {
    if (!(err instanceof WeComConversationQueueError)) {
      const message = redactDiagnosticText(err instanceof Error ? err.message : String(err));
      log.fail('wecom-message', err, { step: 'queued-execution' });
      reportMetric('wecom_message_failures', 1, { kind: failureKind(err) });
      console.error(`Message handling failed: ${message}`);
      await stream.finish(
        truncateUtf8(renderWeComNotice('⚠️ 处理失败', [message]), streamMaxBytes),
      ).catch(() => {});
      return;
    }
    reportMetric('wecom_conversation_queue_rejected', 1, { reason: err.reason });
    await stream.finish(
      truncateUtf8(
        renderWeComNotice('⚠️ 排队任务未执行', [conversationQueueNotice(err.reason)]),
        streamMaxBytes,
      ),
    ).catch(() => {});
  }
}

async function executeConversationMessage(
  frame: WsFrame,
  key: string,
  text: string,
  mediaInputs: readonly WeComMediaInput[],
  stream: WeComStreamReply,
  useRiskFastPath: boolean,
  riskAccessDenied: boolean,
): Promise<void> {
  const submittedAt = Date.now();
  try {
    await withReservation(startingRuns, key, async () =>
      runGate.run(async () => {
        const queueWaitMs = Date.now() - submittedAt;
        reportMetric('wecom_queue_wait_ms', queueWaitMs);
        log.info('wecom-run', 'admitted', { queueWaitMs });
        await refreshHealth();
        const body = frame.body as BaseMessage | undefined;
        if (!body) return;
        if (riskAccessDenied) {
          reportMetric('wecom_risk_access_denied', 1);
          await stream.finish('未授权用户，无法使用风险限额查询。');
          return;
        }
        if (useRiskFastPath && riskRouter && riskClient) {
          const pendingIntent = riskIntents.get(key);
          if (pendingIntent?.stage === 'freeform') {
            riskIntents.delete(key);
            if (pendingIntent.field === 'market' && pendingIntent.product) {
              const market = /一级/.test(text)
                ? 'primary'
                : /二级/.test(text)
                  ? 'secondary'
                  : undefined;
              if (!market) {
                riskIntents.set(key, pendingIntent);
                await stream.finish('请输入“一级”或“二级”。');
                return;
              }
              const normalized: RiskIntentState = {
                stage: 'confirm',
                originalText: pendingIntent.originalText,
                draft: { ...pendingIntent.draft, market },
                product: pendingIntent.product,
                ...(pendingIntent.security ? { security: pendingIntent.security } : {}),
              };
              riskIntents.set(key, normalized);
              await finishRiskIntentState(body, key, stream, normalized);
              return;
            }
            const revised = await analyzeRiskDraft(
              pendingIntent.originalText,
              pendingIntent.draft,
              text,
            );
            const normalized = await normalizeRiskDraft(
              pendingIntent.originalText,
              revised,
              riskClient,
            );
            riskIntents.set(key, normalized);
            await finishRiskIntentState(body, key, stream, normalized);
            return;
          }
          if (!pendingIntent && isPretradeIntentCandidate(text)) {
            riskSelectionTasks.clearConversation(key);
            riskIntents.clearTasksForConversation(key);
            await stream.update(
              truncateUtf8(
                renderWeComNotice('🧠 正在理解交易意图', [
                  'AI 正在提取账户关键词、操作、标的关键词和交易规模。',
                ]),
                streamMaxBytes,
              ),
            );
            try {
              const draft = await analyzeRiskDraft(text);
              await stream.update(
                truncateUtf8(
                  renderWeComNotice('🔎 正在核对标准名称', [
                    '正在通过 risk-service 匹配准确账户和证券名称/代码。',
                  ]),
                  streamMaxBytes,
                ),
              );
              const normalized = await normalizeRiskDraft(text, draft, riskClient);
              riskIntents.set(key, normalized);
              await finishRiskIntentState(body, key, stream, normalized);
              return;
            } catch (error) {
              if (error instanceof RiskIntentClarificationError) {
                await stream.finish(
                  renderWeComNotice('需要补充交易信息', [`缺少：${error.missing.join('、')}`]),
                );
                return;
              }
              throw error;
            }
          }
        }
        if (useRiskFastPath && riskRouter) {
          riskSelectionTasks.clearConversation(key);
          riskIntents.clearTasksForConversation(key);
          const startedAt = Date.now();
          const progressRelay = new RiskProgressRelay(
            async (progress) => {
              await stream.update(
                truncateUtf8(
                  renderWeComNotice('⏳ 风险限额查询中', [progress]),
                  streamMaxBytes,
                ),
              );
            },
            (err) => log.fail('wecom-risk-progress', err, { step: 'message' }),
          );
          const result = await riskRouter.handle(key, text, (progress) => {
            progressRelay.push(progress);
          });
          await progressRelay.flush();
          if (result.handled) {
            reportMetric('wecom_risk_fastpath_total', 1, { intent: result.intent });
            reportMetric('wecom_risk_fastpath_ms', Date.now() - startedAt, {
              intent: result.intent,
            });
            log.info('wecom-risk', 'completed', {
              intent: result.intent,
              durationMs: Date.now() - startedAt,
            });
            await stream.finish(truncateUtf8(result.markdown, streamMaxBytes));
            if (result.selection) {
              scheduleRiskSelectionCard(body, key, result.selection);
            }
            return;
          }
        }
        const attachments = await resolveAttachments(mediaInputs);
        const prompt = buildWeComAgentPrompt(
          text,
          attachments,
          promptContextFromWeComMessage(body),
        );
        const displayPrompt = text || attachmentSummary(attachments);
        await runCodexPrompt(frame, key, prompt, displayPrompt, attachments, stream);
      }),
    );
  } catch (err) {
    if (!(err instanceof WeComRunCapacityError)) throw err;
    const capacity = runGate.snapshot();
    log.warn('wecom-run', 'capacity', {
      reason: err.reason,
      active: capacity.active,
      queued: capacity.queued,
    });
    reportMetric('wecom_run_rejected', 1, { reason: err.reason });
    await stream.finish(
      truncateUtf8(
        renderWeComNotice('⚠️ 当前任务较多', [
          '本条消息尚未启动 Codex，请稍后重新发送。',
          capacityNotice(err.reason),
        ]),
        streamMaxBytes,
      ),
    );
  } finally {
    await refreshHealth();
  }
}

async function analyzeRiskDraft(
  originalText: string,
  previous?: RiskAiDraft,
  correction?: string,
): Promise<RiskAiDraft> {
  const run = codex.run({
    runId: randomUUID(),
    prompt: buildRiskIntentPrompt(originalText, previous, correction),
    cwd: workspace,
    model,
    sandbox: 'read-only',
  });
  let output = '';
  try {
    for await (const event of run.events) {
      if (event.type === 'text' && event.delta) output += event.delta;
      if (event.type === 'final_text' && event.content) output = event.content;
      if (event.type === 'error') throw new Error(event.message);
    }
    await run.waitForExit(1500).catch(() => false);
    return parseRiskIntentOutput(
      output,
      correction ? `${originalText} ${correction}` : originalText,
    );
  } catch (error) {
    await run.stop().catch(() => {});
    throw error;
  }
}

async function finishRiskIntentState(
  body: ConversationBody,
  key: string,
  stream: WeComStreamReply,
  state: RiskIntentState,
): Promise<void> {
  if (state.stage === 'freeform') {
    await stream.finish('请直接输入需要修改或补充的内容。');
    return;
  }
  const selection = buildIntentSelection(state, Date.now() + 5 * 60_000);
  const title =
    state.stage === 'account'
      ? '请选择准确账户'
      : state.stage === 'security'
        ? '请选择准确证券'
        : '请确认交易意图';
  await stream.finish(
    truncateUtf8(
      renderWeComNotice(title, [
        selection.subTitle,
        state.stage === 'confirm'
          ? '确认完成前不会执行投资限额测算。'
          : '候选来自 risk-service。',
      ]),
      streamMaxBytes,
    ),
  );
  scheduleRiskSelectionCard(body, key, selection, state);
}

async function handleRiskIntentChoice(
  frame: TemplateCardEventFrame,
  body: ConversationBody,
  key: string,
  taskId: string,
  state: RiskIntentState,
  value: string,
  label: string,
): Promise<void> {
  if (!riskClient) return;
  let next: RiskIntentState;
  if (state.stage === 'account') {
    next =
      value === '__other_account__'
        ? {
            stage: 'freeform',
            originalText: state.originalText,
            draft: state.draft,
            field: 'account',
          }
        : await normalizeSecurity(state.originalText, state.draft, value, riskClient);
  } else if (state.stage === 'security') {
    next =
      value === '__other_security__'
        ? {
            stage: 'freeform',
            originalText: state.originalText,
            draft: state.draft,
            field: 'security',
            product: state.product,
          }
        : {
            stage: 'confirm',
            originalText: state.originalText,
            draft: state.draft,
            product: state.product,
            security: JSON.parse(value) as { name: string; code: string; label: string },
          };
  } else if (state.stage === 'confirm') {
    if (value === '__confirm__') {
      riskIntents.delete(key);
      await client.updateTemplateCard(
        frame,
        buildRiskSelectionStatusCard(taskId, '已确认', '正在执行投资限额测算', label),
      );
      await executeRiskCardSelection(body, key, canonicalCommand(state));
      return;
    }
    const field =
      value === '__edit_account__'
        ? 'account'
        : value === '__edit_security__'
          ? 'security'
          : value === '__edit_amount__'
            ? 'amount'
            : value === '__edit_market__'
              ? 'market'
              : 'other';
    next = {
      stage: 'freeform',
      originalText: state.originalText,
      draft: state.draft,
      field,
      product: state.product,
      security: state.security,
    };
  } else {
    return;
  }
  riskIntents.set(key, next);
  await client.updateTemplateCard(
    frame,
    buildRiskSelectionStatusCard(taskId, '请补充信息', '请直接输入修正内容', label),
  );
  const message =
    next.stage !== 'freeform'
      ? '正在继续确认。'
      : next.field === 'account'
        ? '请输入正确的账户名称或关键词。'
        : next.field === 'security'
          ? '请输入正确的证券名称或代码。'
          : next.field === 'amount'
            ? '请输入正确的金额或数量（含单位）。'
            : next.field === 'market'
              ? '请输入“一级”或“二级”。'
              : '请直接输入你要修改或补充的内容。';
  await sendRiskMarkdown(body, message);
  if (next.stage !== 'freeform') {
    const fakeStream = {
      finish: async (content: string) => {
        await sendRiskMarkdown(body, content);
      },
      update: async () => {},
    } as unknown as WeComStreamReply;
    await finishRiskIntentState(body, key, fakeStream, next);
  }
}

async function runCodexPrompt(
  frame: WsFrame,
  key: string,
  prompt: string,
  displayPrompt: string,
  attachments: readonly NormalizedAttachment[],
  stream: WeComStreamReply,
): Promise<void> {
  const requestStartedAt = Date.now();
  const streamUpdates = new WeComStreamUpdatePump(stream);
  const taskId = createTaskId();
  let threadId = sessionStore.threadId(key);
  let state = freshRunState();
  let lastSent = renderStream(state, threadId);
  let lastFlushAt = Date.now();
  let firstOutputReported = false;

  await stream.update(lastSent);
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
    log.fail('wecom-run', err, { step: 'start', kind: failureKind(err) });
    reportMetric('wecom_run_failures', 1, { kind: failureKind(err), step: 'start' });
    reportMetric('wecom_run_e2e_ms', Date.now() - requestStartedAt, { terminal: 'failed-start' });
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
        if (event.type === 'usage') {
          if (event.inputTokens !== undefined) reportMetric('tokens_in', event.inputTokens);
          if (event.outputTokens !== undefined) reportMetric('tokens_out', event.outputTokens);
          if (event.cachedInputTokens !== undefined) {
            reportMetric('tokens_cached_in', event.cachedInputTokens);
          }
          log.info('agent', 'usage', {
            ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
            ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
            ...(event.cachedInputTokens !== undefined
              ? { cachedInputTokens: event.cachedInputTokens }
              : {}),
          });
          continue;
        }
        if (
          !firstOutputReported &&
          ((event.type === 'text' && Boolean(event.delta)) ||
            (event.type === 'final_text' && Boolean(event.content)))
        ) {
          firstOutputReported = true;
          const ttftMs = Date.now() - requestStartedAt;
          log.info('wecom-run', 'first-output', { ttftMs });
          reportMetric('wecom_run_ttft_ms', ttftMs);
        }

        state = reduce(state, event);
        active.state = state;
        active.threadId = threadId;

        const rendered = renderStream(state, threadId);
        const now = Date.now();
        const terminal = state.terminal !== 'running';
        if (rendered !== lastSent && (terminal || now - lastFlushAt >= streamFlushIntervalMs)) {
          lastSent = rendered;
          lastFlushAt = now;
          streamUpdates.update(rendered);
        }
      }

      state = finalizeIfRunning(state);
      active.state = state;
      active.threadId = threadId;
      await persistThread(key, threadId);

      const finalText = renderStream(state, threadId);
      await streamUpdates.finish(finalText);
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
      await streamUpdates.finish(renderStream(state, threadId)).catch(() => {});
      log.fail('wecom-run', err, { step: 'run', kind: failureKind(err) });
      reportMetric('wecom_run_failures', 1, { kind: failureKind(err), step: 'run' });
      console.error(`Codex run failed: ${message}`);
    }
  });
  const streamStats = streamUpdates.snapshot();
  reportMetric('wecom_stream_updates_sent', streamStats.sent);
  reportMetric('wecom_stream_updates_coalesced', streamStats.coalesced);
  reportMetric('wecom_stream_update_failures', streamStats.failures);
  reportMetric('wecom_run_e2e_ms', Date.now() - requestStartedAt, { terminal: state.terminal });
  log.info('wecom-run', 'completed', {
    terminal: state.terminal,
    durationMs: Date.now() - requestStartedAt,
    ...streamStats,
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
  const { eventKey: rawAction, taskId, selectedId } = templateCardEventDetails(body.event);
  if (!taskId) {
    throw new Error('WeCom template card event missing task_id');
  }
  if (taskId.startsWith('risk_')) {
    await handleRiskSelectionCardEvent(frame, key, taskId, rawAction, selectedId);
    return;
  }
  const action = normalizeCardAction(rawAction);

  const active = activeRuns.get(key);
  const starting = startingRuns.has(key) || conversationQueue.has(key);

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
    riskRouter?.clear(key);
    riskSelectionTasks.clearConversation(key);
    riskIntents.clearConversation(key);
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

async function handleRiskSelectionCardEvent(
  frame: TemplateCardEventFrame,
  key: string,
  taskId: string,
  eventKey: string | undefined,
  selectedId: string | undefined,
): Promise<void> {
  const body = frame.body;
  if (!body) return;
  if (!riskRouter || !isRiskUserAllowed(body.from?.userid)) {
    await client.updateTemplateCard(
      frame,
      buildRiskSelectionStatusCard(
        taskId,
        '无法使用此选择',
        riskRouter ? '当前用户没有风险查询权限' : '风险查询暂不可用',
      ),
    );
    return;
  }

  const selectedKey = selectedId || (eventKey === 'submit' ? '' : eventKey ?? '');
  const resolution = riskSelectionTasks.resolve(taskId, key, selectedKey);
  if (resolution.status === 'invalid') {
    await client.updateTemplateCard(
      frame,
      buildRiskSelectionCard(
        {
          ...resolution.selection,
          replyHint: '请先选择一个候选项，再点击确认',
        },
        taskId,
      ),
    );
    return;
  }
  if (resolution.status !== 'selected') {
    if (resolution.status === 'missing' || resolution.status === 'expired') {
      riskIntents.deleteTask(taskId);
    }
    await client.updateTemplateCard(
      frame,
      buildRiskSelectionStatusCard(
        taskId,
        '选择已失效',
        resolution.status === 'mismatch'
          ? '该选项不属于当前会话'
          : '该选项已处理或超过五分钟，请重新发送查询',
      ),
    );
    return;
  }

  const intentState = riskIntents.getTask(taskId);
  if (intentState) {
    riskIntents.deleteTask(taskId);
    await handleRiskIntentChoice(
      frame,
      body,
      key,
      taskId,
      intentState,
      resolution.option.value ?? resolution.option.key,
      resolution.option.label,
    );
    return;
  }

  await Promise.all([
    sendRiskMarkdown(
      body,
      renderWeComAcknowledgement('selection', resolution.option.label),
    ).catch((err: unknown) => {
      log.fail('wecom-ack', err, { step: 'selection-message' });
    }),
    client
      .updateTemplateCard(
        frame,
        buildRiskSelectionStatusCard(
          taskId,
          '已收到选择',
          '正在继续风险查询',
          resolution.option.label,
        ),
      )
      .catch((err: unknown) => {
        log.fail('wecom-risk-card', err, { step: 'selection-status' });
      }),
  ]);

  let submission: WeComConversationSubmission;
  try {
    submission = conversationQueue.submit(key, async () => {
      await executeRiskCardSelection(body, key, resolution.option.value ?? resolution.option.key);
    });
  } catch (err) {
    if (!(err instanceof WeComConversationQueueError)) throw err;
    await sendRiskMarkdown(
      body,
      renderWeComNotice('⚠️ 当前会话排队较多', [conversationQueueNotice(err.reason)]),
    );
    return;
  }

  if (submission.queued) {
    await sendRiskMarkdown(
      body,
      renderWeComNotice('🕒 已加入会话队列', [
        `当前排队位置：${submission.position}`,
        '前一项完成后会自动处理本次选择。',
      ]),
    );
  }
  void submission.completion.catch(async (err: unknown) => {
    const message = redactDiagnosticText(err instanceof Error ? err.message : String(err));
    log.fail('wecom-risk-card', err, { step: 'selection' });
    await sendRiskMarkdown(body, renderWeComNotice('⚠️ 风险查询失败', [message])).catch(
      () => {},
    );
  });
}

async function executeRiskCardSelection(
  body: ConversationBody,
  key: string,
  selectedKey: string,
): Promise<void> {
  if (!riskRouter) return;
  try {
    await withReservation(startingRuns, key, async () =>
      runGate.run(async () => {
        await refreshHealth();
        const progressRelay = new RiskProgressRelay(
          (progress) =>
            sendRiskMarkdown(
              body,
              renderWeComNotice('⏳ 风险限额查询中', [progress]),
            ),
          (err) => log.fail('wecom-risk-progress', err, { step: 'card-selection' }),
        );
        const result = await riskRouter.handle(key, selectedKey, (progress) => {
          if (progress.startsWith('已确认：')) return;
          progressRelay.push(progress);
        });
        await progressRelay.flush();
        if (result.handled) await sendRiskRouteResult(body, key, result);
      }),
    );
  } catch (err) {
    if (!(err instanceof WeComRunCapacityError)) throw err;
    await sendRiskMarkdown(
      body,
      renderWeComNotice('⚠️ 当前任务较多', [capacityNotice(err.reason)]),
    );
  } finally {
    await refreshHealth();
  }
}

async function sendRiskRouteResult(
  body: ConversationBody,
  key: string,
  result: Extract<RiskRouteResult, { handled: true }>,
): Promise<void> {
  await sendRiskMarkdown(body, result.markdown);
  if (result.selection) scheduleRiskSelectionCard(body, key, result.selection);
}

async function sendRiskMarkdown(body: ConversationBody, content: string): Promise<void> {
  await client.sendMessage(messageTarget(body), {
    msgtype: 'markdown',
    markdown: { content: truncateUtf8(content, streamMaxBytes) },
  });
}

function scheduleRiskSelectionCard(
  body: ConversationBody,
  key: string,
  selection: RiskSelectionRequest,
  intentState?: RiskIntentState,
): void {
  const taskId = createRiskTaskId();
  riskSelectionTasks.register(taskId, key, selection);
  riskIntents.clearTasksForConversation(key);
  if (intentState) {
    riskIntents.registerTask(taskId, key, intentState, selection.expiresAt);
  }
  void (async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, riskSelectionCardDelayMs));
    if (!riskSelectionTasks.has(taskId, key)) return;
    try {
      await sendControlCard(client, body, buildRiskSelectionCard(selection, taskId));
    } catch (err) {
      riskSelectionTasks.remove(taskId);
      riskIntents.deleteTask(taskId);
      log.fail('wecom-risk-card', err, { step: 'send' });
    }
  })();
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
      `排队：\`${conversationQueue.queued(key)}\``,
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
  const startedAt = Date.now();
  let attachments: NormalizedAttachment[];
  try {
    attachments = await mediaStore.resolve(inputs, attachmentOptions);
  } catch (err) {
    log.fail('wecom-media-resolve', err, {
      durationMs: Date.now() - startedAt,
      kind: failureKind(err),
    });
    reportMetric('wecom_media_resolve_failures', 1, { kind: failureKind(err) });
    reportMetric('wecom_media_resolve_ms', Date.now() - startedAt, { result: 'failed' });
    throw err;
  }
  const acceptedCount = attachments.filter(
    (attachment) => attachment.decision === 'accepted',
  ).length;
  log.info('wecom-media', 'resolved', {
    durationMs: Date.now() - startedAt,
    accepted: acceptedCount,
    rejected: attachments.length - acceptedCount,
  });
  reportMetric('wecom_media_resolve_ms', Date.now() - startedAt, { result: 'ok' });
  reportMetric('wecom_media_accepted', acceptedCount);
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
    const bytes = result.sent.reduce((sum, item) => sum + item.size, 0);
    log.info('wecom-media', 'egress', {
      sent: result.sent.length,
      skipped: result.skipped.map((item) => item.reason),
      bytes,
    });
    reportMetric('wecom_egress_bytes', bytes);
    reportMetric('wecom_egress_files', result.sent.length);
  } catch (err) {
    log.fail('wecom-media-egress', err);
    reportMetric('wecom_egress_failures', 1, { kind: failureKind(err) });
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

function createRiskTaskId(): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  return `risk_${Date.now()}_${suffix}`;
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

function isRiskUserAllowed(userid: string | undefined): boolean {
  return riskAllowedUserIds.size === 0 || (Boolean(userid) && riskAllowedUserIds.has(userid ?? ''));
}

function capacityNotice(reason: WeComRunCapacityError['reason']): string {
  if (reason === 'queue-full') return '任务队列已满';
  if (reason === 'queue-timeout') return '排队等待超时';
  return '服务正在停止';
}

function conversationQueueNotice(reason: WeComConversationQueueError['reason']): string {
  if (reason === 'queue-full') return '当前会话队列已满';
  if (reason === 'queue-timeout') return '等待时间过长，消息已从队列移除，请重新发送';
  return '服务正在停止';
}

function failureKind(err: unknown): string {
  const item =
    err && typeof err === 'object'
      ? (err as { name?: unknown; code?: unknown; response?: { status?: unknown } })
      : {};
  if (item.name === 'WeComMediaTimeoutError') return 'timeout';
  const status = item.response?.status;
  if (typeof status === 'number') {
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'http-5xx';
    if (status >= 400) return 'http-4xx';
  }
  const code = typeof item.code === 'string' ? item.code.toUpperCase() : '';
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return 'timeout';
  if (code.startsWith('ECONN') || code.startsWith('ENET') || code === 'EHOSTUNREACH') {
    return 'network';
  }
  return 'other';
}

function isConversationBusy(key: string): boolean {
  return conversationQueue.has(key) || startingRuns.has(key) || activeRuns.has(key);
}

async function refreshHealth(): Promise<void> {
  await healthStore.update({
    phase: healthPhase,
    connected,
    activeRuns: activeRuns.size,
    startingRuns: startingRuns.size,
    ...(reconnectAttempt !== undefined ? { reconnectAttempt } : {}),
    ...(lastHealthError ? { lastError: lastHealthError } : {}),
    riskFastPath: {
      enabled: riskDirectEnabled,
      serviceDirConfigured: Boolean(configuredRiskServiceDir),
      pythonConfigured: Boolean(riskPython),
      ...(!riskDirectEnabled
        ? { reason: !riskPython ? 'python-not-configured' : 'path-unavailable' }
        : {}),
    },
  }).catch((err: unknown) => {
    log.fail('wecom-health', err);
  });
}

let maintenanceRunning = false;

async function runMaintenance(): Promise<void> {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const logsRemoved = await gcOldLogs();
    const mediaRemoved = await gcWeComMediaCache(mediaDir, mediaCacheMaxAgeMs);
    const sessionsRemoved = await sessionStore.prune();
    reportMetric('wecom_maintenance_removed', logsRemoved, { kind: 'logs' });
    reportMetric('wecom_maintenance_removed', mediaRemoved, { kind: 'media' });
    reportMetric('wecom_maintenance_removed', sessionsRemoved, { kind: 'sessions' });
    log.info('wecom-maintenance', 'completed', {
      logsRemoved,
      mediaRemoved,
      sessionsRemoved,
    });
  } catch (err) {
    log.fail('wecom-maintenance', err);
    reportMetric('wecom_maintenance_failures', 1, { kind: failureKind(err) });
  } finally {
    maintenanceRunning = false;
  }
}

let shuttingDown = false;

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  conversationQueue.close();
  runGate.close();
  clearInterval(heartbeat);
  clearInterval(maintenance);
  connected = false;
  healthPhase = 'stopping';
  const cleanup = (async () => {
    await refreshHealth();
    try {
      client.disconnect();
    } catch (err) {
      console.error(
        `Failed to disconnect WeCom during ${signal}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const runs = [...activeRuns.values()];
    await Promise.allSettled(runs.map((active) => active.run.stop()));
    await riskClient?.close().catch((err: unknown) => {
      console.error(
        `Failed to stop local risk-service process: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await sessionStore.flush().catch((err: unknown) => {
      console.error(
        `Failed to flush WeCom sessions during ${signal}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await healthStore.flush().catch(() => {});
    await closeLogger();
  })();
  const completed = await waitForCompletion(cleanup, shutdownTimeoutMs);
  if (!completed) {
    console.error(`WeCom shutdown exceeded ${shutdownTimeoutMs}ms; forcing process exit.`);
  }
  process.exit(0);
}
