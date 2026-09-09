import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { withActiveRun } from '../../../src/wecom/runtime';

// Execute the actual private CLI analyzer without booting a Bot connection.
function setup(start: () => Promise<any>) {
  const source = readFileSync('src/wecom/cli.ts', 'utf8');
  const block = source.slice(source.indexOf('function requestRiskIntentStop('), source.indexOf('async function startRiskIntentFlow('));
  const activeRuns = new Map(), starting = new Set(), stops = new Set();
  const parse = vi.fn(() => ({ action: 'subscription', amountText: '1000万' }));
  const context: any = {
    activeRuns, riskIntentRunsStarting: starting, riskIntentStopRequests: stops,
    startWeComAgentRun: start, riskIntentExecutor: {}, riskIntentWorkspace: '/isolated',
    riskIntentModel: 'gpt-5.5', runGate: { currentPermit: () => undefined },
    randomUUID: () => 'test-run', createRiskTaskId: () => 'task',
    buildRiskIntentPrompt: () => 'private extraction request',
    freshRunState: () => ({ terminal: null }), withActiveRun,
    parseRiskIntentOutputPartial: parse, reportMetric: vi.fn(),
    log: { info: vi.fn() }, Date,
  };
  vm.runInNewContext(ts.transpileModule(block + '\nglobalThis.testApi={analyzeRiskDraft,requestRiskIntentStop};', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return { ...context.testApi, activeRuns, starting, stops, parse };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function run(events: AsyncIterable<any>) {
  return { events, stop: vi.fn(async () => {}), waitForExit: vi.fn(async () => true) };
}
async function* normalEvents() {
  yield { type: 'final_text', content: '{}' };
  yield { type: 'done', terminationReason: 'normal' };
}

describe('risk intent stop lifecycle', () => {
  it('records a stop while the executor is starting and never parses a late result', async () => {
    const pending = deferred<any>(), handle = run(normalEvents());
    const api = setup(() => pending.promise);
    const result = api.analyzeRiskDraft('conversation', 'simulation');
    const rejection = expect(result).rejects.toMatchObject({ name: 'RiskIntentInterruptedError' });
    expect(api.starting.has('conversation')).toBe(true);
    api.requestRiskIntentStop('conversation');
    pending.resolve(handle);
    await rejection;
    expect(handle.stop).toHaveBeenCalled();
    expect(api.parse).not.toHaveBeenCalled();
    expect(api.activeRuns.size).toBe(0);
    expect(api.starting.size).toBe(0);
    expect(api.stops.size).toBe(0);
  });
  it('rejects late JSON after a running conversation is stopped', async () => {
    const gate = deferred<void>();
    const handle = run((async function* () { await gate.promise; yield* normalEvents(); })());
    const api = setup(async () => handle);
    const result = api.analyzeRiskDraft('conversation', 'simulation');
    const rejection = expect(result).rejects.toMatchObject({ name: 'RiskIntentInterruptedError' });
    await vi.waitFor(() => expect(api.activeRuns.has('conversation')).toBe(true));
    api.requestRiskIntentStop('conversation');
    api.activeRuns.get('conversation').state.terminal = 'interrupted';
    gate.resolve();
    await rejection;
    expect(handle.stop).toHaveBeenCalled();
    expect(api.parse).not.toHaveBeenCalled();
    expect(api.activeRuns.size).toBe(0);
  });
  it('does not accept JSON when the model reports an interrupted terminal event', async () => {
    const handle = run((async function* () { yield { type: 'final_text', content: '{}' }; yield { type: 'done', terminationReason: 'interrupted' }; })());
    const api = setup(async () => handle);
    await expect(api.analyzeRiskDraft('conversation', 'simulation')).rejects.toMatchObject({ name: 'RiskIntentInterruptedError' });
    expect(api.parse).not.toHaveBeenCalled();
  });
  it('returns a normal result and releases conversation bookkeeping', async () => {
    const api = setup(async () => run(normalEvents()));
    await expect(api.analyzeRiskDraft('conversation', 'simulation')).resolves.toMatchObject({ action: 'subscription' });
    expect(api.parse).toHaveBeenCalledOnce();
    expect(api.activeRuns.size).toBe(0);
    expect(api.starting.size).toBe(0);
  });
});
