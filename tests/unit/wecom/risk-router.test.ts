import { describe, expect, it, vi } from 'vitest';
import type { RiskSecuritySuggestion, RiskService } from '../../../src/wecom/risk/client';
import { WeComRiskRouter } from '../../../src/wecom/risk/router';

describe('WeCom stateless risk query router', () => {
  it('delegates pretrade messages to the canonical intent flow', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(fakeService({ calculatePretrade }));

    const result = await router.handle('single:u1', '安联ESG纯债1号 申购 0.1');

    expect(result).toEqual({ handled: false });
    expect(calculatePretrade).not.toHaveBeenCalled();
  });

  it('routes risk-limit questions to restrictions without searching securities', async () => {
    const getRestrictions = vi.fn(async () => ({
      product: '安联ESG纯债1号资产管理产品',
      investment_restrictions: [],
    }));
    const searchSecurities = vi.fn(async () => []);
    const router = new WeComRiskRouter(fakeService({ getRestrictions, searchSecurities }));

    const result = await router.handle('single:restrictions', '安联ESG纯债1号有哪些风险限额');

    expect(result).toMatchObject({ handled: true, intent: 'query_restrictions' });
    expect(getRestrictions).toHaveBeenCalledWith('安联ESG纯债1号资产管理产品');
    expect(searchSecurities).not.toHaveBeenCalled();
  });

  it('returns explicit continuation when a counterparty query is missing its product', async () => {
    const checkCounterparty = vi.fn(async () => ({ hit: false }));
    const router = new WeComRiskRouter(fakeService({ checkCounterparty }));

    const result = await router.handle('single:u1', '交易对手 某某公司 是不是关联方');

    expect(result).toMatchObject({
      handled: true,
      continuation: { kind: 'missing', intent: { kind: 'check_counterparty' } },
    });
    if (result.handled) expect(result.markdown).toContain('还差产品名');
    expect(checkCounterparty).not.toHaveBeenCalled();
  });

  it('keeps security disambiguation zero-token through an explicit continuation', async () => {
    const checkSecurity = vi.fn(async () => ({ hit: false }));
    const router = new WeComRiskRouter(
      fakeService({
        checkSecurity,
        searchSecurities: async () => [
          { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
        ],
      }),
    );

    const first = await router.handle('single:u2', '安联ESG纯债1号 能不能买 国债0115');
    if (!first.handled || !first.continuation) throw new Error('expected continuation');
    expect(first.selection).toMatchObject({
      kind: 'security',
      options: [{ key: '1', label: '国债0115 019115.SH' }],
    });

    const second = await router.continue(first.continuation, '确认');
    expect(second).toMatchObject({ handled: true, intent: 'check_security' });
    if (second.handled) {
      expect(second.markdown).toContain('未命中');
      expect(second.continuation).toBeUndefined();
    }
    expect(checkSecurity).toHaveBeenCalledWith(
      '安联ESG纯债1号资产管理产品',
      '019115.SH',
    );
  });

  it('preserves ambiguous security continuation and selected code', async () => {
    const checkSecurity = vi.fn(async () => ({ hit: false }));
    const options = [
      { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
      { name: '国债0116', code: '019116.SH', label: '国债0116 019116.SH' },
    ];
    const router = new WeComRiskRouter(fakeService({ checkSecurity, searchSecurities: async () => options }));

    const first = await router.handle('single:u3', '安联ESG纯债1号 能不能买 国债');
    if (!first.handled || !first.continuation) throw new Error('expected continuation');
    expect(first.selection?.options).toHaveLength(2);

    const second = await router.continue(first.continuation, '2');
    expect(second).toMatchObject({ handled: true, intent: 'check_security' });
    expect(checkSecurity).toHaveBeenCalledWith(
      '安联ESG纯债1号资产管理产品',
      '019116.SH',
    );
  });

  it('returns product continuation and resumes using the chosen account', async () => {
    const productChoices = [
      '安联ESG纯债1号A资产管理产品',
      '安联ESG纯债1号B资产管理产品',
    ];
    const getHoldings = vi.fn(async (product: string) => ({ product, holdings: [] }));
    const router = new WeComRiskRouter(fakeService({
      listProducts: async () => productChoices,
      getHoldings,
    }));

    const first = await router.handle('single:u4', '安联ESG纯债1号持仓');
    if (!first.handled || !first.continuation) throw new Error('expected continuation');
    expect(first.selection).toMatchObject({
      kind: 'product',
      options: [
        { key: 'a', label: productChoices[0] },
        { key: 'b', label: productChoices[1] },
      ],
    });

    const second = await router.continue(first.continuation, 'b');
    expect(second).toMatchObject({ handled: true, intent: 'query_holdings' });
    expect(getHoldings).toHaveBeenCalledWith(productChoices[1]);
  });

  it('allows a pending missing query to be replaced by a new complete query', async () => {
    const getHoldings = vi.fn(async (product: string) => ({ product, holdings: [] }));
    const router = new WeComRiskRouter(fakeService({ getHoldings }));

    const first = await router.handle('single:u5', '授信额度');
    if (!first.handled || !first.continuation) throw new Error('expected continuation');
    expect(first.continuation).toMatchObject({ kind: 'missing', intent: { kind: 'query_credit' } });

    const second = await router.continue(first.continuation, '安联ESG纯债1号持仓');
    expect(second).toMatchObject({ handled: true, intent: 'query_holdings' });
    expect(getHoldings).toHaveBeenCalledWith('安联ESG纯债1号资产管理产品');
  });

  it('returns handled false when a query continuation is replaced by a pretrade transaction', async () => {
    const router = new WeComRiskRouter(fakeService());
    const first = await router.handle('single:u6', '授信额度');
    if (!first.handled || !first.continuation) throw new Error('expected continuation');

    const second = await router.continue(
      first.continuation,
      '安联ESG纯债1号 申购 1000万',
    );

    expect(second).toEqual({ handled: false });
  });

  it('does not keep a second router-level product cache', async () => {
    const listProducts = vi.fn(async () => ['安联ESG纯债1号资产管理产品']);
    const router = new WeComRiskRouter(fakeService({ listProducts }));

    await router.handle('single:u7', '安联ESG纯债1号持仓');
    await router.handle('single:u8', '安联ESG纯债1号有哪些风险限额');

    expect(listProducts).toHaveBeenCalledTimes(2);
  });

  it('reports explicit progress for holdings and credit queries', async () => {
    const holdingsProgress: string[] = [];
    const creditProgress: string[] = [];
    const router = new WeComRiskRouter(fakeService());

    await router.handle('single:u9', '安联 ESG 纯债 1 号持仓', (message) => {
      holdingsProgress.push(message);
    });
    await router.handle('single:u10', '赣锋锂业授信额度', (message) => {
      creditProgress.push(message);
    });

    expect(holdingsProgress).toEqual(['正在查询产品持仓…']);
    expect(creditProgress).toEqual(['正在查询主体授信额度…']);
  });

  it('converts service failures into a user-safe risk error', async () => {
    const router = new WeComRiskRouter(fakeService({
      listProducts: async () => { throw new Error('/private/backend failed'); },
    }));

    const result = await router.handle('single:u11', '安联ESG纯债1号持仓');

    expect(result).toMatchObject({ handled: true, intent: 'risk-error' });
    if (result.handled) {
      expect(result.markdown).toContain('风险查询失败');
      expect(result.markdown).not.toContain('/private/backend');
    }
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
      comparison: [],
    },
  };
}
