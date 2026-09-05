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

    expect(router.shouldHandle('single:u1', '安联ESG纯债1号 申购 0.1', false)).toBe(false);
    const result = await router.handle('single:u1', '安联ESG纯债1号 申购 0.1');

    expect(result).toMatchObject({ handled: true, intent: 'pretrade_calc' });
    if (result.handled) expect(result.markdown).toContain('未写单位，按亿元');
    expect(calculatePretrade).toHaveBeenCalledWith(
      '安联ESG纯债1号资产管理产品',
      { type: 'subscription', market: 'secondary', amount: 0.1 },
      undefined,
    );
  });

  it('routes risk-limit questions to restrictions without searching securities', async () => {
    const getRestrictions = vi.fn(async () => ({
      product: '安联ESG纯债1号资产管理产品',
      investment_restrictions: [],
    }));
    const searchSecurities = vi.fn(async () => []);
    const router = new WeComRiskRouter(
      fakeService({ getRestrictions, searchSecurities }),
    );

    const result = await router.handle('single:restrictions', '安联ESG纯债1号有哪些风险限额');

    expect(result).toMatchObject({ handled: true, intent: 'query_restrictions' });
    expect(getRestrictions).toHaveBeenCalledWith('安联ESG纯债1号资产管理产品');
    expect(searchSecurities).not.toHaveBeenCalled();
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
    if (first.handled) {
      expect(first.selection).toMatchObject({
        kind: 'security',
        options: [{ key: '1', label: '国债0115 019115.SH' }],
      });
    }
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
    if (second.handled) {
      expect(second.markdown).toContain('请确认证券');
      expect(second.selection?.options).toHaveLength(1);
    }

    const confirmed = await router.handle('single:u2', '确认');
    if (confirmed.handled) expect(confirmed.markdown).toContain('本笔投资未引发新增超限');
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
      expect(expired.markdown).not.toContain('AI');
      expect(expired.markdown).not.toContain('risk-service');
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
      { type: 'buy', market: 'secondary', amount: 0.1, security_name: '100115.SZ' },
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

  it('resolves product and security ambiguity as two sequential card selections', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const progress: string[] = [];
    const router = new WeComRiskRouter(
      fakeService({
        listProducts: async () => [
          '安联ESG纯债1号资产管理产品',
          '安联ESG纯债1号',
        ],
        searchSecurities: async () => [
          { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
        ],
        calculatePretrade,
      }),
    );

    const productChoice = await router.handle(
      'single:u6',
      '安联ESG纯债1号 买 0.1 国债',
      (message) => progress.push(message),
    );
    if (!productChoice.handled) throw new Error('expected handled result');
    expect(productChoice.selection).toMatchObject({
      kind: 'product',
      options: [
        { key: 'a', label: '安联ESG纯债1号资产管理产品' },
        { key: 'b', label: '安联ESG纯债1号' },
      ],
    });

    const securityChoice = await router.handle('single:u6', 'b', (message) => {
      progress.push(message);
    });
    if (!securityChoice.handled) throw new Error('expected handled result');
    expect(securityChoice.selection).toMatchObject({
      kind: 'security',
      options: [{ key: '1', label: '国债0115 019115.SH' }],
    });

    const result = await router.handle('single:u6', '1', (message) => progress.push(message));
    if (result.handled) expect(result.markdown).toContain('本笔投资未引发新增超限');
    expect(progress).toEqual([
      '已确认：账户「安联ESG纯债1号」，正在继续风险查询…',
      expect.stringContaining('证券「国债0115（019115.SH）」'),
      '正在提交投前测算…',
    ]);
    expect(calculatePretrade).toHaveBeenCalledWith(
      '安联ESG纯债1号',
      { type: 'buy', market: 'secondary', amount: 0.1, security_name: '019115.SH' },
      expect.any(Function),
    );
  });

  it('asks for a more precise security when more than ten candidates match', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(
      fakeService({
        calculatePretrade,
        searchSecurities: async () =>
          Array.from({ length: 11 }, (_, index) => ({
            name: `候选${index + 1}`,
            code: `CODE${index + 1}`,
            label: `候选${index + 1} CODE${index + 1}`,
          })),
      }),
    );

    const result = await router.handle('single:u7', '安联ESG纯债1号 买 0.1 候选');

    if (!result.handled) throw new Error('expected handled result');
    expect(result.markdown).toContain('匹配到 11 个候选');
    expect(result.markdown).toContain('更精确');
    expect(result.selection).toBeUndefined();
    expect(calculatePretrade).not.toHaveBeenCalled();
  });

  it('turns fuzzy product matches into a confirmation card instead of guessing', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(
      fakeService({
        listProducts: async () => [
          '安联ESG纯债1号资产管理产品',
          '安联ESG纯债2号资产管理产品',
        ],
        calculatePretrade,
      }),
    );

    const result = await router.handle('single:u8', '安联资管 ESG 纯债 3 号 申购 0.1');

    if (!result.handled) throw new Error('expected handled result');
    expect(result.selection).toMatchObject({
      kind: 'product',
      options: [
        { key: 'a', label: '安联ESG纯债1号资产管理产品' },
        { key: 'b', label: '安联ESG纯债2号资产管理产品' },
      ],
    });
    expect(calculatePretrade).not.toHaveBeenCalled();
  });

  it('requires confirmation even when fuzzy fallback finds one product', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(fakeService({ calculatePretrade }));

    const choice = await router.handle('single:u9', '安联 ESG 纯在 1 号 申购 0.1');
    if (!choice.handled) throw new Error('expected handled result');
    expect(choice.selection).toMatchObject({
      kind: 'product',
      options: [{ key: 'a', label: '安联ESG纯债1号资产管理产品' }],
    });
    expect(calculatePretrade).not.toHaveBeenCalled();

    const confirmed = await router.handle('single:u9', '确认');
    if (confirmed.handled) expect(confirmed.markdown).toContain('本笔投资未引发新增超限');
    expect(calculatePretrade).toHaveBeenCalledOnce();
  });

  it('reports explicit progress for holdings and credit queries', async () => {
    const holdingsProgress: string[] = [];
    const creditProgress: string[] = [];
    const router = new WeComRiskRouter(fakeService());

    await router.handle('single:u10', '安联 ESG 纯债 1 号持仓', (message) => {
      holdingsProgress.push(message);
    });
    await router.handle('single:u11', '赣锋锂业授信额度', (message) => {
      creditProgress.push(message);
    });

    expect(holdingsProgress).toEqual(['正在查询产品持仓…']);
    expect(creditProgress).toEqual(['正在查询主体授信额度…']);
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
