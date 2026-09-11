import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiskApplication } from '../../../src/business/risk/application';
import type { RiskIntentState } from '../../../src/business/risk/intent';
import type { RiskService } from '../../../src/business/risk/client';

const applications: RiskApplication[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });
function setup() {
  const calculatePretrade = vi.fn(async () => ({ status: 'success', result: {} }));
  const app = new RiskApplication({ service: { calculatePretrade } as unknown as RiskService });
  applications.push(app);
  const state: RiskIntentState = { stage: 'confirm', product: '测试账户', originalText: '测试账户申购1000万',
    draft: { accountQuery: '测试账户', action: 'subscription', amountText: '1000万', market: 'secondary' } };
  const request = { key: 'conversation', text: '确认', authorized: true };
  return { app, calculatePretrade, state, request };
}

describe('shared arrival revision fence', () => {
  it.each([true, false])('rejects a draft written after arrival, including a reinstated object: previous=%s', async previous => {
    const { app, calculatePretrade, state, request } = setup();
    if (previous) app.states.setPretrade(request.key, state);
    const arrival = app.markArrival();
    app.states.setPretrade(request.key, state);
    const reply = await app.handle(request, app.capture(request, arrival));
    expect(reply).toMatchObject({ kind: 'notice' });
    expect(calculatePretrade).not.toHaveBeenCalled();
    expect(app.states.getPretrade(request.key)).toBe(state);
  });
  it('allows the original draft after unrelated conversations change', async () => {
    const { app, calculatePretrade, state, request } = setup();
    app.states.setPretrade(request.key, state);
    const arrival = app.markArrival();
    app.states.setPretrade('unrelated-conversation', { ...state });
    expect(await app.handle(request, app.capture(request, arrival))).toMatchObject({ kind: 'result', confirmed: true });
    expect(calculatePretrade).toHaveBeenCalledOnce();
  });
  it('rejects foreign or reused arrival markers without executing a confirmation', async () => {
    const { app, calculatePretrade, state, request } = setup();
    app.states.setPretrade(request.key, state);
    const used = app.markArrival();
    app.capture(request, used).release();
    const other = setup().app;
    for (const arrival of [used, other.markArrival(), { kind: 'risk-arrival' as const }]) {
      expect(await app.handle(request, app.capture(request, arrival))).toMatchObject({ kind: 'notice' });
    }
    expect(calculatePretrade).not.toHaveBeenCalled();
    expect(app.states.getPretrade(request.key)).toBe(state);
  });
});
