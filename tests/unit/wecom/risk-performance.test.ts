import { describe, expect, it, vi } from 'vitest';
import { parseDirectRiskDraft, resolveInitialRiskIntent, applySimpleRiskCorrection, type RiskIntentState } from '../../../src/wecom/risk/intent';
import type { RiskService } from '../../../src/wecom/risk/client';
import { WeComRiskRouter } from '../../../src/wecom/risk/router';
import { RiskProgressRelay } from '../../../src/wecom/risk/progress';

const product = '安联ESG纯债1号资产管理产品';
const security = { code: '100115.SZ', name: '国债0115', label: '国债0115 100115.SZ' };
function service(): RiskService {
  return {
    listProducts: vi.fn(async () => [product]),
    searchSecurities: vi.fn(async () => [security]),
    calculatePretrade: vi.fn(async () => ({ status: 'success', result: {} })),
    getHoldings: vi.fn(async () => ({})), getRestrictions: vi.fn(async () => ({})),
    getCredit: vi.fn(async () => ({})), checkSecurity: vi.fn(async () => ({})),
    checkCounterparty: vi.fn(async () => ({})),
  };
}
const confirmed = (): Extract<RiskIntentState, { stage: 'confirm' }> => ({
  stage: 'confirm', originalText: product + ' 买入 1000万 100115.SZ', product, security,
  draft: { accountQuery: product, action: 'buy', market: 'secondary', amountText: '1000万', securityQuery: security.code },
});
describe('risk performance behavior', () => {
  it('resolves a complete command without AI and retains confirmation', async () => {
    const backend = service(); const ai = vi.fn();
    const state = await resolveInitialRiskIntent(confirmed().originalText, backend, ai);
    expect(state).toMatchObject({ stage: 'confirm', product, security });
    expect(ai).not.toHaveBeenCalled();
    expect(backend.listProducts).toHaveBeenCalledTimes(1);
    expect(backend.searchSecurities).toHaveBeenCalledTimes(1);
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
  });
  it.each([
    '买入一点国债，产品用之前那个',
    product + ' 买入 -1000万 100115.SZ',
    product + ' 买入 0万 100115.SZ',
    product + ' 买入 1000万 100115.SZ 然后卖出一半',
    '不要' + product + ' 买入 1000万 100115.SZ',
    product + ' 买入 1000万 国债',
    product + ' 逆回购 100股 7天',
  ])('keeps uncertain/invalid text off the deterministic path: %s', text => {
    expect(parseDirectRiskDraft(text, [product])).toBeUndefined();
  });
  it('uses AI fallback once for free prose and reuses the product lookup', async () => {
    const backend = service();
    const ai = vi.fn(async () => confirmed().draft);
    expect(await resolveInitialRiskIntent('请用纯债账户买点国债，一千万', backend, ai)).toMatchObject({ stage: 'confirm' });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(backend.listProducts).toHaveBeenCalledTimes(1);
  });
  it('submits confirmed identifiers without another product/security lookup', async () => {
    const backend = service();
    const result = await new WeComRiskRouter(backend).executeConfirmed(confirmed());
    expect(result).toMatchObject({ handled: true, intent: 'pretrade_calc' });
    expect(backend.listProducts).not.toHaveBeenCalled();
    expect(backend.searchSecurities).not.toHaveBeenCalled();
    expect(backend.calculatePretrade).toHaveBeenCalledWith(product,
      { type: 'buy', market: 'secondary', amount: 0.1, security_name: security.code }, undefined);
  });
  it('retains primary-subscription security in the structured action', async () => {
    const backend = service(); const state = confirmed();
    state.draft = { ...state.draft, action: 'subscription', market: 'primary' };
    await new WeComRiskRouter(backend).executeConfirmed(state);
    expect(backend.calculatePretrade).toHaveBeenCalledWith(product,
      { type: 'subscription', market: 'primary', amount: 0.1, security_name: security.code }, undefined);
  });
  it('refuses unresolved identifiers and invalid amounts', async () => {
    const backend = service(); const router = new WeComRiskRouter(backend);
    await router.executeConfirmed({ ...confirmed(), security: undefined });
    await router.executeConfirmed({ ...confirmed(), draft: { ...confirmed().draft, amountText: '0元' } });
    await router.executeConfirmed({ ...confirmed(), draft: { ...confirmed().draft, amountText: '-1000万' } });
    await router.executeConfirmed({ ...confirmed(), draft: { ...confirmed().draft, amountText: '1000万或2000万' } });
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
  });
  it('reuses unchanged fields for a simple correction, with another confirmation', () => {
    const state = confirmed();
    const changed = applySimpleRiskCorrection(state, '金额改成2000万');
    expect(changed).toMatchObject({ stage: 'confirm', security, product, draft: { amountText: '2000万' } });
    expect(state.draft.amountText).toBe('1000万');
    expect(applySimpleRiskCorrection(state, '金额改成2000万，证券改成600519.SH')).toBeUndefined();
    expect(applySimpleRiskCorrection(state, '金额改成-1000万')).toBeUndefined();
  });
  it('does not cache calculation results across repeated confirmation calls', async () => {
    const backend = service(); const router = new WeComRiskRouter(backend);
    await router.executeConfirmed(confirmed()); await router.executeConfirmed(confirmed());
    expect(backend.calculatePretrade).toHaveBeenCalledTimes(2);
  });
  it('coalesces progress and prevents queued updates following final delivery', async () => {
    const sent: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const relay = new RiskProgressRelay(async message => { await blocked; sent.push(message); }, undefined, { coalesce: true });
    relay.push('first'); await Promise.resolve();
    relay.push('old'); relay.push('latest');
    const done = relay.finish().then(() => { sent.push('FINAL'); });
    release(); await done; relay.push('too late');
    expect(sent).toEqual(['first', 'FINAL']);
  });
});
