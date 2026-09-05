from pathlib import Path


def edit(file, replacements):
    p = Path(file)
    s = p.read_text()
    for old, new in replacements:
        assert s.count(old) == 1, (file, s.count(old), old[:100])
        s = s.replace(old, new, 1)
    p.write_text(s.rstrip() + '\n')


edit('src/bridge/task-ledger.ts', [
    ('export interface TaskLedgerOptions {', 'export interface TaskLedgerOptions {\n  write?: typeof writeFileAtomic;'),
    ('  private readonly maxAgeMs: number;', '  private readonly write: typeof writeFileAtomic;\n  private readonly maxAgeMs: number;'),
    ('    this.maxAgeMs = positiveInt(options.maxAgeMs, DEFAULT_MAX_AGE_MS);', '    this.write = options.write ?? writeFileAtomic;\n    this.maxAgeMs = positiveInt(options.maxAgeMs, DEFAULT_MAX_AGE_MS);'),
    ('this.saving.then(() => writeFileAtomic(this.file, payload, { mode: 0o600 }))', 'this.saving.then(() => this.write(this.file, payload, { mode: 0o600 }))'),
])

# Recovery mutates task state. Do not run it before the runtime has acquired ownership.
edit('src/runtime/supervisor.ts', [
    ('    this.locks = [];\n    this.locks.push(await acquireProfileRuntimeLock', '    this.locks = [];\n    try {\n    this.locks.push(await acquireProfileRuntimeLock'),
    ('    try {\n      this.entry = await register({', '      await this.tasks.load();\n      this.entry = await register({'),
    ('    await tasks.load();\n\n    const managed', '\n    const managed'),
    ('    if (this.entry) {\n      await unregister', "    await this.tasks.flush().catch((err) => log.fail('task-ledger', err, { step: 'profile-stop' }));\n    if (this.entry) {\n      await unregister"),
])

edit('src/wecom/cli.ts', [
    ('  const command = text.toLowerCase();', '''  const command = text.toLowerCase();
  if (durableTaskId && command.startsWith('/')) {
    // Built-in commands can reset sessions or interrupt a process. They must not
    // remain replay-safe queued records once command dispatch begins.
    await taskStore.markRunning(durableTaskId);
  }'''),
    ('  const sessionBinding = sessionStore.bindingFor(key);', '  await sessionStore.flush();\n  const sessionBinding = sessionStore.bindingFor(key);'),
])

# A local timeout is not proof that the underlying work stopped. Abort cooperatively,
# never retry that attempt automatically, and fence further same-operation calls until
# the old promise settles. Late success cannot reset the circuit.
edit('src/bridge/reliability.ts', [
    ('  private readonly circuits = new Map<string, CircuitState>();', '  private readonly circuits = new Map<string, CircuitState>();\n  private readonly lingering = new Map<string, Set<object>>();'),
    ('    fn: () => Promise<T>,', '    fn: (signal: AbortSignal) => Promise<T>,'),
    ('      try {\n        const value = await withTimeout(operation, timeoutMs, fn());\n        this.circuits.delete(operation);', '''      this.assertCircuit(operation);
      const controller = new AbortController();
      const token = {};
      let settled = false;
      const work = Promise.resolve().then(() => fn(controller.signal));
      const markSettled = () => {
        settled = true;
        const pending = this.lingering.get(operation);
        pending?.delete(token);
        if (pending?.size === 0) this.lingering.delete(operation);
      };
      void work.then(markSettled, markSettled);
      try {
        const value = await withTimeout(operation, timeoutMs, work, () => controller.abort());
        if (!this.lingering.has(operation)) this.circuits.delete(operation);'''),
    ('        const retryable = idempotent && isRetryableFailure(kind) && attempt < maxAttempts;', '''        if (err instanceof OperationTimeoutError && !settled) {
          const pending = this.lingering.get(operation) ?? new Set<object>();
          pending.add(token);
          this.lingering.set(operation, pending);
        }
        const retryable = !(err instanceof OperationTimeoutError) && idempotent &&
          isRetryableFailure(kind) && attempt < maxAttempts;'''),
    ("    const state = this.circuits.get(operation);\n    if (!state || state.openedUntil === 0) return { state: 'closed', retryAfterMs: 0 };", "    if (this.lingering.has(operation)) return { state: 'open', retryAfterMs: 0 };\n    const state = this.circuits.get(operation);\n    if (!state || state.openedUntil === 0) return { state: 'closed', retryAfterMs: 0 };"),
    ('  private assertCircuit(operation: string): void {', '  private assertCircuit(operation: string): void {\n    if (this.lingering.has(operation)) throw new CircuitOpenError(operation, 0);'),
    ('async function withTimeout<T>(operation: string, timeoutMs: number, promise: Promise<T>): Promise<T> {', 'async function withTimeout<T>(operation: string, timeoutMs: number, promise: Promise<T>, abort: () => void): Promise<T> {'),
    ('    timer = setTimeout(() => reject(new OperationTimeoutError(operation, timeoutMs)), timeoutMs);', '''    timer = setTimeout(() => {
      reject(new OperationTimeoutError(operation, timeoutMs));
      abort();
    }, timeoutMs);'''),
])

# Reuse the checked-in fake SDK fixture, but exercise the real production channel
# entry with durable files (the older tests intentionally use injected legacy stores).
fixture = Path('tests/integration/bot/topic-quote.test.ts').read_text()
header = fixture[:fixture.index("describe('topic message quote handling'")]
header = header.replace("import { realpath }", "import { realpath }")
header = header.replace("  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));", "  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();")
helpers = fixture[fixture.index('async function createHarness'):]
start = helpers.index('async function startTestBridge')
end = helpers.index('function createFakeLarkChannel', start)
helpers = helpers[:start] + helpers[end:]
extra_imports = '''import { TaskLedger } from '../../../src/bridge/task-ledger';
import { writeFileAtomic } from '../../../src/platform/atomic-write';
'''
tests = r'''
async function startDurable(h: Awaited<ReturnType<typeof createHarness>>, ledger?: TaskLedger) {
  const bridge = await startChannel({
    cfg: h.profileConfig, agent: h.agent, sessions: h.sessions, workspaces: h.workspaces,
    controls: h.controls, taskLedger: ledger,
    appPaths: {
      sessionsFile: join(h.tmp.profile, 'sessions.json'),
      workspacesFile: join(h.tmp.profile, 'workspaces.json'),
      mediaDir: join(h.tmp.profile, 'media'), secretsFile: join(h.tmp.profile, 'secrets.json'),
      keystoreSaltFile: join(h.tmp.profile, 'keystore-salt'),
    },
  });
  cleanups.push(() => bridge.disconnect());
  return bridge;
}
function input(id: string, content: string) {
  return message({ messageId: id, rootId: id, parentId: id, content });
}

describe('Lark production channel with shared durable state', () => {
  it('deduplicates redelivery without changing debounce batching of distinct messages', async () => {
    const h = await createHarness({ chatMode: 'group' });
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), { namespace: 'lark' }); await ledger.load();
    await startDurable(h, ledger);
    await Promise.all([
      h.channel.handlers.message!(input('a', 'alpha_unique')),
      h.channel.handlers.message!(input('a', 'alpha_unique')),
      h.channel.handlers.message!(input('b', 'beta_unique')),
    ]);
    await waitFor(() => ledger.snapshot().done === 3, 5000);
    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]!.prompt;
    expect(prompt.match(/alpha_unique/g)).toHaveLength(1);
    expect(prompt.match(/beta_unique/g)).toHaveLength(1);
    await h.channel.handlers.message!(input('a', 'alpha_unique'));
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('rejects the same delivered message after a disconnected channel restarts with a reopened ledger', async () => {
    const h = await createHarness({ chatMode: 'group' });
    const file = join(h.tmp.profile, 'tasks.json');
    const ledger = new TaskLedger(file, { namespace: 'lark' }); await ledger.load();
    const bridge = await startDurable(h, ledger);
    await h.channel.handlers.message!(input('done', 'first'));
    await waitFor(() => ledger.snapshot().done === 2, 5000);
    await bridge.disconnect();
    const reopened = new TaskLedger(file, { namespace: 'lark' }); await reopened.load();
    await startDurable(h, reopened);
    await h.channel.handlers.message!(input('done', 'first'));
    await h.channel.handlers.message!(input('next', 'second'));
    await waitFor(() => reopened.snapshot().done === 4, 5000);
    expect(h.agent.runOptions).toHaveLength(2);
  });

  it('does not launch an agent after a failed durable claim, and a repaired retry can proceed', async () => {
    const h = await createHarness({ chatMode: 'group' });
    let fail = true;
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), {
      namespace: 'lark', write: async (file, data, options) => {
        if (fail) throw new Error('ENOSPC');
        await writeFileAtomic(file, data, options);
      },
    });
    await ledger.load(); await startDurable(h, ledger);
    await h.channel.handlers.message!(input('retry', 'hello'));
    expect(h.agent.runOptions).toHaveLength(0);
    expect(JSON.stringify(h.channel.sent)).toContain('未执行');
    fail = false;
    await h.channel.handlers.message!(input('retry', 'hello'));
    await waitFor(() => ledger.snapshot().done === 2, 5000);
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('records a command-cancelled pending batch without replaying it', async () => {
    const h = await createHarness({ chatMode: 'group' });
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), { namespace: 'lark' }); await ledger.load();
    await startDurable(h, ledger);
    await h.channel.handlers.message!(input('pending', 'pending_work'));
    await h.channel.handlers.message!(input('command', '/new'));
    await waitFor(() => ledger.snapshot().interrupted === 1, 5000);
    await h.channel.handlers.message!(input('pending', 'pending_work'));
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(h.agent.runOptions).toHaveLength(0);
  });
});
'''
Path('tests/integration/bot/shared-durable-channel.test.ts').write_text(header + extra_imports + tests + helpers)
