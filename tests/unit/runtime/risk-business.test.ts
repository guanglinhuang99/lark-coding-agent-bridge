import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRiskBusinessRuntime, type RiskBusinessRuntime, type RiskBusinessRuntimeOptions, type RiskRuntimeClient } from '../../../src/runtime/risk-business';
import { ProcessPool } from '../../../src/bridge/process-pool';
import { ActiveRuns } from '../../../src/bridge/active-runs';
import { businessConversationKey } from '../../../src/business/identity';
import { RiskApplication } from '../../../src/business/risk/application';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { AgentAdapter, AgentEvent } from '../../../src/agent/types';
import type { RiskRuntimeConfig } from '../../../src/business/risk/runtime';

const roots: string[] = [], runtimes: RiskBusinessRuntime[] = [];
const final: AgentEvent[] = [{ type: 'final_text', content: JSON.stringify({
  account_query: '测试账户', action: 'subscription', amount_text: '1000万', market: 'secondary',
}) }, { type: 'done', terminationReason: 'normal' }];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function setup(channel: 'lark' | 'wecom' = 'wecom', overrides: Partial<RiskBusinessRuntimeOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'risk-runtime-contract-')); roots.push(dir);
  let ready = false;
  const client: RiskRuntimeClient = {
    prewarm: vi.fn(async () => { ready = true; }), close: vi.fn(async () => { ready = false; }),
    runtimeStatus: vi.fn(() => ({ ready })), listProducts: vi.fn(async () => ['测试账户']),
    searchSecurities: vi.fn(async () => []), checkSecurity: vi.fn(async () => ({})),
    checkCounterparty: vi.fn(async () => ({})), getHoldings: vi.fn(async () => ({})),
    getRestrictions: vi.fn(async () => ({ investment_restrictions: [] })),
    getCredit: vi.fn(async () => ({ date: '2026-09-11', entity: '主体' })), calculatePretrade: vi.fn(async () => ({})),
  };
  const identity = { channel, accountId: 'bot', instanceId: 'test' };
  const agent = new FakeAgentAdapter({ id: 'codex', events: final });
  const pool = new ProcessPool(() => 1), activeRuns = new ActiveRuns();
  const factory = vi.fn((_config: RiskRuntimeConfig) => client);
  const options: RiskBusinessRuntimeOptions = { identity, stateDir: dir, rootDir: dir, pool, activeRuns,
    env: {}, accessEnabled: () => true, clientFactory: factory, intentAgent: agent, ...overrides };
  const runtime = createRiskBusinessRuntime(options); runtimes.push(runtime);
  const key = businessConversationKey(identity, 'room', 'owner');
  const analyze = (signal = new AbortController().signal) => runtime.analyze({ key, originalText: '测试账户申购1000万', signal });
  return { runtime, client, agent, pool, activeRuns, factory, analyze, key };
}
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe.each(['wecom', 'lark'] as const)('shared business runtime: %s', channel => {
  it('constructs exactly one client without starting a process, prewarm or Agent', async () => {
    const api = await setup(channel);
    expect(api.factory).toHaveBeenCalledOnce();
    expect(api.client.prewarm).not.toHaveBeenCalled();
    expect(api.agent.runOptions).toHaveLength(0);
    expect(api.runtime.snapshot()).toMatchObject({ enabled: true, runtime: { ready: false }, warmup: { phase: 'idle' } });
  });
  it('coalesces simultaneous startup and reconnect warmups', async () => {
    const api = await setup(channel), started = deferred<void>();
    vi.mocked(api.client.prewarm).mockImplementation(() => started.promise);
    const first = api.runtime.start(), second = api.runtime.start();
    expect(first).toBe(second);
    expect(api.runtime.snapshot().warmup.phase).toBe('running');
    started.resolve(); await Promise.all([first, second]);
    expect(api.client.prewarm).toHaveBeenCalledOnce();
    expect(api.client.listProducts).toHaveBeenCalledOnce();
    expect(api.runtime.snapshot().warmup).toMatchObject({ phase: 'ready', products: 1 });
  });
  it('reports warmup failures and retries through the same client on the next connection', async () => {
    const api = await setup(channel);
    vi.mocked(api.client.prewarm).mockRejectedValueOnce(new Error('PRIVATE_CONNECTION_FAILURE'));
    await api.runtime.start();
    expect(api.runtime.snapshot().warmup.phase).toBe('failed');
    expect(api.client.listProducts).not.toHaveBeenCalled();
    expect(JSON.stringify(api.runtime.snapshot())).not.toContain('PRIVATE');
    await api.runtime.start();
    expect(api.runtime.snapshot().warmup.phase).toBe('ready');
    expect(api.factory).toHaveBeenCalledOnce();
  });
  it('never prewarms while the channel permission gate is locked', async () => {
    let allowed = false;
    const api = await setup(channel, { accessEnabled: () => allowed });
    await api.runtime.start();
    expect(api.client.prewarm).not.toHaveBeenCalled();
    expect(api.client.listProducts).not.toHaveBeenCalled();
    expect(api.runtime.snapshot().warmup.phase).toBe('disabled');
    allowed = true; await api.runtime.start();
    expect(api.client.prewarm).toHaveBeenCalledOnce();
  });
  it('honors the same RISK_PREWARM=0 setting without disabling direct queries', async () => {
    const api = await setup(channel, { env: { RISK_PREWARM: '0' } });
    await api.runtime.start();
    expect(api.client.prewarm).not.toHaveBeenCalled();
    await api.runtime.application.handle({ key: api.key, text: '/测算 测试账户有哪些风险限额', authorized: true });
    expect(api.client.getRestrictions).toHaveBeenCalledWith('测试账户');
    expect(api.agent.runOptions).toHaveLength(0);
  });
  it('closes once and never continues warmup or restarts after shutdown', async () => {
    const api = await setup(channel), started = deferred<void>();
    vi.mocked(api.client.prewarm).mockImplementation(() => started.promise);
    const warming = api.runtime.start();
    await vi.waitFor(() => expect(api.client.prewarm).toHaveBeenCalledOnce());
    const first = api.runtime.close(), second = api.runtime.close();
    expect(first).toBe(second);
    started.resolve(); await Promise.all([warming, first, second]);
    await api.runtime.start();
    expect(api.client.close).toHaveBeenCalledOnce();
    expect(api.client.listProducts).not.toHaveBeenCalled();
    expect(api.runtime.snapshot()).toMatchObject({ enabled: false, reason: 'closed', runtime: { ready: false }, warmup: { phase: 'closed' } });
  });
  it('uses identical extraction policy and reuses a capacity-one outer permit', async () => {
    const api = await setup(channel, { env: { RISK_INTENT_MODEL: 'shared-test-model' } });
    await api.pool.run(async () => {
      expect(await api.analyze()).toMatchObject({ action: 'subscription' });
      expect(api.pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    });
    expect(api.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    expect(api.activeRuns.scopes()).toEqual([]);
    expect(api.agent.runOptions[0]).toMatchObject({ model: 'shared-test-model', reasoningEffort: 'low', sandbox: 'read-only' });
    expect(api.runtime.snapshot().intent.active).toBe(0);
  });
});

describe('common runtime cancellation and ownership', () => {
  it('cancels queued admission without starting an Agent when the slot later opens', async () => {
    const api = await setup(), controller = new AbortController();
    const release = await api.pool.acquire();
    const pending = api.analyze(controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'RiskIntentInterruptedError' });
    await vi.waitFor(() => expect(api.pool.snapshot().waiting).toBe(1));
    controller.abort(); await rejection;
    expect(api.pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    release();
    expect(api.agent.runOptions).toHaveLength(0);
    expect(api.activeRuns.scopes()).toEqual([]);
  });
  it('rechecks cancellation after asynchronous Agent preparation, before spawn', async () => {
    const prepared = deferred<void>(), entered = vi.fn();
    const agent = new FakeAgentAdapter({ events: final });
    const custom: AgentAdapter = { id: 'codex', displayName: 'fake', isAvailable: async () => true,
      prepareRun: async () => { entered(); await prepared.promise; }, run: options => agent.run(options) };
    const api = await setup('lark', { intentAgent: custom }), controller = new AbortController();
    const pending = api.analyze(controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'RiskIntentInterruptedError' });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    controller.abort(); prepared.resolve(); await rejection;
    expect(agent.runOptions).toHaveLength(0);
    expect(api.pool.snapshot().active).toBe(0);
  });
  it('closes its own pending admission without closing a pool used by other tasks', async () => {
    const api = await setup(), release = await api.pool.acquire();
    const pending = api.analyze(), rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(api.pool.snapshot().waiting).toBe(1));
    await api.runtime.close(); await rejection;
    expect(api.pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    release(); const another = await api.pool.acquire(); another();
  });
  it('never constructs a client for an injected application', async () => {
    const application = new RiskApplication({}), factory = vi.fn();
    const api = await setup('lark', { application, clientFactory: factory });
    expect(api.runtime.application).toBe(application);
    await api.runtime.start(); await api.runtime.close();
    expect(factory).not.toHaveBeenCalled();
  });
  it('keeps lifecycle observers from changing business outcomes', async () => {
    const settled = vi.fn();
    const api = await setup('wecom', { intentLifecycle: {
      starting: () => { throw new Error('view unavailable'); },
      started: () => () => { throw new Error('view cleanup unavailable'); }, settled,
    } });
    expect(await api.analyze()).toMatchObject({ action: 'subscription' });
    expect(settled).toHaveBeenCalledOnce();
    expect(api.pool.snapshot().active).toBe(0);
  });
  it('both channel entrypoints use the common factory and have no private risk constructors or warmup chains', () => {
    const wecom = readFileSync('src/wecom/cli.ts', 'utf8');
    const lark = readFileSync('src/bot/risk-adapter.ts', 'utf8');
    for (const source of [wecom, lark]) {
      expect(source).toContain('createRiskBusinessRuntime(');
      expect(source).not.toMatch(/new (?:RiskDirectClient|RiskApplication|WeComRiskRouter|RiskStateRegistry)\(/);
      expect(source).not.toContain('.prewarm()');
    }
    expect(wecom).not.toMatch(/analyzeRiskDraft|riskIntentExecutor|warmRiskService/);
    expect(wecom).toContain('riskFastPath: riskRuntime.snapshot()');
    expect(wecom).toContain('riskRuntime.close()');
    const channel = readFileSync('src/bot/channel.ts', 'utf8');
    expect(channel).toContain('riskAdapter.start?.()');
    expect(channel).toContain('riskAdapter.close()');
  });
});
