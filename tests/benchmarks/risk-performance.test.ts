import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()), spawn: mocks.spawn,
}));
import { RiskDirectClient } from '../../src/wecom/risk/client';
import * as intent from '../../src/wecom/risk/intent';
import { WeComRiskRouter } from '../../src/wecom/risk/router';
const product = '安联ESG纯债1号资产管理产品';
const security = { name: '国债0115', code: '100115.SZ', label: '国债0115 100115.SZ' };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Counts = Record<string, number>;
function setup() {
  const counts: Counts = {};
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null,
    kill() { this.exitCode = 0; queueMicrotask(() => child.emit('exit', 0, null)); return true; },
  });
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += String(chunk);
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const request = JSON.parse(line);
      counts[request.method] = (counts[request.method] || 0) + 1;
      const delay = request.method === 'list_products' ? 10 : request.method === 'search_securities' ? 20 : 30;
      void sleep(delay).then(() => {
        const data = request.method === 'list_products' ? { products: [product] }
          : request.method === 'search_securities' ? { suggestions: [security] }
          : { status: 'success', result: { comparison: [], before: {}, after: {} } };
        child.stdout.write(JSON.stringify({ id: request.id, type: 'result', data }) + '\n');
      });
    }
  });
  mocks.spawn.mockImplementation(() => { queueMicrotask(() => child.stdout.write('{"type":"ready"}\n')); return child; });
  const service = new RiskDirectClient({ pythonPath: '/fixture/python', serviceDir: '/fixture/service', stateDir: '/fixture/state', bridgePath: '/fixture/bridge' });
  return { service, counts };
}
it.skipIf(!process.env.RISK_BENCHMARK)('records controlled bridge benchmark (not live AI/database)', async () => {
  const optimized = typeof (intent as Record<string, unknown>).resolveInitialRiskIntent === 'function';
  expect(optimized).toBe(process.env.RISK_BENCHMARK === 'after');
  const rows: Array<Record<string, unknown>> = [];
  for (const scenario of ['first', 'warm', 'amount-correction', 'concurrent-products']) {
    for (let sample = 0; sample < 10; sample++) {
      const { service, counts } = setup();
      const router = new WeComRiskRouter(service);
      const text = product + ' 买入 1000万 100115.SZ';
      const analyze = async () => {
        counts.ai = (counts.ai || 0) + 1; await sleep(40);
        return { accountQuery: product, action: 'buy' as const, securityQuery: security.code, amountText: '1000万', market: 'secondary' as const };
      };
      const initial = async () => optimized
        ? await (intent as any).resolveInitialRiskIntent(text, service, analyze)
        : await intent.normalizeRiskDraft(text, await analyze(), service);
      const confirm = async (state: any) => {
        expect(state.stage).toBe('confirm');
        const result = optimized
          ? await (router as any).executeConfirmed(state)
          : await router.handle('benchmark', intent.canonicalCommand(state));
        expect(result).toMatchObject({ handled: true, intent: 'pretrade_calc' });
      };
      let state: any;
      if (scenario === 'warm') await confirm(await initial());
      if (scenario === 'amount-correction') state = await initial();
      for (const key of Object.keys(counts)) delete counts[key];
      const start = performance.now();
      if (scenario === 'concurrent-products') {
        await Promise.all(Array.from({ length: 8 }, () => service.listProducts()));
      } else if (scenario === 'amount-correction') {
        if (optimized) state = (intent as any).applySimpleRiskCorrection(state, '金额改成2000万');
        else {
          const revised = await analyze();
          state = await intent.normalizeRiskDraft(text + ' 金额改成2000万', intent.mergeRiskIntentDraft(state.draft, revised, '金额改成2000万'), service);
        }
        await confirm(state);
      } else await confirm(await initial());
      rows.push({ scenario, sample, durationMs: performance.now() - start, counts: { ...counts } });
      await service.close();
    }
  }
  const label = process.env.RISK_BENCHMARK;
  expect(['before', 'after']).toContain(label);
  const summary = ['first', 'warm', 'amount-correction', 'concurrent-products'].map(scenario => {
    const selected = rows.filter(row => row.scenario === scenario);
    const times = selected.map(row => row.durationMs as number).sort((a, b) => a - b);
    return { scenario, medianMs: (times[4]! + times[5]!) / 2, p95Ms: times[9], counts: selected[0]!.counts };
  });
  const report = {
    label, optimized, recordedAt: new Date().toISOString(),
    kind: 'controlled integration benchmark; fake Python transport and fake AI; no live database or platform',
    delaysMs: { products: 10, securities: 20, calculation: 30, ai: 40 },
    samplesPerScenario: 10, summary, rows,
  };
  mkdirSync('docs/benchmarks', { recursive: true });
  writeFileSync('docs/benchmarks/risk-' + label + '.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ label, summary }));
}, 30000);
