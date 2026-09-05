from pathlib import Path
import re


def edit(file, replacements):
    p = Path(file)
    s = p.read_text()
    for old, new in replacements:
        assert s.count(old) == 1, (file, 'anchor count', s.count(old), old[:100])
        s = s.replace(old, new, 1)
    p.write_text(s.rstrip() + '\n')


# All mutations, including duplicate claims, are serialized. Failed disk writes roll
# back the tentative state before the next claimant can inspect it.
edit('src/bridge/task-ledger.ts', [
    ('  private saving: Promise<void> = Promise.resolve();', '''  private saving: Promise<void> = Promise.resolve();
  private mutations: Promise<void> = Promise.resolve();
  private writeError: unknown;

  private transaction<T>(mutate: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(async () => {
      const before = structuredClone({ tasks: this.tasks, operations: this.operations });
      try { return await mutate(); }
      catch (err) {
        this.tasks = before.tasks;
        this.operations = before.operations;
        throw err;
      }
    });
    this.mutations = next.then(() => {}, () => {});
    return next;
  }

  async claimInbound(messageId: string, conversationKey: string): Promise<TaskClaim> {
    if (!messageId.trim() || !conversationKey.trim()) throw new Error('Missing task identity');
    return this.transaction(() => this.claimInboundUncommitted(messageId, conversationKey));
  }

  async annotate(taskId: string, patch: Partial<Pick<TaskRecord, 'kind' | 'label'>>): Promise<void> {
    return this.transaction(() => this.annotateUncommitted(taskId, patch));
  }

  async prune(): Promise<number> { return this.transaction(() => this.pruneUncommitted()); }

  private updateStatus(taskId: string, status: TaskStatus, errorKind?: string): Promise<void> {
    return this.transaction(() => this.updateStatusUncommitted(taskId, status, errorKind));
  }

  /** Dispatcher-only transition: it has confirmed that no command was executed. */
  async markQueued(taskId: string): Promise<void> {
    return this.transaction(async () => {
      const task = this.tasks[taskId];
      if (!task || task.status !== 'running' || task.kind !== 'message') {
        throw new Error('Only an unexecuted inbound message can return to the queue');
      }
      task.status = 'queued';
      task.updatedAt = this.now().toISOString();
      await this.persist();
    });
  }

  /** Atomic transition of every source receipt before a batch can cause effects. */
  async markBatchRunning(taskIds: readonly string[]): Promise<void> {
    return this.transaction(async () => {
      if (!taskIds.length || new Set(taskIds).size !== taskIds.length) throw new Error('Invalid task batch');
      for (const id of taskIds) {
        if (this.tasks[id]?.status !== 'queued') throw new Error('Task batch is not wholly queued');
      }
      for (const id of taskIds) {
        const task = this.tasks[id]!;
        task.status = 'running';
        task.updatedAt = this.now().toISOString();
        task.recoveryFrom = undefined;
        task.recoveryReason = undefined;
      }
      await this.persist();
    });
  }'''),
    ('  async claimInbound(messageId: string, conversationKey: string): Promise<TaskClaim> {\n    const operationKey', '  private async claimInboundUncommitted(messageId: string, conversationKey: string): Promise<TaskClaim> {\n    const operationKey'),
    ('  async annotate(\n', '  private async annotateUncommitted(\n'),
    ('  async prune(): Promise<number> {\n    const removed', '  private async pruneUncommitted(): Promise<number> {\n    const removed'),
    ('  private async updateStatus(\n', '  private async updateStatusUncommitted(\n'),
    ("    if (status === 'done' && (task.status === 'failed' || task.status === 'interrupted')) return;", '''    const terminal = task.status === 'done' || task.status === 'failed' || task.status === 'interrupted';
    if (terminal) {
      if (status === 'running') throw new Error('Cannot start a terminal task');
      return;
    }'''),
    ('  async flush(): Promise<void> {\n    await this.saving;\n  }', '''  async flush(): Promise<void> {
    await this.mutations;
    await this.saving;
    if (this.writeError !== undefined) throw this.writeError;
  }'''),
    ('    this.saving = next.catch(() => {});', '''    this.saving = next.then(
      () => { this.writeError = undefined; },
      (err: unknown) => { this.writeError = err; },
    );'''),
    ('    operations[operationKey] = taskId;\n  }\n  return', '''    if (!tasks[taskId] || tasks[taskId]!.operationKey !== operationKey) throw damaged(file);
    operations[operationKey] = taskId;
  }
  for (const task of Object.values(tasks)) {
    if (operations[task.operationKey] !== task.id) throw damaged(file);
  }
  return'''),
])

# Preserve Lark's debounce and topic semantics while observing all cancellations,
# including those initiated by card callbacks rather than message commands.
edit('src/bot/pending-queue.ts', [
    ('  constructor(delayMs: number, onFlush: FlushHandler) {', '''  constructor(
    delayMs: number,
    onFlush: FlushHandler,
    private readonly onCancel?: (messages: NormalizedMessage[]) => void,
  ) {'''),
    ('    this.map.delete(scope);\n    return entry.messages;', '    this.map.delete(scope);\n    this.onCancel?.(entry.messages);\n    return entry.messages;'),
    ('  cancelAll(): void {\n    for (const entry', '  cancelAll(): void {\n    const messages = [...this.map.values()].flatMap((entry) => entry.messages);\n    for (const entry'),
    ('    this.blocked.clear();\n  }', '    this.blocked.clear();\n    if (messages.length) this.onCancel?.(messages);\n  }'),
])

edit('src/bot/run-flow.ts', [
    ('export interface StartRunFlowInput {\n', 'export interface StartRunFlowInput {\n  operationId?: string;\n'),
    ('export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {', '''export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  await Promise.all([input.sessions.flush(), input.sessionCatalog?.flush(), input.workspaces.flush()]);'''),
    ('      scopeId: input.scopeId,\n      policy,', '      scopeId: input.scopeId,\n      operationId: input.operationId,\n      policy,'),
])

edit('src/bot/channel.ts', [
    ("import type { TaskLedger } from '../bridge/task-ledger';", """import type { TaskLedger } from '../bridge/task-ledger';
import { InboundCoordinator, openLarkTaskLedger, type InboundTerminal } from '../bridge/inbound-coordinator';
import { openLarkConversationViews } from '../bridge/conversation-views';
import type { BridgeIdentity } from '../bridge/identity';"""),
    ("  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'>;", "  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'> & Partial<Pick<AppPaths, 'sessionsFile' | 'workspacesFile'>>;"),
    ('  const { cfg, agent, sessions, sessionCatalog, workspaces, controls } = deps;', '''  const { cfg, agent, controls } = deps;
  const identity: BridgeIdentity = {
    channel: 'lark', accountId: cfg.accounts.app.id, instanceId: controls.profile || 'default',
  };
  const scoped = deps.appPaths?.sessionsFile && deps.appPaths.workspacesFile
    ? await openLarkConversationViews(deps.sessions, {
        sessionsFile: deps.appPaths.sessionsFile, workspacesFile: deps.appPaths.workspacesFile,
      }, identity)
    : undefined;
  const { sessions, sessionCatalog, workspaces } = scoped ?? deps;
  const taskLedger = deps.taskLedger ?? (deps.appPaths?.sessionsFile
    ? await openLarkTaskLedger(deps.sessions, deps.appPaths.sessionsFile) : undefined);
  const inbound = taskLedger ? new InboundCoordinator(taskLedger, identity) : undefined;'''),
    ('taskLedger: deps.taskLedger });', 'taskLedger });'),
    ("      try {\n        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);", """      let inboundStatus: InboundTerminal = 'failed';
      try {
        const operationId = await inbound?.startBatch(batch);
        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);"""),
    ('        await runAgentBatch({\n          channel,', '''        await runAgentBatch({
          operationId,
          onTerminal: (status) => { inboundStatus = status; },
          channel,'''),
    ("      } finally {\n        pending.unblock(scope);\n        log.info('flush', 'end');", """      } finally {
        await inbound?.finish(batch, inboundStatus).catch((err) => log.fail('inbound-ledger', err, { step: 'terminal' }));
        pending.unblock(scope);
        log.info('flush', 'end');"""),
    ('  });\n\n  // Counter for stdout reconnect escalation;', """  }, (messages) => {
    void inbound?.finish(messages, 'interrupted').catch((err) => log.fail('inbound-ledger', err, { step: 'cancel' }));
  });

  // Counter for stdout reconnect escalation;"""),
    ('        intakeMessage({\n          channel,', '        intakeMessage({\n          inbound,\n          channel,'),
    ('      pending.cancelAll();\n', "      pending.cancelAll();\n      await inbound?.close().catch((err) => log.fail('inbound-ledger', err, { step: 'disconnect' }));\n"),
    ('interface IntakeDeps {\n', 'interface IntakeDeps {\n  inbound?: InboundCoordinator;\n'),
    ('  const handled = await tryHandleCommand({', '''  try {
    const claim = await deps.inbound?.accept(emsg);
    if (claim && !claim.accepted) {
      log.info('intake', 'duplicate-durable', { status: claim.task.status });
      return;
    }
    await deps.inbound?.beforeDispatch(emsg);
  } catch (err) {
    log.fail('inbound-ledger', err, { step: 'accept' });
    await channel.send(msg.chatId, { text: '任务记录暂不可写，本条消息未执行。请检查存储后重新发送。' }, { replyTo: msg.messageId }).catch(() => {});
    return;
  }
  try {
  const handled = await tryHandleCommand({'''),
    ("    log.info('intake', 'command', { scope, droppedPending: dropped.length });\n    return;", """    await Promise.all([sessions.flush(), sessionCatalog?.flush(), workspaces.flush()]);
    await deps.inbound?.finish([emsg], 'done');
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;"""),
    ('  const size = pending.push(scope, emsg);', '  await deps.inbound?.queued(emsg);\n  const size = pending.push(scope, emsg);'),
    ("  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });\n}", """  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
  } catch (err) {
    await deps.inbound?.finish([emsg], 'failed').catch((failure) => log.fail('inbound-ledger', failure));
    throw err;
  }
}"""),
    ('interface RunBatchDeps {\n', 'interface RunBatchDeps {\n  operationId?: string;\n  onTerminal?: (status: InboundTerminal) => void;\n'),
    ('  const flow = await startRunFlow({\n    scopeId: scope,', '  const flow = await startRunFlow({\n    operationId: deps.operationId,\n    scopeId: scope,'),
    ('  const eventStream = execution.subscribe();', '''  const eventStream: AsyncIterable<AgentEvent> = {
    async *[Symbol.asyncIterator]() {
      let terminal = false;
      try {
        for await (const event of execution.subscribe()) {
          if (event.type === 'done' || event.type === 'error') {
            terminal = true;
            deps.onTerminal?.(handle.interrupted || event.terminationReason === 'interrupted'
              ? 'interrupted' : event.type === 'done' && event.terminationReason === 'normal' ? 'done' : 'failed');
          }
          yield event;
        }
      } finally {
        if (!terminal) deps.onTerminal?.(handle.interrupted ? 'interrupted' : 'failed');
      }
    },
  };'''),
])

# WeCom keeps its command/card protocol. Session identity is now workspace/policy-aware.
edit('src/wecom/cli.ts', [
    ("import { WeComSessionStore } from './session-store';", """import { WeComConversationBindings } from './conversation-bindings';
import { bindingPolicyFingerprint, type SessionBindingIdentity } from '../bridge/identity';
import { acquireStateDirectoryLock } from '../bridge/state-lock';"""),
    ('await mkdir(stateDir, { recursive: true });\nconfigureLogger', 'await mkdir(stateDir, { recursive: true });\nconst releaseStateLock = await acquireStateDirectoryLock(stateDir);\nconfigureLogger'),
    ('const sessionStore = new WeComSessionStore(sessionFile, {', '''const sessionStore = new WeComConversationBindings(sessionFile, {
  identity: { channel: 'wecom', accountId: botId, instanceId: stateDir },
  workspace,
  policyFingerprint: bindingPolicyFingerprint([
    sandbox, process.env.CODEX_BINARY?.trim() || 'codex', process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'inherit-home', 'user-config', 'user-rules',
  ]),'''),
    ('''      // Do not drop a valid user message because the optional durable ledger is temporarily unwritable.
      // The existing in-memory dedupe remains active for this process; report the degraded state.
      log.fail('wecom-task', err, { step: 'claim' });
      reportMetric('wecom_task_store_failures', 1, { step: 'claim' });''', '''      log.fail('wecom-task', err, { step: 'claim' });
      reportMetric('wecom_task_store_failures', 1, { step: 'claim' });
      const diagnostic = normalizeIncomingText(textFromWeComMessage(frame.body), frame.body.chattype).toLowerCase();
      if (!['/doctor', '/status', '/menu', '/help'].includes(diagnostic) || collectWeComMediaInputs(frame.body).length) {
        await replyOnce(frame, '任务未执行', ['任务记录暂不可写；没有启动 Agent。请发送 /doctor 检查后重新发送。']).catch(() => {});
        return;
      }'''),
    ('  const streamUpdates = new WeComStreamUpdatePump(stream);\n  let threadId = sessionStore.threadId(key);', '  const streamUpdates = new WeComStreamUpdatePump(stream);\n  const sessionBinding = sessionStore.bindingFor(key);\n  let threadId = sessionStore.threadId(key);'),
    ('      cwd: workspace,\n      threadId,', '      cwd: sessionBinding.cwdRealpath,\n      threadId,'),
    ('      await persistThread(key, threadId);', '''      await persistThread(key, threadId, sessionBinding).catch((err: unknown) => {
        log.fail('wecom-session', err, { step: 'persist-after-run' });
      });'''),
    ('      await persistThread(key, threadId).catch((persistErr: unknown) => {', '      await persistThread(key, threadId, sessionBinding).catch((persistErr: unknown) => {'),
    ('async function persistThread(key: string, threadId: string | undefined): Promise<void> {\n  if (!threadId) return;\n  await sessionStore.setThread(key, threadId);', '''async function persistThread(key: string, threadId: string | undefined, binding?: SessionBindingIdentity): Promise<void> {
  if (!threadId) return;
  await sessionStore.setThread(key, threadId, binding);'''),
])

# Release the deployment lock only after shutdown has drained and flushed state.
p = Path('src/wecom/cli.ts')
s = p.read_text()
assert s.count('await closeLogger();') == 1, 'shutdown logger anchor changed'
s = s.replace('await closeLogger();', 'await closeLogger();\n    await releaseStateLock();')
p.write_text(s)

# Use the shared binding resolver in all key-aware WeCom handlers. The existing
# global remains the configured default, not a mutable cross-conversation setting.
# TypeScript AST gives exact function boundaries, avoiding regex over nested braces.
Path('.github/finish-shared-core-ast.cjs').write_text(r'''
const ts = require('typescript');
const fs = require('node:fs');
const file = 'src/wecom/cli.ts';
let text = fs.readFileSync(file, 'utf8');
const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const inserts = [];
for (const node of tree.statements) {
  if (!ts.isFunctionDeclaration(node) || !node.body) continue;
  if (!node.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === 'key')) continue;
  let usesWorkspace = false;
  function visit(n) {
    if (ts.isIdentifier(n) && n.text === 'workspace') usesWorkspace = true;
    ts.forEachChild(n, visit);
  }
  visit(node.body);
  if (usesWorkspace) inserts.push(node.body.getStart(tree) + 1);
}
for (const position of inserts.sort((a,b) => b-a)) {
  text = text.slice(0,position) + '\n  const workspace = sessionStore.workspaceFor(key);' + text.slice(position);
}
fs.writeFileSync(file, text);
''')
