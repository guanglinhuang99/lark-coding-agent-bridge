import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../../src/agent/types';
import { ProcessPool, RunCapacityError } from '../../../src/bridge/process-pool';
import { ProcessPool as LegacyPool } from '../../../src/bot/process-pool';
import { ActiveRuns } from '../../../src/bridge/active-runs';
import { RunExecutor } from '../../../src/bridge/run-executor';
import { RunExecutor as LegacyExecutor } from '../../../src/runtime/run-executor';
import { TaskLedger } from '../../../src/bridge/task-ledger';
import { WeComTaskStore } from '../../../src/wecom/task-store';
import { WeComRunGate, WeComRunCapacityError } from '../../../src/wecom/runtime';
import { startWeComAgentRun } from '../../../src/wecom/agent-runtime';
import { WeComSessionStore } from '../../../src/wecom/session-store';
import { ThreadSessionStore } from '../../../src/bridge/thread-session-store';
import { OperationRunner } from '../../../src/bridge/reliability';
import { WeComOperationRunner } from '../../../src/wecom/reliability';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function dir() { const p = await mkdtemp(join(tmpdir(), 'bridge-core-')); directories.push(p); return p; }
const done: AgentEvent = { type: 'done', terminationReason: 'normal' };
async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const e of events) result.push(e); return result; }
function agentFixture(events: AgentEvent[] = [{ type: 'text', delta: 'hello' }, done]) {
  const stop = vi.fn(async () => {});
  const waitForExit = vi.fn(async () => true);
  const prepareRun = vi.fn(async () => {});
  const run = vi.fn((opts: AgentRunOptions) => ({ runId: opts.runId, stop, waitForExit, events: { async *[Symbol.asyncIterator]() { yield* events; } } }));
  const agent: AgentAdapter = { id: 'codex', displayName: 'Codex', isAvailable: async () => true, prepareRun, run };
  return { agent, run, prepareRun, stop, waitForExit };
}
function input(scopeId = 'chat', expiresAt = Number.POSITIVE_INFINITY) {
  return { scopeId, policy: { prompt: 'PRIVATE_PROMPT', cwdRealpath: '/workspace', expiresAt, accessMode: 'readonly', sandbox: 'read-only' as const } };
}

describe('shared bridge admission', () => {
  it('uses identical core classes through legacy imports', () => {
    expect(LegacyPool).toBe(ProcessPool); expect(LegacyExecutor).toBe(RunExecutor);
    expect(WeComOperationRunner).toBe(OperationRunner); expect(WeComSessionStore).toBe(ThreadSessionStore);
  });
  it('reserves FIFO slots before waking waiters and releases idempotently', async () => {
    const pool = new ProcessPool(() => 1); const first = await pool.acquire(); const waiting = pool.acquire();
    first(); expect(pool.tryAcquire()).toBeUndefined(); const second = await waiting;
    expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    first(); expect(pool.tryAcquire()).toBeUndefined(); second(); second();
    expect(pool.snapshot().active).toBe(0);
  });
  it('respects reduced dynamic capacity', async () => {
    let cap = 2; const pool = new ProcessPool(() => cap);
    const a = await pool.acquire(); const b = await pool.acquire(); const pending = pool.acquire();
    cap = 1; a(); expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });
    b(); (await pending)(); expect(pool.snapshot().active).toBe(0);
  });
  it('rejects overflow and only times out the queued request', async () => {
    vi.useFakeTimers(); const pool = new ProcessPool(() => 1, { maxQueued: 1, queueTimeoutMs: 10 });
    const release = await pool.acquire(); const waiting = pool.acquire();
    const assertion = expect(waiting).rejects.toMatchObject({ reason: 'queue-timeout' });
    await expect(pool.acquire()).rejects.toMatchObject({ reason: 'queue-full' });
    await vi.advanceTimersByTimeAsync(11); await assertion;
    expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 0 }); release();
  });
  it('closes pending requests while keeping the owner accounted for', async () => {
    const pool = new ProcessPool(() => 1); const release = await pool.acquire();
    const waiting = pool.acquire(); const assertion = expect(waiting).rejects.toBeInstanceOf(RunCapacityError);
    pool.close(); await assertion; expect(pool.snapshot().active).toBe(1);
    release(); await expect(pool.acquire()).rejects.toMatchObject({ reason: 'shutting-down' });
  });
  it('rejects foreign, already borrowed, and released permits', async () => {
    const pool = new ProcessPool(() => 1); const other = new ProcessPool(() => 1); const permit = await pool.acquire();
    expect(() => other.borrow(permit)).toThrow('foreign'); const releaseBorrow = pool.borrow(permit);
    expect(() => pool.borrow(permit)).toThrow('in use'); permit(); expect(pool.snapshot().active).toBe(1);
    releaseBorrow(); expect(pool.snapshot().active).toBe(0); expect(() => pool.borrow(permit)).toThrow('released');
  });
  it('isolates permit contexts across concurrent operations', async () => {
    const pool = new ProcessPool(() => 2);
    const permits = await Promise.all([1, 2].map(() => pool.run(async () => {
      const before = pool.currentPermit(); await Promise.resolve(); expect(pool.currentPermit()).toBe(before); return before;
    })));
    expect(permits[0]).not.toBe(permits[1]); expect(pool.currentPermit()).toBeUndefined();
  });
  it('retains the WeCom capacity error contract', async () => {
    const gate = new WeComRunGate(1, 0, 10); gate.close();
    await expect(gate.run(async () => {})).rejects.toBeInstanceOf(WeComRunCapacityError);
  });
});

describe('shared run executor', () => {
  it('runs WeCom inside a capacity-one permit without double admission or deadlock', async () => {
    const gate = new WeComRunGate(1, 1, 20); const f = agentFixture();
    const executor = new RunExecutor({ agent: f.agent, pool: gate.pool, activeRuns: new ActiveRuns() });
    await gate.run(async () => {
      const run = await startWeComAgentRun(executor, {
        runId: 'wecom-1', prompt: 'test', cwd: '/workspace', model: 'test-model',
        reasoningEffort: 'high', sandbox: 'read-only', images: ['/image.png'],
      }, 'single:user', gate.currentPermit());
      expect(gate.snapshot().active).toBe(1); expect(await collect(run.events)).toHaveLength(2);
      expect(gate.snapshot().active).toBe(1);
    });
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
    expect(f.prepareRun).toHaveBeenCalledOnce(); expect(f.run).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'high', model: 'test-model', sandbox: 'read-only', images: ['/image.png'] });
  });
  it('fans out one process to multiple consumers', async () => {
    const f = agentFixture(); const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent: f.agent, pool, activeRuns: new ActiveRuns() });
    const run = await executor.submit(input()); const results = await Promise.all([collect(run.subscribe()), collect(run.subscribe())]);
    expect(results[0]).toEqual(results[1]); expect(f.run).toHaveBeenCalledOnce(); expect(pool.snapshot().active).toBe(0);
  });
  it('rechecks policy expiry after waiting and frees the rejected scope', async () => {
    let now = 0; const f = agentFixture(); const pool = new ProcessPool(() => 1); const activeRuns = new ActiveRuns();
    const release = await pool.acquire(); const executor = new RunExecutor({ agent: f.agent, pool, activeRuns, now: () => now });
    const pending = executor.submit(input('chat', 10)); const assertion = expect(pending).rejects.toMatchObject({ code: 'policy-expired' });
    now = 11; release(); await assertion; expect(f.run).not.toHaveBeenCalled();
    const next = await executor.submit(input()); await collect(next.subscribe());
    expect(activeRuns.scopes()).toEqual([]); expect(pool.snapshot().active).toBe(0);
  });
  it('frees scope reservations when acquisition fails', async () => {
    const f = agentFixture(); const pool = new ProcessPool(() => 1, { maxQueued: 0 }); const activeRuns = new ActiveRuns();
    const release = await pool.acquire(); const executor = new RunExecutor({ agent: f.agent, pool, activeRuns });
    await expect(executor.submit(input())).rejects.toMatchObject({ reason: 'queue-full' });
    release(); const next = await executor.submit(input()); await collect(next.subscribe()); expect(f.run).toHaveBeenCalledOnce();
  });
  it('does not spawn after prepare fails', async () => {
    const f = agentFixture(); f.prepareRun.mockRejectedValue(new Error('prepare failed'));
    const pool = new ProcessPool(() => 1); const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent: f.agent, pool, activeRuns });
    await expect(executor.submit(input())).rejects.toMatchObject({ code: 'agent-prepare-failed' });
    expect(f.run).not.toHaveBeenCalled(); expect(pool.snapshot().active).toBe(0);
    const release = activeRuns.reserve('chat'); expect(release).toBeTypeOf('function'); release?.();
  });
  it('wakes subscribers and releases capacity when cleanup rejects', async () => {
    const f = agentFixture(); f.waitForExit.mockRejectedValue(new Error('exit failed'));
    const pool = new ProcessPool(() => 1); const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent: f.agent, pool, activeRuns }); const run = await executor.submit(input());
    await expect(collect(run.subscribe())).rejects.toThrow('exit failed');
    expect(pool.snapshot().active).toBe(0); expect(activeRuns.scopes()).toEqual([]);
  });
  it('stops agents that do not exit after their terminal event', async () => {
    const f = agentFixture(); f.waitForExit.mockResolvedValue(false); const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent: f.agent, pool, activeRuns: new ActiveRuns() });
    const run = await executor.submit(input()); await collect(run.subscribe());
    expect(f.stop).toHaveBeenCalledOnce(); expect(pool.snapshot().active).toBe(0);
  });
  it('stops idempotently before any subscription', async () => {
    const f = agentFixture(); const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent: f.agent, pool, activeRuns: new ActiveRuns() });
    const run = await executor.submit(input()); await Promise.all([run.stop(), run.stop()]);
    expect(f.stop).toHaveBeenCalledOnce(); expect(pool.snapshot().active).toBe(0);
  });
});

describe('shared stores and isolation', () => {
  it('records executor lifecycle without raw prompts or operation ids', async () => {
    const path = join(await dir(), 'tasks.json'); const ledger = new TaskLedger(path, { namespace: 'lark' }); await ledger.load();
    const f = agentFixture(); const executor = new RunExecutor({ agent: f.agent, pool: new ProcessPool(() => 1), activeRuns: new ActiveRuns(), taskLedger: ledger });
    const run = await executor.submit({ ...input(), operationId: 'PRIVATE_MESSAGE_ID' }); await collect(run.subscribe());
    expect(ledger.snapshot()).toMatchObject({ done: 1, running: 0 });
    await expect(executor.submit({ ...input(), operationId: 'PRIVATE_MESSAGE_ID' })).rejects.toMatchObject({ code: 'duplicate-operation' });
    const raw = await readFile(path, 'utf8'); expect(raw).not.toContain('PRIVATE_PROMPT'); expect(raw).not.toContain('PRIVATE_MESSAGE_ID');
  });
  it('retains active records when history reaches its limit', async () => {
    const ledger = new TaskLedger(join(await dir(), 'tasks.json'), { maxEntries: 1 });
    const first = await ledger.claimInbound('first', 'chat'); await ledger.markRunning(first.task.id); await ledger.claimInbound('second', 'other');
    expect((await ledger.claimInbound('first', 'chat')).accepted).toBe(false); expect(ledger.snapshot().running).toBe(1);
  });
  it('keeps WeCom legacy hashes and explicit risk replay through its facade', async () => {
    const path = join(await dir(), 'tasks.json'); const legacy = new WeComTaskStore(path);
    const task = await legacy.claimInbound('id', 'chat'); await legacy.annotate(task.task.id, { kind: 'risk' }); await legacy.markRunning(task.task.id);
    const resumed = new WeComTaskStore(path); await resumed.load();
    expect(resumed).toBeInstanceOf(TaskLedger); expect((await resumed.claimInbound('id', 'chat')).replayed).toBe(true);
  });
  it('does not replay running tasks just because they are labelled risk', async () => {
    const path = join(await dir(), 'tasks.json'); const ledger = new TaskLedger(path);
    const task = await ledger.claimInbound('id', 'chat'); await ledger.annotate(task.task.id, { kind: 'risk' }); await ledger.markRunning(task.task.id);
    const resumed = new TaskLedger(path); await resumed.load(); expect((await resumed.claimInbound('id', 'chat')).accepted).toBe(false);
  });
  it('separates identical message ids in different conversation namespaces', async () => {
    const ledger = new TaskLedger(join(await dir(), 'tasks.json'), { namespace: 'lark' });
    const a = await ledger.claimInbound('same', 'a'); const b = await ledger.claimInbound('same', 'b');
    expect(a.task.operationKey).not.toBe(b.task.operationKey); expect(b.accepted).toBe(true);
  });
  it('reads and writes the v0.8 WeCom session-file shape', async () => {
    const path = join(await dir(), 'sessions.json');
    await writeFile(path, JSON.stringify({ chat: { threadId: 'old', updatedAt: new Date().toISOString() } }));
    const store = new WeComSessionStore(path); await store.load(); expect(store.threadId('chat')).toBe('old'); await store.setThread('chat', 'new');
    expect(JSON.parse(await readFile(path, 'utf8')).chat.threadId).toBe('new');
  });
});

describe('core architecture boundary', () => {
  it('has no platform SDK or bot imports', async () => {
    for (const file of (await readdir('src/bridge')).filter((p) => p.endsWith('.ts'))) {
      expect(await readFile(`src/bridge/${file}`, 'utf8'), file).not.toMatch(/from\s+['"](?:@wecom|@larksuite|\.\.\/(?:wecom|bot)\/)/);
    }
  });
  it('routes both WeCom agent entry paths through the shared executor', async () => {
    const cli = await readFile('src/wecom/cli.ts', 'utf8');
    expect(cli).not.toContain('codex.run('); expect(cli.match(/startWeComAgentRun\(runExecutor/g)).toHaveLength(2);
    expect(await readFile('src/runtime/run-executor.ts', 'utf8')).toContain('../bridge/run-executor');
  });
  it('claims WeCom durable receipts before memory deduplication', async () => {
    const cli = await readFile('src/wecom/cli.ts', 'utf8');
    const durableClaim = cli.indexOf('const claim = await taskStore.claimInbound');
    const memoryClaim = cli.indexOf('messageDeduplicator.claim(messageId)');
    expect(durableClaim).toBeGreaterThanOrEqual(0);
    expect(memoryClaim).toBeGreaterThan(durableClaim);
  });
});
