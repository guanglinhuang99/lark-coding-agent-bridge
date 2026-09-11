import { mkdir, realpath } from 'node:fs/promises';
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
import { ActiveRuns } from '../bridge/active-runs';
import { RunExecutor } from '../bridge/run-executor';
import { startWeComAgentRun } from './agent-runtime';
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
import { WeComConversationBindings } from './conversation-bindings';
import { loadWorkspaceConfig } from './workspace-config';
import { bindingPolicyFingerprint, type SessionBindingIdentity } from '../bridge/identity';
import { acquireStateDirectoryLock } from '../bridge/state-lock';
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
import {
  sendLinkedWorkspaceArtifacts, ReceivedArtifactRegistry, requestedReceivedArtifacts,
  artifactDeliverySummary, type ReceivedArtifact,
} from './egress';
import { resolveWeComModelConfig } from './model-config';
import { isRiskUserAllowedByConfig, readUseAllowedList } from './risk/access';
import { readWeComModelAllowlist } from './model-options';
import { handleEnterChat as handleEnterChatEvent } from './enter-chat-handler';
import { enterChatObservation } from './enter-chat-observability';
import { weComUserErrorMarkdown } from './user-error';
import {
  effectiveModel as effectiveConversationModel,
  effectiveReasoningEffort as effectiveConversationReasoningEffort,
  type ConversationAgentPreferences,
} from './agent-preferences';
import type { NormalizedAttachment } from '../media/attachment';
import { createRiskBusinessRuntime } from '../runtime/risk-business';
import type { RiskIngress, RiskReply } from '../business/risk/application';
import { RiskProgressRelay } from '../business/risk/progress';
import { businessConversationKey, businessConversationScope } from '../business/identity';
import { RiskSelectionTaskRegistry } from './risk/card';
import {
  RiskInteractionController,
} from './risk/interaction';
import {
  buildErrorCardView,
  buildQueueCardView,
  type WeComErrorKind,
} from './ui/builders';
import { buildAgentSettingsSummaryCardView } from './ui/surfaces';
import type { WeComCardView } from './ui/model';
import { buildHomeCardView } from './ui/navigation';
import { renderWeComCard } from './ui/renderer';
import { WeComNavigationCardRegistry } from './ui/navigation-registry';
import {
  cardPurposeFromTaskId,
  isHomeAction,
  type WeComCardPurpose,
} from './card-routing';
import { NavigationController } from './navigation-controller';
import {
  parseWeComCommand,
  WECOM_HELP_LINES,
  WECOM_CREDIT_USAGE_LINES,
} from './commands';
import { WeComTaskStore } from './task-store';
import {
  WeComOperationRunner,
  capacityNotice,
  classifyTask,
  conversationQueueNotice,
  failureKind,
  readPositiveInt,
} from './reliability';
import {
  buildWeComDoctorCardView,
  buildWeComRecentTasksCardView,
  recentTaskHint,
  type WeComDependencyCheck,
} from './ui/doctor';

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
  durableTaskId?: string;
}

const envFile = path.resolve(process.env.WECOM_ENV_FILE?.trim() || '.env');
if (existsSync(envFile)) loadEnvFile(envFile);

const workspace = path.resolve(process.env.WECOM_WORKSPACE || process.cwd());
const workspacesFile = process.env.WECOM_WORKSPACES_FILE?.trim();
const configuredWorkspaces = await loadWorkspaceConfig(workspace, workspacesFile);
const stateDir = path.resolve(
  process.env.WECOM_STATE_DIR || path.join(os.homedir(), '.lark-channel', 'wecom'),
);
const sessionFile = path.join(stateDir, 'sessions.json');
const taskFile = path.join(stateDir, 'tasks.json');
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
const {
  codexModel: model,
  codexReasoningEffort,
} = resolveWeComModelConfig(process.env);
const configuredModelAllowlist = readWeComModelAllowlist(
  process.env.WECOM_CODEX_MODEL_OPTIONS,
);
const conversationAgentPreferences = new Map<string, ConversationAgentPreferences>();
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
const codexPostDoneExitGraceMs = readPositiveInt(
  process.env.WECOM_CODEX_POST_DONE_EXIT_GRACE_MS,
  5_000,
);
const conversationQueueMax = readPositiveInt(process.env.WECOM_CONVERSATION_QUEUE_MAX, 5);
const conversationQueueGlobalMax = readPositiveInt(
  process.env.WECOM_CONVERSATION_QUEUE_GLOBAL_MAX,
  20,
);
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
const taskMaxAgeMs = readPositiveInt(
  process.env.WECOM_TASK_TTL_MS,
  7 * 24 * 60 * 60 * 1000,
);
const taskMaxEntries = readPositiveInt(process.env.WECOM_TASK_MAX_ENTRIES, 2_000);
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
const configuredRiskServiceDir = (process.env.RISK_SERVICE_DIR ?? process.env.WECOM_RISK_SERVICE_DIR)?.trim();
const riskAllowedUserIds = new Set(
  (process.env.WECOM_RISK_ALLOWED_USERIDS ?? '')
    .replaceAll('，', ',')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
const useAllowedList = readUseAllowedList(process.env.USE_ALLOWED_LIST);
const riskAccessLocked = useAllowedList && riskAllowedUserIds.size === 0;
if (riskAccessLocked) {
  console.warn(
    'WeCom risk access is locked: USE_ALLOWED_LIST is enabled but WECOM_RISK_ALLOWED_USERIDS is empty. ' +
      'Configure allowed user IDs or explicitly set USE_ALLOWED_LIST=0.',
  );
}

await mkdir(stateDir, { recursive: true });
const releaseStateLock = await acquireStateDirectoryLock(stateDir);
configureLogger({ logsDir: path.join(stateDir, 'logs'), retentionDays: logRetentionDays });
await gcOldLogs();
await gcWeComMediaCache(mediaDir, mediaCacheMaxAgeMs);
const sessionStore = new WeComConversationBindings(sessionFile, {
  identity: { channel: 'wecom', accountId: botId, instanceId: stateDir },
  workspace,
  policyFingerprint: bindingPolicyFingerprint([
    sandbox, process.env.CODEX_BINARY?.trim() || 'codex', process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'inherit-home', 'user-config', 'user-rules',
  ]),
  maxAgeMs: sessionMaxAgeMs,
  maxEntries: sessionMaxEntries,
});
await sessionStore.load();
const receivedArtifacts = new ReceivedArtifactRegistry();
const taskStore = new WeComTaskStore(taskFile, {
  maxAgeMs: taskMaxAgeMs,
  maxEntries: taskMaxEntries,
});
await taskStore.load();
const operationRunner = new WeComOperationRunner();
const activeRuns = new Map<string, ActiveRunRecord>();
const startingRuns = new Set<string>();
const riskIntentRunsStarting = new Set<string>();
const riskIntentStopRequests = new Set<string>();
const navigationCardTtlMs = 5 * 60_000;
const navigationCards = new WeComNavigationCardRegistry();
const controlCardScopes = new Map<string, { key: string; expiresAt: number }>();
const messageDeduplicator = new WeComMessageDeduplicator(
  messageDedupeTtlMs,
  messageDedupeMaxEntries,
);
const conversationQueue = new WeComConversationQueue(
  conversationQueueMax,
  conversationQueueTimeoutMs,
  { maxQueuedTotal: conversationQueueGlobalMax },
);
const runGate = new WeComRunGate(maxConcurrentRuns, maxQueuedRuns, runQueueTimeoutMs);
const healthStore = new WeComHealthStore(healthFile);
let healthPhase: WeComHealthPhase = 'starting';
let connected = false;
let reconnectAttempt: number | undefined;
let lastHealthError: string | undefined;

const codex = new CodexAdapter({
  binary: process.env.CODEX_BINARY?.trim() || 'codex',
  profileStateDir: stateDir,
  inheritCodexHome: true,
  ignoreUserConfig: false,
  ignoreRules: false,
  sandbox,
});
const agentRuns = new ActiveRuns();
const runExecutor = new RunExecutor({
  agent: codex,
  pool: runGate.pool,
  activeRuns: agentRuns,
  postDoneExitGraceMs: codexPostDoneExitGraceMs,
});
const riskSelectionTasks = new RiskSelectionTaskRegistry();
const riskRuntime = createRiskBusinessRuntime({
  identity: { channel: 'wecom', accountId: botId, instanceId: stateDir },
  stateDir, pool: runGate.pool, activeRuns: agentRuns,
  env: process.env, legacyPrefix: 'WECOM',
  accessEnabled: () => !riskAccessLocked,
  invalidateSelections: key => riskSelectionTasks.clearConversation(key),
  // These callbacks only project shared execution into the WeCom control UI.
  intentLifecycle: {
    starting: ({ key }) => { riskIntentRunsStarting.add(businessConversationScope(key)); },
    started: ({ key, originalText }, run) => {
      const scope = businessConversationScope(key);
      const active: ActiveRunRecord = { run, state: freshRunState(), prompt: originalText, taskId: createRiskTaskId() };
      activeRuns.set(scope, active);
      return () => { if (activeRuns.get(scope) === active) activeRuns.delete(scope); };
    },
    settled: ({ key }) => {
      const scope = businessConversationScope(key);
      riskIntentRunsStarting.delete(scope);
      riskIntentStopRequests.delete(scope);
    },
  },
});
const riskClient = riskRuntime.client;
const riskApplication = riskRuntime.application;
const riskRouter = riskApplication.router;
const riskStates = riskApplication.states;
const riskDirectEnabled = Boolean(riskClient);
const riskPython = riskRuntime.config.pythonPath;
const riskKeyFor = (key: string, userId: string | undefined) => businessConversationKey(
  { channel: 'wecom', accountId: botId, instanceId: stateDir }, key, userId || '__missing_actor__',
);
const riskSelectionCardDelayMs = readPositiveInt(
  process.env.WECOM_RISK_SELECTION_CARD_DELAY_MS,
  200,
);

// The health snapshot reads the risk client and enablement state.
// Initialize both before the first heartbeat (including unbundled execution).
await refreshHealth();

if (!riskDirectEnabled) console.warn(`WeCom risk fast path disabled: ${riskRuntime.snapshot().reason}`);

// Initialization, reconnect warmup and shutdown have the same owner in both channels.
void riskRuntime.start();
try {
  await codex.prepareRun();
} catch (error) {
  await riskRuntime.close().catch(cleanupError => log.fail('risk-runtime', cleanupError));
  throw error;
}

const client = new WSClient({ botId, secret, requestTimeout: requestTimeoutMs });
const mediaStore = new WeComMediaStore(client, mediaDir);
const riskInteraction = new RiskInteractionController({
  application: riskApplication,
  riskClient,
  riskRouter,
  riskStates,
  riskSelectionTasks,
  conversationQueue,
  runGate,
  startingRuns,
  streamMaxBytes,
  selectionCardDelayMs: riskSelectionCardDelayMs,
  refreshHealth: () => refreshHealth(),
  isRiskUserAllowed,
  updateTemplateCard: (frame, card) => client.updateTemplateCard(frame, card),
  sendMarkdownMessage: (body, content) =>
    client.sendMessage(messageTarget(body), {
      msgtype: 'markdown',
      markdown: { content },
    }),
  sendControlCardMessage: (body, card) => sendControlCard(client, body, card),
  createRiskTaskId,
});
const navigation = new NavigationController({
  sessionStore,
  navigationCards,
  configuredWorkspaces,
  navigationCardTtlMs,
  startupModel: model,
  configuredModelAllowlist,
  conversationAgentPreferences,
  createNavigationTaskId,
  effectiveModel,
  effectiveReasoningEffort,
  currentThreadId,
  isConversationBusy,
  recentTaskHint: (key) => recentTaskHint(
    taskStore
      .recent(key, 10)
      .find((task) => task.kind !== 'command' && task.status !== 'queued' && task.status !== 'running'),
  ),
  replyTemplateCard: (frame, card) => client.replyTemplateCard(frame, card),
  updateTemplateCard: (frame, card) => client.updateTemplateCard(frame, card),
  deliverControlCard,
  replyControl,
  replyOnce,
});

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
  void riskRuntime.start();
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
  void handleEnterChat(frame);
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
  void processMessageEvent(frame).catch(async (err: unknown) => {
    const message = redactDiagnosticText(err instanceof Error ? err.message : String(err));
    log.fail('wecom-message', err);
    reportMetric('wecom_message_failures', 1, { kind: failureKind(err) });
    console.error(`Message handling failed: ${message}`);
    await replyOnce(frame, '⚠️ 处理失败', [weComUserErrorMarkdown('execution')]).catch(() => {});
  });
}

async function processMessageEvent<T extends BaseMessage>(frame: WsFrame<T>): Promise<void> {
  const chatKey = frame.body ? conversationKey(frame.body) : undefined;
  // Freeze the workspace at ingress. Every queue entry and late callback keeps
  // this scope even when the chat switches workspace before it runs.
  let capturedScope = chatKey ? sessionStore.captureScope(chatKey) : undefined;
  const messageId = frame.body?.msgid;
  let durableTaskId: string | undefined;
  if (messageId && frame.body) {
    try {
      const claim = await taskStore.claimInbound(messageId, capturedScope!);
      if (!claim.accepted) {
        log.info('wecom-message', 'duplicate-durable', { status: claim.task.status });
        reportMetric('wecom_duplicate_message', 1, { layer: 'durable' });
        return;
      }
      durableTaskId = claim.task.id;
      if (sessionStore.conversationScope(claim.task.conversationKey) !== chatKey) {
        await taskStore.markFailed(durableTaskId, 'conversation-scope-mismatch').catch(() => {});
        await replyOnce(frame, '任务未执行', ['任务的聊天归属不匹配，请重新发送。']).catch(() => {});
        return;
      }
      if (claim.replayed && !isWorkspaceScope(claim.task.conversationKey)) {
        await taskStore.markFailed(durableTaskId, 'legacy-scope-unverified').catch(() => {});
        await replyOnce(frame, '任务未恢复', [
          '这条历史任务缺少可验证的 Workspace 记录，已停止自动恢复。请重新发送原问题。',
        ]).catch(() => {});
        return;
      }
      // A replayed task carries the scope that was captured before the process
      // restart. Do not route it through the workspace selected meanwhile.
      capturedScope = claim.task.conversationKey;
      if (claim.replayed) {
        log.info('wecom-task', 'replayed-after-restart', { taskId: durableTaskId });
        reportMetric('wecom_task_replayed_after_restart', 1);
      }
    } catch (err) {
      log.fail('wecom-task', err, { step: 'claim' });
      reportMetric('wecom_task_store_failures', 1, { step: 'claim' });
      const diagnostic = normalizeIncomingText(textFromWeComMessage(frame.body), frame.body.chattype).toLowerCase();
      if (!['/doctor', '/status', '/menu', '/help'].includes(diagnostic) || collectWeComMediaInputs(frame.body).length) {
        await replyOnce(frame, '任务未执行', ['任务记录暂不可写；没有启动 Agent。请发送 /doctor 检查后重新发送。']).catch(() => {});
        return;
      }
    }
  }

  if (messageId && !messageDeduplicator.claim(messageId)) {
    log.info('wecom-message', 'duplicate-memory');
    reportMetric('wecom_duplicate_message', 1, { layer: 'memory' });
    return;
  }

  try {
    await handleMessage(frame, durableTaskId, capturedScope);
    if (durableTaskId) {
      await taskStore.markDone(durableTaskId).catch((err: unknown) => {
        log.fail('wecom-task', err, { step: 'mark-done' });
        reportMetric('wecom_task_store_failures', 1, { step: 'mark-done' });
      });
    }
  } catch (err) {
    if (durableTaskId) await taskStore.markFailed(durableTaskId, failureKind(err)).catch(() => {});
    throw err;
  }
}

async function handleMessage<T extends BaseMessage>(
  frame: WsFrame<T>,
  durableTaskId?: string,
  capturedScope?: string,
): Promise<void> {
  const body = frame.body;
  if (!body) return;

  let text = normalizeIncomingText(textFromWeComMessage(body), body.chattype);
  const mediaInputs = collectWeComMediaInputs(body);
  if (!text && mediaInputs.length === 0) return;

  const key = capturedScope ?? sessionStore.captureScope(conversationKey(body));
  const scopedWorkspace = sessionStore.workspaceFor(key);
  const parsedCommand = parseWeComCommand(text);
  const explicitRiskCommand = parsedCommand.kind === 'risk-measurement';
  if (durableTaskId) {
    const task = classifyTask(text, {
      hasAttachments: mediaInputs.length > 0,
      risk: parsedCommand.kind === 'risk-measurement' || parsedCommand.kind === 'credit-query',
    });
    await taskStore.annotate(durableTaskId, task).catch((err: unknown) => {
      log.fail('wecom-task', err, { step: 'annotate' });
    });
  }
  if (parsedCommand.kind === 'help') {
    await replyOnce(frame, '使用帮助', WECOM_HELP_LINES);
    return;
  }
  if (parsedCommand.kind === 'credit-query' && !parsedCommand.payload) {
    await replyOnce(frame, '授信用法', WECOM_CREDIT_USAGE_LINES);
    return;
  }
  if (parsedCommand.kind === 'risk-measurement') {
    text = parsedCommand.payload;
  }
  const command = text.toLowerCase();
  if (durableTaskId && command.startsWith('/')) {
    // Built-in commands can reset sessions or interrupt a process. They must not
    // remain replay-safe queued records once command dispatch begins.
    await taskStore.markRunning(durableTaskId);
  }

  if (command === '/menu') {
    await navigation.replyHomeCard(frame, key);
    return;
  }

  if (command === '/doctor') {
    await replyDoctor(frame, key);
    return;
  }

  if (command === '/runs') {
    await replyRuns(frame, key);
    return;
  }

  const workspaceCommand = /^\/workspace(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (workspaceCommand) {
    const selectedId = workspaceCommand[1]?.trim();
    if (selectedId) {
      await navigation.applyWorkspaceSelection(frame, key, selectedId);
    } else {
      await navigation.replyWorkspaceSelection(frame, key);
    }
    return;
  }

  if (command === '/model') {
    await navigation.replyModelSelection(frame, key);
    return;
  }

  if (command === '/reasoning') {
    await navigation.replyReasoningSelection(frame, key);
    return;
  }

  if (command === '/resume') {
    await navigation.replySessionSelection(frame, key);
    return;
  }

  if (command === '/settings') {
    await replySettingsSummary(frame, key);
    return;
  }

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
    riskSelectionTasks.clearConversation(key);
    riskApplication.cancelScope(key);
    navigationCards.clearConversation(key);
    await sessionStore.clear(key);
    await replyControl(
      frame,
      key,
      '✅ 已创建新会话',
      ['下一条消息会创建新的会话。'],
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
    const riskCancellation = requestRiskIntentStop(key);
    const active = activeRuns.get(key);
    // Stopping must not wait for cancellation-receipt delivery or ledger writes.
    if (active) {
      active.state = markInterrupted(active.state);
      await active.run.stop();
      if (active.durableTaskId) {
        await taskStore.markInterrupted(active.durableTaskId).catch(() => {});
      }
    }
    if (riskCancellation.handled) {
      await riskInteraction.renderReply(body, riskKeyFor(key, body.from?.userid),
        new WeComStreamReply(client, frame, generateReqId('risk-stop')), riskCancellation)
        .catch((error: unknown) => log.fail('risk-stop-reply', error));
    }
    if (!active) {
      if (riskCancellation.handled) return;
      const starting = startingRuns.has(key) || conversationQueue.has(key);
      const riskIntentStopping = riskIntentStopRequests.has(key);
      await replyControl(
        frame,
        key,
        starting ? '⏳ Codex 正在启动' : 'ℹ️ 当前没有运行任务',
        [
          starting
            ? riskIntentStopping
              ? '停止请求已记录，风险意图任务启动后将立即终止。'
              : '任务完成启动后可再次停止。'
            : '可以直接发送新问题。',
        ],
        starting ? 'running' : 'idle',
        starting
          ? riskIntentStopping
            ? '风险任务正在启动，停止请求已记录'
            : '任务正在启动'
          : '当前为空闲状态',
      );
      return;
    }

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

  const riskIngress = riskApplication.capture({
    key: riskKeyFor(key, body.from?.userid), text, explicitMeasurement: explicitRiskCommand,
    authorized: isRiskUserAllowed(body.from?.userid), hasAttachments: mediaInputs.length > 0,
  });
  try {
  const riskCandidate = riskIngress.accepted;
  const riskAccessDenied = riskCandidate && !isRiskUserAllowed(body.from?.userid);
  const useRiskFastPath = riskCandidate && !riskAccessDenied;
  if (durableTaskId && useRiskFastPath) {
    await taskStore.annotate(durableTaskId, { kind: 'risk', label: '风险测算 / 查询' }).catch(() => {});
  }
  const acknowledgement = text
    ? renderWeComAcknowledgement('input', text)
    : explicitRiskCommand
      ? renderWeComAcknowledgement('input', '测算')
    : `收到，您发送的 ${mediaInputs.length} 个附件已收到。`;
  await new WeComStreamReply(client, frame, generateReqId('ack'))
    .finish(truncateUtf8(acknowledgement, streamMaxBytes))
    .catch((err: unknown) => {
      log.fail('wecom-ack', err, { step: 'input' });
    });
  const stream = new WeComStreamReply(client, frame, generateReqId('stream'));
  const controlTaskId = createTaskId();
  registerControlCard(controlTaskId, key);
  let controlCardAttached = false;
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
        explicitRiskCommand,
        controlTaskId,
        controlCardAttached,
        durableTaskId,
        riskIngress,
      );
    });
  } catch (err) {
    if (!(err instanceof WeComConversationQueueError)) throw err;
    if (durableTaskId) await taskStore.markFailed(durableTaskId, err.reason).catch(() => {});
    reportMetric('wecom_conversation_queue_rejected', 1, { reason: err.reason });
    await replyOnce(frame, '⚠️ 当前会话排队较多', [
      '本条消息没有入队，请稍后重新发送。',
      conversationQueueNotice(err.reason),
    ]);
    await deliverErrorCard(frame, err.reason === 'queue-timeout' ? 'queue-timeout' : 'queue-full');
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
    const initialContent = truncateUtf8(
      !submission.queued && !useRiskFastPath && !riskAccessDenied
        ? renderStream(freshRunState(), currentThreadId(key), scopedWorkspace)
        : initialNotice,
      streamMaxBytes,
    );
    if (!submission.queued && !useRiskFastPath && !riskAccessDenied) {
      controlCardAttached = await stream.startWithCard(
        initialContent,
        buildWeComControlCard({
          taskId: controlTaskId,
          status: 'running',
          workspace: scopedWorkspace,
          sandbox,
          threadId: currentThreadId(key),
          prompt: text || `处理 ${mediaInputs.length} 个附件`,
          runState: freshRunState(),
        }),
      );
    } else if (!submission.queued && (useRiskFastPath || riskAccessDenied)) {
      await stream.start(initialContent);
    } else {
      await stream.start(initialContent);
    }
    markStreamReady();
  } catch (err) {
    if (!submission.cancel(err)) markStreamFailed(err);
    await submission.completion.catch(() => {});
    throw err;
  }

  if (submission.queued) {
    await deliverCardView(
      frame,
      buildQueueCardView({
        taskId: createQueueTaskId(),
        status: 'queued',
        workspace: scopedWorkspace,
        position: submission.position,
        ahead: submission.position - 1,
      }),
    );
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
        truncateUtf8(
          renderWeComNotice('⚠️ 处理失败', [weComUserErrorMarkdown('execution')]),
          streamMaxBytes,
        ),
      ).catch(() => {});
      await deliverErrorCard(frame, 'execution');
      if (durableTaskId) await taskStore.markFailed(durableTaskId, failureKind(err)).catch(() => {});
      return;
    }
    if (durableTaskId) await taskStore.markFailed(durableTaskId, err.reason).catch(() => {});
    reportMetric('wecom_conversation_queue_rejected', 1, { reason: err.reason });
    await stream.finish(
      truncateUtf8(
        renderWeComNotice('⚠️ 排队任务未执行', [conversationQueueNotice(err.reason)]),
        streamMaxBytes,
      ),
    ).catch(() => {});
    await deliverErrorCard(frame, err.reason === 'queue-timeout' ? 'queue-timeout' : 'queue-full');
  }
  } finally {
    riskIngress.release();
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
  explicitRiskCommand: boolean,
  controlTaskId: string,
  controlCardAttached: boolean,
  durableTaskId?: string,
  riskIngress?: RiskIngress,
): Promise<void> {
  const submittedAt = Date.now();
  try {
    await withReservation(startingRuns, key, async () =>
      runGate.run(async () => {
        if (durableTaskId) await taskStore.markRunning(durableTaskId);
        const queueWaitMs = Date.now() - submittedAt;
        reportMetric('wecom_queue_wait_ms', queueWaitMs);
        log.info('wecom-run', 'admitted', { queueWaitMs });
        await refreshHealth();
        const body = frame.body as BaseMessage | undefined;
        if (!body) return;
        if (riskAccessDenied) {
          reportMetric('wecom_risk_access_denied', 1);
          await stream.finish(
            renderWeComNotice('无法使用风险查询', ['当前用户没有风险限额查询权限。'], {
              status: 'error',
              eyebrow: 'RISK · WECOM',
            }),
          );
          return;
        }
        const progress = new RiskProgressRelay(async (message) => {
          await stream.update(truncateUtf8(renderWeComNotice('风险查询处理中', [message]), streamMaxBytes));
        }, (error) => log.fail('wecom-risk-progress', error), { includeStageCount: true, coalesce: true });
        const businessKey = riskKeyFor(key, body.from?.userid);
        const reply = await riskApplication.handle({
          key: businessKey, text, explicitMeasurement: explicitRiskCommand,
          authorized: isRiskUserAllowed(body.from?.userid),
          hasAttachments: mediaInputs.length > 0,
          maxMessageBytes: streamMaxBytes,
          onProgress: (message) => progress.push(message),
        }, riskIngress);
        await progress.finish();
        if (reply.handled) {
          await riskInteraction.renderReply(body, businessKey, stream, reply);
          return;
        }
        const attachments = await resolveAttachments(mediaInputs);
        const prompt = buildWeComAgentPrompt(
          text,
          attachments,
          promptContextFromWeComMessage(body),
        );
        const displayPrompt = text || attachmentSummary(attachments);
        await runCodexPrompt(
          frame,
          key,
          prompt,
          displayPrompt,
          attachments,
          stream,
          controlTaskId,
          controlCardAttached,
          durableTaskId,
        );
      }),
    );
  } catch (err) {
    if (err instanceof RiskIntentInterruptedError) {
      await finishRiskIntentStopped(stream);
      return;
    }
    if (!(err instanceof WeComRunCapacityError)) throw err;
    const capacity = runGate.snapshot();
    log.warn('wecom-run', 'capacity', {
      reason: err.reason,
      active: capacity.active,
      queued: capacity.queued,
    });
    reportMetric('wecom_run_rejected', 1, { reason: err.reason });
    if (durableTaskId) await taskStore.markFailed(durableTaskId, err.reason).catch(() => {});
    await stream.finish(
      truncateUtf8(
        renderWeComNotice('⚠️ 当前任务较多', [
          '本条消息尚未启动 Codex，请稍后重新发送。',
          capacityNotice(err.reason),
        ]),
        streamMaxBytes,
      ),
    );
    await deliverErrorCard(frame, err.reason === 'queue-timeout' ? 'queue-timeout' : 'queue-full');
  } finally {
    await refreshHealth();
  }
}


function isWorkspaceScope(value: string): boolean {
  return /^(?:group|single):workspace-v1:/u.test(value);
}

function requestRiskIntentStop(key: string): RiskReply {
  const cancellation = riskApplication.cancelScope(key);
  if (riskIntentRunsStarting.has(key)) riskIntentStopRequests.add(key);
  return cancellation;
}

class RiskIntentInterruptedError extends Error {
  constructor() {
    super('risk intent run interrupted');
    this.name = 'RiskIntentInterruptedError';
  }
}

async function finishRiskIntentStopped(stream: WeComStreamReply): Promise<void> {
  await stream.finish(
    renderWeComNotice('风险查询已停止', ['未执行投资限额测算。'], {
      status: 'warning',
      eyebrow: 'RISK · WECOM',
    }),
  ).catch(() => {});
}

async function runCodexPrompt(
  frame: WsFrame,
  key: string,
  prompt: string,
  displayPrompt: string,
  attachments: readonly NormalizedAttachment[],
  stream: WeComStreamReply,
  taskId: string,
  controlCardAttached: boolean,
  durableTaskId?: string,
): Promise<void> {
  const workspace = sessionStore.workspaceFor(key);
  const requestStartedAt = Date.now();
  const streamUpdates = new WeComStreamUpdatePump(stream);
  await sessionStore.flush();
  const sessionBinding = sessionStore.bindingFor(key);
  let threadId = sessionStore.threadId(key);
  const artifactScope = (id: string | undefined) => JSON.stringify([sessionBinding, id]);
  const received = [
    ...receivedArtifacts.get(artifactScope(threadId)),
    ...await Promise.all(attachments.filter((item) => item.decision === 'accepted').map(async (item) => ({
      path: await realpath(item.absPath).catch(() => item.absPath),
      hash: item.hash, name: path.basename(item.originalName ?? item.absPath),
    }))),
  ];
  const requestedAttachments = requestedReceivedArtifacts(displayPrompt, received);
  let state = freshRunState();
  let lastSent = renderStream(state, threadId, workspace);
  let lastFlushAt = Date.now();
  let firstOutputReported = false;

  await stream.update(lastSent);
  if (!controlCardAttached) {
    await deliverControlCard(
      frame,
      buildWeComControlCard({
        taskId,
        status: 'running',
        workspace,
        sandbox,
        threadId,
        prompt: displayPrompt,
        runState: state,
      }),
    );
  }

  let run: AgentRun;
  try {
    run = await startWeComAgentRun(runExecutor, {
      runId: randomUUID(),
      prompt,
      cwd: sessionBinding.cwdRealpath,
      threadId,
      model: effectiveModel(key),
      reasoningEffort: effectiveReasoningEffort(key),
      sandbox,
      images: attachments
        .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
        .map((attachment) => attachment.absPath),
    }, key, runGate.currentPermit());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = reduce(state, {
      type: 'error',
      message: weComUserErrorMarkdown('agent-startup'),
      terminationReason: 'failed',
    });
    await stream.finish(renderStream(state, threadId, workspace)).catch(() => {});
    await deliverErrorCard(frame, 'agent-startup');
    log.fail('wecom-run', err, { step: 'start', kind: failureKind(err) });
    reportMetric('wecom_run_failures', 1, { kind: failureKind(err), step: 'start' });
    reportMetric('wecom_run_e2e_ms', Date.now() - requestStartedAt, { terminal: 'failed-start' });
    if (durableTaskId) await taskStore.markFailed(durableTaskId, 'agent-startup').catch(() => {});
    console.error(`Failed to start Codex run: ${redactDiagnosticText(message)}`);
    return;
  }

  const active: ActiveRunRecord = {
    run,
    state,
    prompt: displayPrompt,
    taskId,
    threadId,
    durableTaskId,
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

        if (event.type === 'error') {
          log.fail('wecom-run', new Error(event.message), {
            step: 'event',
            kind: failureKind(event),
          });
          console.error(`Codex run event failed: ${redactDiagnosticText(event.message)}`);
        }
        state = reduce(
          state,
          event.type === 'error'
            ? { ...event, message: weComUserErrorMarkdown('execution') }
            : event,
        );
        active.state = state;
        active.threadId = threadId;

        const now = Date.now();
        const terminal = state.terminal !== 'running';
        if (terminal || now - lastFlushAt >= streamFlushIntervalMs) {
          const rendered = renderStream(state, threadId, workspace);
          if (rendered !== lastSent) {
            lastSent = rendered;
            lastFlushAt = now;
            streamUpdates.update(rendered);
          }
        }
      }

      state = finalizeIfRunning(state);
      active.state = state;
      active.threadId = threadId;
      if (durableTaskId) {
        const persistTerminal =
          state.terminal === 'done'
            ? taskStore.markDone(durableTaskId)
            : state.terminal === 'interrupted'
              ? taskStore.markInterrupted(durableTaskId)
              : taskStore.markFailed(durableTaskId, state.terminal);
        await persistTerminal.catch((err: unknown) => {
          log.fail('wecom-task', err, { step: 'mark-terminal', terminal: state.terminal });
          reportMetric('wecom_task_store_failures', 1, {
            step: 'mark-terminal',
            terminal: state.terminal,
          });
        });
      }
      await persistThread(key, threadId, sessionBinding).catch((err: unknown) => {
        log.fail('wecom-session', err, { step: 'persist-after-run' });
      });

      receivedArtifacts.remember(artifactScope(threadId), received);
      const finalText = renderStream(state, threadId, workspace);
      await streamUpdates.finish(finalText);
      if (state.terminal === 'done') {
        await sendGeneratedArtifacts(frame, state, received, sessionBinding.cwdRealpath, requestedAttachments);
      }
      if (state.terminal === 'error') {
        await deliverErrorCard(frame, 'execution');
      }
      await run.waitForExit(1500).catch(() => false);
    } catch (err) {
      if (state.terminal === 'done') {
        // Execution is complete; delivery/persistence failure must never
        // invite an automatic rerun of side-effectful work.
        log.fail('wecom-delivery', err, { step: 'after-completion' });
        reportMetric('wecom_delivery_failures', 1, { step: 'after-completion' });
        if (durableTaskId) await taskStore.markDone(durableTaskId).catch(() => {});
        await replyOnce(frame, '任务已完成，结果发送未完成', [
          '执行结果已产生；请检查连接或本地结果，不要直接重复执行写操作。',
        ]).catch(() => {});
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      state = reduce(state, {
        type: 'error',
        message: weComUserErrorMarkdown('execution'),
        terminationReason: 'failed',
      });
      active.state = state;
      active.threadId = threadId;
      await run.stop().catch(() => {});
      await persistThread(key, threadId, sessionBinding).catch((persistErr: unknown) => {
        console.error(
          `Failed to persist WeCom thread: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
        );
      });
      await streamUpdates.finish(renderStream(state, threadId, workspace)).catch(() => {});
      await deliverErrorCard(frame, 'execution');
      log.fail('wecom-run', err, { step: 'run', kind: failureKind(err) });
      reportMetric('wecom_run_failures', 1, { kind: failureKind(err), step: 'run' });
      if (durableTaskId) await taskStore.markFailed(durableTaskId, failureKind(err)).catch(() => {});
      console.error(`Codex run failed: ${redactDiagnosticText(message)}`);
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
  const key = sessionStore.captureScope(conversationKey(body));
  await handleEnterChatEvent(frame, {
    homeCard: renderWeComCard(buildHomeCardView(navigation.homeCardOptions(key))),
    replyWelcome: (eventFrame, reply) => client.replyWelcome(eventFrame, reply),
    classifyError: failureKind,
    onStage: (stage, errorKind) => {
      const observation = enterChatObservation(stage, key, errorKind);
      if (stage === 'welcome-failed') {
        log.warn('wecom-enter-chat', 'welcome-failed', {
          ...observation,
          diagnostic: '[REDACTED]',
        });
      } else {
        log.info('wecom-enter-chat', stage, { ...observation });
      }
      reportMetric('wecom_enter_chat_events', 1, {
        stage,
        ...(errorKind ? { kind: errorKind } : {}),
      });
    },
  });
}

async function handleTemplateCardEvent(frame: TemplateCardEventFrame): Promise<void> {
  const body = frame.body;
  if (!body) return;

  // Resolve the scope at callback ingress. Registries use the captured key, so
  // a card created before a workspace switch cannot operate on the new scope.
  const key = sessionStore.captureScope(conversationKey(body));
  const { eventKey: rawAction, taskId, selectedId } = templateCardEventDetails(body.event);
  if (!taskId) {
    await deliverErrorCard(frame, 'callback-invalid');
    return;
  }
  const purpose = cardPurposeFromTaskId(taskId);
  if (purpose === 'queue' || purpose === 'unknown') {
    await navigation.updateInvalidCallback(frame, taskId);
    return;
  }
  if (purpose === 'risk') {
    await riskInteraction.handleSelectionCardEvent(frame, riskKeyFor(key, frame.body?.from?.userid), taskId, rawAction, selectedId);
    return;
  }
  if (purpose === 'menu') {
    await handleHomeCardEvent(frame, key, taskId, rawAction);
    return;
  }
  if (purpose === 'codex') {
    await handleLegacyControlCardEvent(frame, key, taskId, rawAction);
    return;
  }
  await navigation.handleNavigationCardEvent(frame, key, taskId, purpose, rawAction, selectedId);
}

async function handleHomeCardEvent(
  frame: TemplateCardEventFrame,
  key: string,
  taskId: string,
  rawAction: string | undefined,
): Promise<void> {
  if (!isHomeAction(rawAction)) {
    await navigation.updateInvalidCallback(frame, taskId);
    return;
  }
  const resolution = navigationCards.resolve(taskId, key);
  if (resolution.status !== 'resolved') {
    await navigation.updateCardLifecycleError(frame, taskId, resolution);
    return;
  }
  if (resolution.card.purpose !== 'menu') {
    await navigation.updateInvalidCallback(frame, taskId);
    return;
  }
  const active = activeRuns.get(key);
  const starting = startingRuns.has(key) || conversationQueue.has(key);
  if (rawAction === 'stop') {
    requestRiskIntentStop(key);
    await navigation.updateHomeCard(frame, key, taskId);
    if (active) {
      active.state = markInterrupted(active.state);
      if (active.durableTaskId) {
        void taskStore.markInterrupted(active.durableTaskId).catch(() => {});
      }
      void active.run.stop().catch((err: unknown) => {
        console.error(`Failed to stop Codex run: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return;
  }
  if (rawAction === 'new') {
    if (active || starting) {
      await navigation.updateHomeCard(frame, key, taskId);
      return;
    }
    await sessionStore.clear(key);
    riskSelectionTasks.clearConversation(key);
    riskApplication.cancelScope(key);
    navigationCards.clearConversation(key);
    await navigation.updateHomeCard(frame, key, taskId);
    return;
  }
  await navigation.updateHomeCard(frame, key, taskId);
}

async function handleLegacyControlCardEvent(
  frame: TemplateCardEventFrame,
  key: string,
  taskId: string,
  rawAction: string | undefined,
): Promise<void> {
  const cardScope = controlCardScopes.get(taskId);
  if (!cardScope || cardScope.expiresAt <= Date.now() || cardScope.key !== key) {
    controlCardScopes.delete(taskId);
    await navigation.updateInvalidCallback(frame, taskId);
    return;
  }
  const workspace = sessionStore.workspaceFor(key);
  const action = normalizeCardAction(rawAction);
  const active = activeRuns.get(key);
  const starting = startingRuns.has(key) || conversationQueue.has(key);
  if (action === 'stop') {
    requestRiskIntentStop(key);
    const riskIntentStopping = riskIntentStopRequests.has(key);
    await client.updateTemplateCard(
      frame,
      buildWeComControlCard({
        taskId,
        status: active ? 'stopping' : starting ? 'running' : 'idle',
        workspace,
        sandbox,
        threadId: currentThreadId(key),
        prompt: active?.prompt,
        notice: active
          ? '停止请求已发送'
          : starting
            ? riskIntentStopping
              ? '风险任务正在启动，停止请求已记录'
              : '任务正在启动'
            : '当前没有运行任务',
      }),
    );
    if (active) {
      active.state = markInterrupted(active.state);
      if (active.durableTaskId) {
        void taskStore.markInterrupted(active.durableTaskId).catch(() => {});
      }
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
          ...(active ? { runState: active.state } : {}),
        }),
      );
      return;
    }
    await sessionStore.clear(key);
    riskSelectionTasks.clearConversation(key);
    riskApplication.cancelScope(key);
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
        status: active || starting ? 'running' : 'idle',
        workspace,
        sandbox,
        threadId: currentThreadId(key),
        prompt: active?.prompt,
        notice: active ? 'Codex 正在运行' : starting ? 'Codex 正在启动' : '当前为空闲状态',
        ...(active ? { runState: active.state } : {}),
      }),
    );
    return;
  }
  await navigation.updateInvalidCallback(frame, taskId);
}


async function replyDoctor(frame: WsFrame, key: string): Promise<void> {
  const workspace = sessionStore.workspaceFor(key);
  const taskSnapshot = taskStore.snapshot();
  const riskConfigured = Boolean(riskPython || configuredRiskServiceDir);
  const codexAvailability = await operationRunner
    .run('codex-health', () => codex.checkAvailability(), {
      idempotent: true,
      maxAttempts: 1,
      timeoutMs: 6_000,
    })
    .catch((err: unknown) => {
      log.fail('wecom-doctor', err, { dependency: 'codex' });
      return undefined;
    });
  const circuitOpen = ['codex-health', 'codex-history', 'media-download'].some(
    (name) => operationRunner.snapshot(name).state === 'open',
  );
  const dependencies: WeComDependencyCheck[] = [
    {
      name: 'WeCom',
      status: connected ? 'ok' : 'error',
      detail: connected ? 'connected' : healthPhase,
    },
    {
      name: 'Codex',
      status: codexAvailability?.ok ? 'ok' : 'error',
      detail: codexAvailability?.ok
        ? codexAvailability.version || effectiveModel(key) || 'available'
        : codexAvailability
          ? codexAvailability.diagnostic.code
          : 'health check failed',
    },
    {
      name: 'Workspace',
      status: existsSync(workspace) ? 'ok' : 'error',
      detail: existsSync(workspace) ? path.basename(workspace) : 'path unavailable',
    },
    {
      name: 'Risk Service',
      status: riskRuntime.snapshot().runtime?.ready ? 'ok' : riskConfigured ? 'error' : 'warning',
      detail: riskRuntime.snapshot().runtime?.ready ? 'ready' : riskRuntime.snapshot().warmup.phase,
    },
    { name: 'Task Store', status: 'ok', detail: `${taskSnapshot.total} records` },
    {
      name: 'Retry / Circuit',
      status: circuitOpen ? 'warning' : 'ok',
      detail: circuitOpen ? 'downstream circuit open' : 'closed',
    },
  ];
  await client.replyTemplateCard(
    frame,
    renderWeComCard(
      buildWeComDoctorCardView({
        taskId: createTaskId(),
        dependencies,
        tasks: taskSnapshot,
        queueActive: activeRuns.size,
        queueStarting: startingRuns.size,
      }),
    ),
  );
}

async function replyRuns(frame: WsFrame, key: string): Promise<void> {
  const recent = taskStore
    .recent(key, 8)
    .filter((task) => task.label !== '最近任务')
    .slice(0, 6);
  await client.replyTemplateCard(
    frame,
    renderWeComCard(buildWeComRecentTasksCardView({ taskId: createTaskId(), tasks: recent })),
  );
}

async function replySettingsSummary(frame: WsFrame, key: string): Promise<void> {
  const workspace = sessionStore.workspaceFor(key);
  await client.replyTemplateCard(
    frame,
    renderWeComCard(
      buildAgentSettingsSummaryCardView({
        taskId: createTaskId(),
        workspace,
        model: effectiveModel(key),
        reasoning: effectiveReasoningEffort(key),
        sandbox,
      }),
    ),
  );
}

function registerControlCard(taskId: string, key: string): void {
  controlCardScopes.set(taskId, {
    key,
    expiresAt: Date.now() + navigationCardTtlMs,
  });
  if (controlCardScopes.size <= 2_000) return;
  const now = Date.now();
  for (const [id, card] of controlCardScopes) {
    if (card.expiresAt <= now) controlCardScopes.delete(id);
  }
  while (controlCardScopes.size > 2_000) {
    controlCardScopes.delete(controlCardScopes.keys().next().value!);
  }
}

async function replyStatus(frame: WsFrame, key: string): Promise<void> {
  const workspace = sessionStore.workspaceFor(key);
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
      `模型：\`${effectiveModel(key) || 'Codex default'}\``,
      `推理：\`${effectiveReasoningEffort(key)}\``,
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
  const workspace = sessionStore.workspaceFor(key);
  const streamId = generateReqId('stream');
  const content = truncateUtf8(renderWeComNotice(title, lines), streamMaxBytes);
  const stream = new WeComStreamReply(client, frame, streamId);
  if (status !== 'reset') await stream.finish(content);
  const taskId = createTaskId();
  registerControlCard(taskId, key);
  await deliverControlCard(
    frame,
    buildWeComControlCard({
      taskId,
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

async function deliverCardView(frame: WsFrame, view: WeComCardView): Promise<void> {
  await deliverControlCard(frame, renderWeComCard(view));
}

async function deliverErrorCard(
  frame: WsFrame,
  kind: WeComErrorKind,
  taskId = createTaskId(),
): Promise<void> {
  await deliverCardView(frame, buildErrorCardView({ taskId, kind }));
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
    attachments = await operationRunner.run(
      'media-download',
      () => mediaStore.resolve(inputs, attachmentOptions),
      {
        idempotent: true,
        maxAttempts: 2,
        timeoutMs: attachmentOptions.downloadTimeoutMs + 5_000,
      },
    );
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
  attachments: readonly ReceivedArtifact[],
  workspace: string,
  requestedAttachments: readonly ReceivedArtifact[],
): Promise<number> {
  const body = frame.body;
  if (!body) return 0;
  const markdown = agentOutputText(state);
  if (!markdown && !requestedAttachments.length) return 0;
  try {
    const result = await sendLinkedWorkspaceArtifacts(
      client,
      messageTarget(body),
      workspace,
      markdown,
      {
        ...artifactOptions,
        requestedAttachments,
        excludedPaths: attachments.map((attachment) => attachment.path),
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
    const summary = artifactDeliverySummary(result);
    if (summary) await client.sendMessage(messageTarget(body), {
      msgtype: 'markdown', markdown: { content: summary },
    });
    return result.sent.length;
  } catch (err) {
    log.fail('wecom-media-egress', err);
    reportMetric('wecom_egress_failures', 1, { kind: failureKind(err) });
    await client.sendMessage(messageTarget(body), {
      msgtype: 'markdown',
      markdown: {
        content: renderWeComNotice(
          '文件回传或结果通知未完成',
          ['部分文件可能已发送，请以实际收到的附件为准；详情请查看本机 bridge 日志。'],
          { status: 'error', eyebrow: 'CODEX · WECOM' },
        ),
      },
    }).catch(() => {});
    return 0;
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

function renderStream(state: RunState, threadId: string | undefined, workspacePath: string): string {
  return truncateUtf8(
    renderWeComMarkdown(state, {
      workspace: workspacePath,
      sandbox,
      threadId,
    }),
    streamMaxBytes,
  );
}

function currentThreadId(key: string): string | undefined {
  return activeRuns.get(key)?.threadId ?? sessionStore.threadId(key);
}

function effectiveModel(key: string): string {
  return effectiveConversationModel(conversationAgentPreferences, key, model);
}

function effectiveReasoningEffort(key: string): string {
  return effectiveConversationReasoningEffort(
    conversationAgentPreferences,
    key,
    codexReasoningEffort,
  );
}

async function persistThread(key: string, threadId: string | undefined, binding?: SessionBindingIdentity): Promise<void> {
  if (!threadId) return;
  await sessionStore.setThread(key, threadId, binding);
}

function createTaskId(): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  return `codex_${Date.now()}_${suffix}`;
}

function createNavigationTaskId(
  purpose: Exclude<WeComCardPurpose, 'codex' | 'queue' | 'risk' | 'unknown'>,
): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  return `${purpose}_${Date.now()}_${suffix}`;
}

function createQueueTaskId(): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  return `queue_${Date.now()}_${suffix}`;
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

function isRiskUserAllowed(userid: string | undefined): boolean {
  return isRiskUserAllowedByConfig(useAllowedList, riskAllowedUserIds, userid);
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
    riskFastPath: riskRuntime.snapshot(),
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
    const tasksRemoved = await taskStore.prune();
    const cardsRemoved = navigationCards.prune();
    reportMetric('wecom_maintenance_removed', logsRemoved, { kind: 'logs' });
    reportMetric('wecom_maintenance_removed', mediaRemoved, { kind: 'media' });
    reportMetric('wecom_maintenance_removed', sessionsRemoved, { kind: 'sessions' });
    reportMetric('wecom_maintenance_removed', tasksRemoved, { kind: 'tasks' });
    reportMetric('wecom_maintenance_removed', cardsRemoved, { kind: 'cards' });
    log.info('wecom-maintenance', 'completed', {
      logsRemoved,
      mediaRemoved,
      sessionsRemoved,
      tasksRemoved,
      cardsRemoved,
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
  await agentRuns.stopAll();
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
    await riskRuntime.close().catch(error => log.fail('risk-runtime', error, { step: 'shutdown' }));
    await sessionStore.flush().catch((err: unknown) => {
      console.error(
        `Failed to flush WeCom sessions during ${signal}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await taskStore.flush().catch((err: unknown) => {
      console.error(
        `Failed to flush WeCom tasks during ${signal}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await healthStore.flush().catch(() => {});
    await closeLogger();
    await releaseStateLock();
  })();
  const completed = await waitForCompletion(cleanup, shutdownTimeoutMs);
  if (!completed) {
    console.error(`WeCom shutdown exceeded ${shutdownTimeoutMs}ms; forcing process exit.`);
  }
  process.exit(0);
}
