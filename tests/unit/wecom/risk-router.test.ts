import { describe, expect, it, vi } from 'vitest';
import type {
  RiskPretradeAction,
  RiskSecuritySuggestion,
  RiskService,
} from '../../../src/wecom/risk/client';
import { WeComRiskRouter } from '../../../src/wecom/risk/router';

describe('WeCom risk fast-path router', () => {
  it('handles a complete pretrade query without an agent', async () => {
    const calculatePretrade = vi.fn(
      async (_product: string, _action: RiskPretradeAction) => successfulCalculation(),
    );
    const service = fakeService({ calculatePretrade });
    const router = new WeComRiskRouter(service);

    expect(router.shouldHandle('single:u1', '安联ESG纯债1号 申购 0.1', false)).toBe(true);
    const result = await router.handle('single:u1', '安联ESG纯债1号 申购 0.1');

    expect(result).toMatchObject({ handled: true, intent: 'pretrade_calc' });
    if (result.handled) expect(result.markdown).toContain('未写单位，按亿元');
    expect(calculatePretrade).toHaveBeenCalledWith(
      '安联ESG纯债1号资产管理产品',
      { type: 'subscription', amount: 0.1 },
      undefined,
    );
  });

  it('requires a product before checking a counterparty', async () => {
    const checkCounterparty = vi.fn(async () => ({ hit: false }));
    const router = new WeComRiskRouter(fakeService({ checkCounterparty }));
    const result = await router.handle('single:u1', '交易对手 某某公司 是不是关联方');

    expect(result).toMatchObject({ handled: true });
    if (result.handled) expect(result.markdown).toContain('还差产品名');
    expect(checkCounterparty).not.toHaveBeenCalled();
  });

  it('keeps security disambiguation on the zero-token path', async () => {
    const checkSecurity = vi.fn(async () => ({ hit: false }));
    const router = new WeComRiskRouter(
      fakeService({
        checkSecurity,
        searchSecurities: async () => [
          { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
        ],
      }),
    );

    const first = await router.handle('single:u1', '安联ESG纯债1号 能不能买 国债0115');
    expect(first).toMatchObject({ handled: true, intent: 'check_security' });
    expect(router.shouldHandle('single:u1', '确认', false)).toBe(true);

    const second = await router.handle('single:u1', '确认');
    if (second.handled) expect(second.markdown).toContain('未命中');
    expect(checkSecurity).toHaveBeenCalledWith(
      '安联ESG纯债1号资产管理产品',
      '019115.SH',
    );
  });

  it('accepts a missing security in a deterministic follow-up', async () => {
    const router = new WeComRiskRouter(fakeService());
    const first = await router.handle('single:u2', '安联ESG纯债1号 买 0.1');
    if (first.handled) expect(first.markdown).toContain('证券名称或代码');
    expect(router.shouldHandle('single:u2', '国债0115', false)).toBe(true);

    const second = await router.handle('single:u2', '国债0115');
    expect(second).toMatchObject({ handled: true, intent: 'pretrade_calc' });
    if (second.handled) expect(second.markdown).toContain('本笔投资未引发新增超限');
  });

  it('keeps an expired selection reply off the agent path', async () => {
    let now = 1_000;
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(
      fakeService({
        calculatePretrade,
        searchSecurities: async () => [
          { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
          { name: '国债0116', code: '019116.SH', label: '国债0116 019116.SH' },
        ],
      }),
      { pendingTtlMs: 100, now: () => now },
    );

    const first = await router.handle('single:u3', '安联ESG纯债1号 买 0.1 国债');
    if (first.handled) expect(first.markdown).toContain('请选择证券');

    now += 101;
    expect(router.shouldHandle('single:u3', '1', false)).toBe(true);
    const expired = await router.handle('single:u3', '1');
    expect(expired).toMatchObject({ handled: true, intent: 'pretrade_calc' });
    if (expired.handled) {
      expect(expired.markdown).toContain('选择已过期');
      expect(expired.markdown).toContain('未调用 AI');
    }
    expect(calculatePretrade).not.toHaveBeenCalled();
  });

  it('auto-selects an exact security code from fuzzy search results', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(
      fakeService({
        calculatePretrade,
        searchSecurities: async () => [
          { name: '国债0115', code: '100115.SZ', label: '国债0115 100115.SZ' },
          { name: '国债0115相近项', code: '100115.SH', label: '国债0115相近项 100115.SH' },
        ],
      }),
    );

    const result = await router.handle('single:u4', '安联ESG纯债1号 买 0.1 100115.sz');

    if (result.handled) expect(result.markdown).toContain('本笔投资未引发新增超限');
    expect(calculatePretrade).toHaveBeenCalledWith(
      '安联ESG纯债1号资产管理产品',
      { type: 'buy', amount: 0.1, security_name: '100115.SZ' },
      undefined,
    );
  });

  it('handles a pending security selection without refreshing the product list', async () => {
    let now = 1_000;
    const listProducts = vi.fn(async () => ['安联ESG纯债1号资产管理产品']);
    const router = new WeComRiskRouter(
      fakeService({
        listProducts,
        searchSecurities: async () => [
          { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
          { name: '国债0116', code: '019116.SH', label: '国债0116 019116.SH' },
        ],
      }),
      { productCacheTtlMs: 100, now: () => now },
    );

    await router.handle('single:u5', '安联ESG纯债1号 买 0.1 国债');
    now += 101;
    await router.handle('single:u5', '1');

    expect(listProducts).toHaveBeenCalledOnce();
  });
});

function fakeService(overrides: Partial<RiskService> = {}): RiskService {
  const security: RiskSecuritySuggestion = {
    name: '国债0115',
    code: '019115.SH',
    label: '国债0115 019115.SH',
  };
  return {
    listProducts: async () => ['安联ESG纯债1号资产管理产品'],
    searchSecurities: async () => [security],
    checkSecurity: async () => ({ hit: false }),
    checkCounterparty: async () => ({ hit: false }),
    getHoldings: async () => ({ holdings: [] }),
    getRestrictions: async () => ({ investment_restrictions: [] }),
    getCredit: async () => ({}),
    calculatePretrade: async () => successfulCalculation(),
    ...overrides,
  };
}

function successfulCalculation(): Record<string, unknown> {
  return {
    status: 'success',
    product: '安联ESG纯债1号资产管理产品',
    result: {
      before: { status_counts: { PASS: 1 } },
      after: { status_counts: { PASS: 1 } },
      comparison: [
        {
          规则类型: '比例限制',
          限制对象: '示例',
          测算前状态: 'PASS',
          测算后状态: 'PASS',
          测算前实际值: '1%',
          测算后实际值: '2%',
        },
      ],
    },
  };
}
