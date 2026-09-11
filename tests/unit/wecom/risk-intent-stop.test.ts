import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRiskBusinessRuntime, type RiskBusinessRuntime, type RiskBusinessRuntimeOptions, type RiskRuntimeClient } from '../../../src/runtime/risk-business';
import { businessConversationKey, businessConversationScope } from '../../../src/business/identity';
import { ProcessPool } from '../../../src/bridge/process-pool';
import { ActiveRuns } from '../../../src/bridge/active-runs';
import type { AgentAdapter, AgentEvent, AgentRun } from '../../../src/agent/types';
import * as intent from '../../../src/business/risk/intent';

const runtimes: RiskBusinessRuntime[] = [], roots: string[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function run(events: AsyncIterable<AgentEvent>): AgentRun {
  return { runId: 'test-run', events, stop: vi.fn(async () => {}), waitForExit: vi.fn(async () => true) };
}
async function* normalEvents(): AsyncIterable<AgentEvent> {
  yield { type: 'final_text', content: '{}' };
  yield { type: 'done', terminationReason: 'normal' };
}

// Evaluate only the actual CLI composition callbacks and stop function, never CLI startup.
async function setup(handle: AgentRun, prepare: () => Promise<void> = async () => {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'wecom-shared-stop-')); roots.push(stateDir);
  const source = readFileSync('src/wecom/cli.ts', 'utf8');
  const composition = source.slice(source.indexOf('const riskRuntime = createRiskBusinessRuntime('), source.indexOf('const riskClient ='));
  const stopFunction = source.slice(source.indexOf('function requestRiskIntentStop('), source.indexOf('class RiskIntentInterruptedError'));
  const activeRuns = new Map(), starting = new Set(), stops = new Set();
  const parse = vi.spyOn(intent, 'parseRiskIntentOutputPartial').mockImplementation(() => (
    { accountQuery: '测试账户', action: 'subscription', amountText: '1000万', market: 'secondary' }
  ));
  const spawn = vi.fn(() => handle);
  const agent: AgentAdapter = { id: 'codex', displayName: 'test', isAvailable: async () => true, prepareRun: prepare, run: spawn };
  const client = {
    listProducts: async () => ['测试账户'], searchSecurities: async () => [],
    prewarm: async () => {}, close: async () => {}, runtimeStatus: () => ({ ready: false }),
  } as unknown as RiskRuntimeClient;
  const context: Record<string, any> = {
    activeRuns, riskIntentRunsStarting: starting, riskIntentStopRequests: stops,
    stateDir, botId: 'test-bot', runGate: { pool: new ProcessPool(() => 1) }, agentRuns: new ActiveRuns(),
    process: { env: {} }, riskAccessLocked: false, riskSelectionTasks: { clearConversation: vi.fn() },
    businessConversationScope, freshRunState: () => ({ terminal: null }), createRiskTaskId: () => 'task',
    createRiskBusinessRuntime: (options: RiskBusinessRuntimeOptions) => {
      const runtime = createRiskBusinessRuntime({ ...options, rootDir: stateDir, clientFactory: () => client, intentAgent: agent });
      runtimes.push(runtime); return runtime;
    },
  };
  vm.runInNewContext(ts.transpileModule(composition + '\nconst riskApplication = riskRuntime.application;\n' +
    stopFunction + '\nglobalThis.testApi = {runtime: riskRuntime, requestRiskIntentStop};', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const runtime = context.testApi.runtime as RiskBusinessRuntime;
  const key = businessConversationKey({ channel: 'wecom', accountId: 'test-bot', instanceId: stateDir }, 'conversation', 'owner');
  return { runtime, start: () => runtime.application.handle({ key, text: '/测算 不完整的新交易', authorized: true }),
    requestStop: () => context.testApi.requestRiskIntentStop('conversation'), activeRuns, starting, stops, parse, spawn };
}

describe('risk intent stop lifecycle through shared runtime', () => {
  it('records a stop during preparation and never spawns or parses a late result', async () => {
    const pending = deferred<void>(), handle = run(normalEvents()), entered = vi.fn();
    const api = await setup(handle, async () => { entered(); await pending.promise; });
    const result = api.start();
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    expect(api.starting.has('conversation')).toBe(true);
    api.requestStop(); pending.resolve();
    expect(await result).toMatchObject({ kind: 'notice', title: '风险交互已停止' });
    expect(api.spawn).not.toHaveBeenCalled();
    expect(api.parse).not.toHaveBeenCalled();
    expect(api.activeRuns.size).toBe(0); expect(api.starting.size).toBe(0); expect(api.stops.size).toBe(0);
  });
  it('rejects late JSON after a running conversation is stopped', async () => {
    const gate = deferred<void>();
    const handle = run((async function* () { await gate.promise; yield* normalEvents(); })());
    const api = await setup(handle), result = api.start();
    await vi.waitFor(() => expect(api.activeRuns.has('conversation')).toBe(true));
    api.requestStop(); gate.resolve();
    expect(await result).toMatchObject({ kind: 'notice', title: '风险交互已停止' });
    expect(handle.stop).toHaveBeenCalled(); expect(api.parse).not.toHaveBeenCalled();
    expect(api.activeRuns.size).toBe(0); expect(api.starting.size).toBe(0);
  });
  it('does not accept JSON when the model reports an interrupted terminal event', async () => {
    const handle = run((async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'final_text', content: '{}' }; yield { type: 'done', terminationReason: 'interrupted' };
    })());
    const api = await setup(handle);
    expect(await api.start()).toMatchObject({ kind: 'notice', title: '风险交互已停止' });
    expect(api.parse).not.toHaveBeenCalled();
  });
  it('returns a normal confirmation draft and releases channel bookkeeping', async () => {
    const api = await setup(run(normalEvents()));
    expect(await api.start()).toMatchObject({ kind: 'intent', state: { stage: 'confirm' } });
    expect(api.parse).toHaveBeenCalledOnce();
    expect(api.activeRuns.size).toBe(0); expect(api.starting.size).toBe(0);
  });
});
