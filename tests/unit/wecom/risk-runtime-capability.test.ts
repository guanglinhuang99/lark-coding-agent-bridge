import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()), spawn: mocks.spawn,
}));
import { RiskDirectClient, type RiskBusinessCapabilities } from '../../../src/wecom/risk/client';
import { inspectWeComHealth, WeComHealthStore } from '../../../src/wecom/health';

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  constructor(readonly pid: number) { super(); }
  kill = vi.fn(() => {
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  });
}
const ready = (optimized = true) => ({
  shared_text_memoization: optimized ? 'optimized' : 'unoptimized',
  functions: Object.fromEntries(['clean_text', 'normalize_product_name'].map((name) =>
    [name, { optimized, max_entries: optimized ? 4096 : null }])),
});
const clients: RiskDirectClient[] = [];
const roots: string[] = [];
function client(callback?: (value: RiskBusinessCapabilities) => void) {
  const service = new RiskDirectClient({
    pythonPath: '/fixture/python', serviceDir: '/fixture/backend', stateDir: '/fixture/state',
    bridgePath: '/fixture/bridge', onBusinessCapabilities: callback,
    intranetProbe: async () => { throw new Error('diagnostics must not probe intranet'); },
  });
  clients.push(service);
  return service;
}
function child(pid: number, capabilities: unknown = ready()) {
  const process = new Child(pid);
  mocks.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => process.stdout.write(JSON.stringify({ type: 'ready', business_capabilities: capabilities }) + '\n'));
    return process;
  });
  return process;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  mocks.spawn.mockReset();
});

describe('risk runtime capability evidence', () => {
  it('reports only the ready current child and protects the stored metadata from mutation', async () => {
    child(101);
    const service = client((value) => { value.sharedTextMemoization = 'unoptimized'; });
    expect(service.runtimeStatus()).toEqual({ ready: false });
    await service.prewarm();
    const status = service.runtimeStatus();
    expect(status).toMatchObject({ ready: true, processId: 101, businessCapabilities: { sharedTextMemoization: 'optimized' } });
    status.businessCapabilities!.functions.clean_text!.maxEntries = 1;
    expect(service.runtimeStatus().businessCapabilities?.functions.clean_text?.maxEntries).toBe(4096);
    await service.close();
    expect(service.runtimeStatus()).toEqual({ ready: false });
  });

  it('does not claim optimization when an older bridge has no metadata', async () => {
    child(102, null);
    const service = client();
    await service.prewarm();
    expect(service.runtimeStatus()).toEqual({ ready: true, processId: 102 });
  });

  it('retains explicit unoptimized status without blocking readiness', async () => {
    child(103, ready(false));
    const service = client();
    await service.prewarm();
    expect(service.runtimeStatus().businessCapabilities?.sharedTextMemoization).toBe('unoptimized');
  });

  it.each([0, -1, 1.5, null, '4096', Number.MAX_SAFE_INTEGER + 1])('rejects invalid optimized cache limit %s without blocking startup', async (bound) => {
    const metadata = ready();
    (metadata.functions.clean_text as { max_entries: unknown }).max_entries = bound;
    child(104, metadata);
    const service = client();
    await service.prewarm();
    expect(service.runtimeStatus()).toEqual({ ready: true, processId: 104 });
  });

  it('rejects inconsistent aggregate capability status', async () => {
    child(105, { ...ready(false), shared_text_memoization: 'optimized' });
    const service = client();
    await service.prewarm();
    expect(service.runtimeStatus()).toEqual({ ready: true, processId: 105 });
  });

  it('clears exited-child evidence and fences late ready events after replacement', async () => {
    const old = child(106);
    const service = client();
    await service.prewarm();
    const lines = (service as unknown as { lines: EventEmitter }).lines;
    const late = lines.listeners('line')[0]!;
    old.exitCode = 0;
    old.emit('exit', 0, null);
    expect(service.runtimeStatus()).toEqual({ ready: false });
    child(107, ready(false));
    await service.prewarm();
    late(JSON.stringify({ type: 'ready', business_capabilities: ready() }));
    expect(service.runtimeStatus()).toMatchObject({ processId: 107, businessCapabilities: { sharedTextMemoization: 'unoptimized' } });
  });

  it('writes loaded capability evidence to health and removes it when the child stops', async () => {
    const process = child(108);
    const service = client();
    await service.prewarm();
    const root = await mkdtemp(join(tmpdir(), 'risk-runtime-health-')); roots.push(root);
    const path = join(root, 'health.json');
    const store = new WeComHealthStore(path, 109);
    const update = () => store.update({ phase: 'connected', connected: true, activeRuns: 0, startingRuns: 0,
      riskFastPath: { enabled: true, serviceDirConfigured: true, pythonConfigured: true, runtime: service.runtimeStatus() } });
    await update();
    const inspect = () => inspectWeComHealth(path, { staleAfterMs: 90000, isProcessAlive: () => true });
    expect((await inspect()).snapshot?.riskFastPath?.runtime?.businessCapabilities?.sharedTextMemoization).toBe('optimized');
    process.exitCode = 0; process.emit('exit', 0, null);
    await update();
    expect((await inspect()).snapshot?.riskFastPath?.runtime).toEqual({ ready: false });
  });

  it('initializes the risk client before the first health snapshot', async () => {
    const source = await readFile(new URL('../../../src/wecom/cli.ts', import.meta.url), 'utf8');
    expect(source.indexOf('await refreshHealth();')).toBeGreaterThan(source.indexOf('const riskClient ='));
    expect(source).toContain('riskFastPath: riskRuntime.snapshot()');
    const runtime = await readFile(new URL('../../../src/runtime/risk-business.ts', import.meta.url), 'utf8');
    expect(runtime).toContain('client.runtimeStatus()');
  });
});
