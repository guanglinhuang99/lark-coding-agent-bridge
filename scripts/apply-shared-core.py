from pathlib import Path

def read(p): return Path(p).read_text()
def write(p, text):
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    Path(p).write_text(text)
def replace(p, old, new, count=1):
    s=read(p)
    if s.count(old) != count:
        raise RuntimeError(f'{p}: expected {count} matches, got {s.count(old)} for {old[:90]!r}')
    write(p,s.replace(old,new))
def relocate(old, new, transform=lambda s:s):
    write(new, transform(read(old)))
    relative='../bridge/'+Path(new).stem
    write(old, f'// Compatibility import path; implementation lives in the shared bridge core.\nexport * from {relative!r};\n')

relocate('src/bot/active-runs.ts','src/bridge/active-runs.ts')
relocate('src/runtime/errors.ts','src/bridge/errors.ts',lambda s:s.replace("  | 'pool-full'", "  | 'duplicate-operation'\n  | 'pool-full'"))
relocate('src/session/store.ts','src/bridge/session-store.ts')
relocate('src/session/catalog.ts','src/bridge/session-catalog.ts')
relocate('src/workspace/store.ts','src/bridge/workspace-store.ts')
thread=read('src/wecom/session-store.ts').replace('WeComSession','ThreadSession')
write('src/bridge/thread-session-store.ts',thread)
write('src/wecom/session-store.ts', '''// Existing WeCom session files retain their exact schema and path.
export {
  ThreadSessionStore as WeComSessionStore,
  type ThreadSessionRecord as WeComSessionRecord,
  type ThreadSessionStoreOptions as WeComSessionStoreOptions,
} from '../bridge/thread-session-store';
''')

s=read('src/wecom/reliability.ts')
start=s.index('export function capacityNotice')
end=s.index('function isRetryableFailure')
core=s[:start]+s[end:]
for old,new in [('WeComOperationTimeoutError','OperationTimeoutError'),('WeComCircuitOpenError','CircuitOpenError'),('WeComOperationRunner','OperationRunner'),('WeComOperationPolicy','OperationPolicy'),('WeComFailureKind','FailureKind')]:
    core=core.replace(old,new)
core=core.replace("type WeComQueueReason = 'queue-full' | 'queue-timeout' | 'shutting-down';\n\n",'')
core=core.replace("item.name === 'OperationTimeoutError'", "item.name === 'OperationTimeoutError' || item.name === 'WeComOperationTimeoutError'")
write('src/bridge/reliability.ts',core)
write('src/wecom/reliability.ts', '''export {
  OperationRunner as WeComOperationRunner,
  OperationTimeoutError as WeComOperationTimeoutError,
  CircuitOpenError as WeComCircuitOpenError,
  failureKind,
  type FailureKind as WeComFailureKind,
  type OperationPolicy as WeComOperationPolicy,
} from '../bridge/reliability';
type WeComQueueReason = 'queue-full' | 'queue-timeout' | 'shutting-down';

'''+s[start:end])

s=read('src/wecom/task-store.ts').replace('WeComTaskStore','TaskLedger').replace('WeComTask','Task')
s=s.replace("  | 'message'", "  | 'agent'\n  | 'message'",1)
s=s.replace('export interface TaskLedgerOptions {','export interface TaskLedgerOptions {\n  namespace?: string;\n  canReplayRunning?: (task: Readonly<TaskRecord>) => boolean;')
s=s.replace('private readonly now: () => Date;', 'private readonly now: () => Date;\n  private readonly namespace?: string;\n  private readonly canReplayRunning: (task: Readonly<TaskRecord>) => boolean;')
s=s.replace('this.now = options.now ?? (() => new Date());','this.now = options.now ?? (() => new Date());\n    this.namespace = options.namespace;\n    this.canReplayRunning = options.canReplayRunning ?? (() => false);')
s=s.replace('const operationKey = hashOperationKey(messageId);','const operationKey = hashOperationKey(this.namespace\n      ? JSON.stringify([this.namespace, conversationKey, messageId]) : messageId);')
s=s.replace("existing.recoveryFrom === 'queued' || existing.kind === 'risk'", "existing.recoveryFrom === 'queued' || this.canReplayRunning(existing)")
s=s.replace("return value === 'message' ||", "return value === 'agent' || value === 'message' ||")
s=s.replace("    let removed = 0;\n    for (const taskId", "    for (const task of ordered) {\n      if (task.status === 'queued' || task.status === 'running') keep.add(task.id);\n    }\n    let removed = 0;\n    for (const taskId")
write('src/bridge/task-ledger.ts',s.replace('Invalid WeCom task store','Invalid bridge task store'))
write('src/wecom/task-store.ts', '''import { TaskLedger, type TaskLedgerOptions } from '../bridge/task-ledger';
export {
  hashOperationKey,
  type TaskStatus as WeComTaskStatus,
  type TaskKind as WeComTaskKind,
  type TaskRecord as WeComTaskRecord,
  type TaskClaim as WeComTaskClaim,
  type TaskLedgerSnapshot as WeComTaskStoreSnapshot,
  type TaskLedgerOptions as WeComTaskStoreOptions,
} from '../bridge/task-ledger';
/** Keep v0.8 operation hashes and the explicit deterministic-risk replay policy. */
export class WeComTaskStore extends TaskLedger {
  constructor(file: string, options: TaskLedgerOptions = {}) {
    super(file, { ...options, canReplayRunning: options.canReplayRunning ?? ((task) => task.kind === 'risk') });
  }
}
''')

p='src/wecom/runtime.ts'; s=read(p)
start=s.index('export type WeComConversationQueueReason')
end=s.index('export class WeComRunCapacityError')
write('src/bridge/conversation-queue.ts',s[start:end].replace('WeComConversation','Conversation'))
s=s[:start]+'''export {
  ConversationQueue as WeComConversationQueue,
  ConversationQueueError as WeComConversationQueueError,
  type ConversationQueueReason as WeComConversationQueueReason,
  type ConversationSubmission as WeComConversationSubmission,
} from '../bridge/conversation-queue';

'''+s[end:]
start=s.index('interface WeComRunWaiter')
end=s.index('function capacityMessage')
s=s[:start]+'''/** WeCom retains its API; the shared pool owns admission. */
export class WeComRunGate {
  readonly pool: ProcessPool;
  constructor(maxConcurrent: number, maxQueued: number, queueTimeoutMs: number) {
    this.pool = new ProcessPool(() => maxConcurrent, { maxQueued, queueTimeoutMs });
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    try { return await this.pool.run(task); }
    catch (err) {
      if (err instanceof RunCapacityError) throw new WeComRunCapacityError(err.reason);
      throw err;
    }
  }
  currentPermit(): RunPermit | undefined { return this.pool.currentPermit(); }
  snapshot(): { active: number; queued: number } {
    const state = this.pool.snapshot();
    return { active: state.active, queued: state.waiting };
  }
  close(): void { this.pool.close(); }
}

'''+s[end:]
write(p,"import { ProcessPool, RunCapacityError, type RunPermit } from '../bridge/process-pool';\n"+s)
write('src/bot/process-pool.ts',"export * from '../bridge/process-pool';\n")
write('src/runtime/run-executor.ts',"export * from '../bridge/run-executor';\n")

p='src/wecom/cli.ts'
replace(p,"import { CodexAdapter } from '../agent/codex/adapter';", "import { CodexAdapter } from '../agent/codex/adapter';\nimport { ActiveRuns } from '../bridge/active-runs';\nimport { RunExecutor } from '../bridge/run-executor';\nimport { startWeComAgentRun } from './agent-runtime';")
replace(p,'const riskDirectEnabled = Boolean(', 'const agentRuns = new ActiveRuns();\nconst runExecutor = new RunExecutor({ agent: codex, pool: runGate.pool, activeRuns: agentRuns });\nconst riskDirectEnabled = Boolean(')
replace(p,'  const run = codex.run({','  const run = await startWeComAgentRun(runExecutor, {')
replace(p,"    model: riskIntentModel,\n    sandbox: 'read-only',\n  });", "    model: riskIntentModel,\n    sandbox: 'read-only',\n  }, `risk-intent:${randomUUID()}`, runGate.currentPermit());")
replace(p,'    run = codex.run({','    run = await startWeComAgentRun(runExecutor, {')
replace(p,"        .map((attachment) => attachment.absPath),\n    });", "        .map((attachment) => attachment.absPath),\n    }, key, runGate.currentPermit());")
replace(p,'  runGate.close();','  runGate.close();\n  await agentRuns.stopAll();')

p='src/runtime/supervisor.ts'
replace(p,"import { SessionStore } from '../session/store';", "import { SessionStore } from '../session/store';\nimport { TaskLedger } from '../bridge/task-ledger';")
replace(p,'    private workspaces: WorkspaceStore,','    private workspaces: WorkspaceStore,\n    private tasks: TaskLedger,')
replace(p,'        workspaces: this.workspaces,','        workspaces: this.workspaces,\n        taskLedger: this.tasks,',2)
replace(p,'    await workspaces.load();','    await workspaces.load();\n    const tasks = new TaskLedger(`${appPaths.sessionsFile}.tasks.json`, { namespace: \'lark\' });\n    await tasks.load();')
replace(p,'      workspaces,\n      this.startChannelFn,','      workspaces,\n      tasks,\n      this.startChannelFn,')
p='src/bot/channel.ts'
replace(p,"import { RunExecutor } from '../runtime/run-executor';", "import { RunExecutor } from '../runtime/run-executor';\nimport type { TaskLedger } from '../bridge/task-ledger';")
replace(p,'export interface StartChannelDeps {','export interface StartChannelDeps {\n  taskLedger?: TaskLedger;')
replace(p,'const executor = new RunExecutor({ agent, pool, activeRuns });','const executor = new RunExecutor({ agent, pool, activeRuns, taskLedger: deps.taskLedger });')
p='src/runtime/agent-runtime.ts'
replace(p,"import type { AgentAdapter } from '../agent/types';", "import type { AgentAdapter } from '../agent/types';\nimport { OperationRunner } from '../bridge/reliability';")
replace(p,'export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {', '''const availabilityRunners = new WeakMap<AgentAdapter, OperationRunner>();
export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  let runner = availabilityRunners.get(agent);
  if (!runner) { runner = new OperationRunner(); availabilityRunners.set(agent, runner); }
  return runner.run('agent-availability', () => probeRuntimeAgentAvailability(agent), {
    idempotent: true, maxAttempts: 1, timeoutMs: 15_000,
  });
}
async function probeRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {''')
write('src/bridge/index.ts', '''export { RunExecutor } from './run-executor';
export type { ExecutionPolicy, SubmitRunInput, RunExecution, RunExecutorDeps } from './run-executor';
export { ProcessPool, RunCapacityError } from './process-pool';
export type { RunPermit, ProcessPoolOptions } from './process-pool';
export { ActiveRuns } from './active-runs';
export { ConversationQueue } from './conversation-queue';
export { TaskLedger } from './task-ledger';
export { OperationRunner } from './reliability';
export { SessionCatalog } from './session-catalog';
export { SessionStore } from './session-store';
export { ThreadSessionStore } from './thread-session-store';
export { WorkspaceStore } from './workspace-store';
''')
