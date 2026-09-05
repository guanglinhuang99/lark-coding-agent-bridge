import { describe, expect, it, vi } from 'vitest';
import type { RiskService } from '../../../src/wecom/risk/client';
import { parseRiskMessage } from '../../../src/wecom/risk/parser';
import {
  applyDirectRiskIntentInput,
  buildIntentSelection,
  canonicalCommand,
  isRiskIntentCorrection,
  mergeRiskIntentDraft,
  normalizeRiskDraft,
  normalizeSecurity,
  parseRiskIntentOutput,
  parseRiskIntentOutputPartial,
  RiskIntentStateRegistry,
  isPretradeIntentCandidate,
} from '../../../src/wecom/risk/intent';

describe('AI pretrade intent normalization', () => {
  it('defaults to secondary unless the user explicitly says 一级', () => {
    const base =
      '{"account_query":"ESG纯债1号","action":"buy","security_query":"国债0115","amount_text":"1000万","days":null}';
    expect(parseRiskIntentOutput(base, 'ESG纯债1号买1000万国债0115').market).toBe(
      'secondary',
    );
    expect(
      parseRiskIntentOutput(base, 'ESG纯债1号一级买1000万国债0115').market,
    ).toBe('primary');
  });

  it('uses risk-service master data before confirmation', async () => {
    const calculatePretrade = vi.fn(async () => ({}));
    const service = fakeService({ calculatePretrade });
    const draft = parseRiskIntentOutput(
      '{"account_query":"ESG纯债1号","action":"buy","security_query":"国债0115","amount_text":"1000万"}',
      '一级 ESG纯债1号买1000万国债0115',
    );
    const state = await normalizeRiskDraft(
      '一级 ESG纯债1号买1000万国债0115',
      draft,
      service,
    );
    expect(service.listProducts).toHaveBeenCalled();
    expect(service.searchSecurities).toHaveBeenCalledWith('国债0115');
    expect(state).toMatchObject({
      stage: 'confirm',
      product: '安联ESG纯债1号资产管理产品',
      security: { code: '019115.SH' },
    });
    if (state.stage !== 'confirm') throw new Error('expected confirm');
    expect(canonicalCommand(state)).toContain('一级市场');
    expect(canonicalCommand(state)).toContain('019115.SH');
    expect(
      parseRiskMessage(canonicalCommand(state), ['安联ESG纯债1号资产管理产品']),
    ).toMatchObject({
      kind: 'pretrade_calc',
      market: 'primary',
      securityQuery: '019115.SH',
      amount: 0.1,
    });
    expect(calculatePretrade).not.toHaveBeenCalled();
  });

  it('round-trips a 亿元 buy without leaving the unit suffix in the security query', async () => {
    const draft = parseRiskIntentOutput(
      '{"account_query":"ESG纯债1号","action":"buy","security_query":"102680271.IB","amount_text":"0.1亿元"}',
      'ESG纯债1号买入0.1亿元102680271.IB',
    );
    const state = await normalizeRiskDraft(
      'ESG纯债1号买入0.1亿元102680271.IB',
      draft,
      fakeService({
        searchSecurities: vi.fn(async () => [
          { name: '26华友钴业MTN002(科创债)', code: '102680271.IB', label: '26华友钴业MTN002(科创债) 102680271.IB' },
        ]),
      }),
    );

    expect(state.stage).toBe('confirm');
    if (state.stage === 'confirm') {
      const canonical = canonicalCommand(state);
      expect(canonical).toContain('0.1亿元');
      const reparsed = parseRiskMessage(canonical, ['安联ESG纯债1号资产管理产品']);
      expect(reparsed).toMatchObject({
        amount: 0.1,
        securityQuery: '102680271.IB',
        missing: [],
      });
      if (reparsed.kind === 'pretrade_calc') {
        expect(reparsed.securityQuery).not.toContain('元');
      }
    }
  });

  it('removes a product name that AI mixed into the security query', async () => {
    const searchSecurities = vi.fn(async () => [
      { name: '中信证券', code: '600030.SH', label: '中信证券 600030.SH' },
      { name: '中信银行', code: '601998.SH', label: '中信银行 601998.SH' },
    ]);
    const service = fakeService({ searchSecurities });
    const originalText = 'esg纯债1号买3000万中信';
    const draft = parseRiskIntentOutput(
      '{"account_query":"","action":"buy","security_query":"esg纯债1号 中信","amount_text":"3000万"}',
      originalText,
    );

    const state = await normalizeRiskDraft(originalText, draft, service);

    expect(searchSecurities).toHaveBeenCalledWith('中信');
    expect(state).toMatchObject({
      stage: 'security',
      product: '安联ESG纯债1号资产管理产品',
      draft: { securityQuery: '中信' },
    });
  });

  it('accepts direct text while waiting for account, security, or amount corrections', async () => {
    const searchSecurities = vi.fn(async (query: string) => [
      { name: query, code: '600030.SH', label: `${query} 600030.SH` },
    ]);
    const service = fakeService({ searchSecurities });
    const draft = parseRiskIntentOutput(
      '{"account_query":"ESG纯债1号","action":"buy","security_query":"旧证券","amount_text":"1000万"}',
      'ESG纯债1号买1000万旧证券',
    );

    const accountState = await applyDirectRiskIntentInput(
      { stage: 'account', originalText: 'ESG纯债1号买1000万旧证券', draft, products: [] },
      '安联ESG纯债1号资产管理产品',
      service,
    );
    expect(accountState).toMatchObject({ stage: 'confirm', product: '安联ESG纯债1号资产管理产品' });

    const securityState = await applyDirectRiskIntentInput(
      {
        stage: 'security',
        originalText: 'ESG纯债1号买1000万旧证券',
        draft,
        product: '安联ESG纯债1号资产管理产品',
        securities: [],
      },
      '中信',
      service,
    );
    expect(searchSecurities).toHaveBeenLastCalledWith('中信');
    expect(securityState).toMatchObject({
      stage: 'confirm',
      draft: { securityQuery: '中信' },
      security: { name: '中信' },
    });

    const amountState = await applyDirectRiskIntentInput(
      {
        stage: 'freeform',
        originalText: 'ESG纯债1号买1000万旧证券',
        draft,
        field: 'amount',
        product: '安联ESG纯债1号资产管理产品',
        security: { name: '旧证券', code: '000001.SH', label: '旧证券 000001.SH' },
      },
      '3000万',
      service,
    );
    expect(amountState).toMatchObject({
      stage: 'confirm',
      draft: { amountText: '3000万' },
      security: { code: '000001.SH' },
    });
  });

  it('keeps unchanged confirmation fields when AI over-interprets a short correction', () => {
    const previous = {
      accountQuery: '安联ESG纯债1号',
      action: 'buy' as const,
      securityQuery: '019115.SH',
      amountText: '1000万',
      days: 7,
      market: 'primary' as const,
    };
    const revised = {
      accountQuery: '错误账户',
      action: 'subscription' as const,
      securityQuery: '错误证券',
      amountText: '0.1亿元',
      days: 1,
      market: 'secondary' as const,
    };
    const merged = mergeRiskIntentDraft(
      previous,
      revised,
      '金额改成3000万，证券改成102501348.IB',
    );

    expect(merged).toMatchObject({
      accountQuery: '安联ESG纯债1号',
      action: 'buy',
      securityQuery: '102501348.IB',
      amountText: '3000万',
      days: 7,
      market: 'primary',
    });
  });

  it('recognizes correction wording before considering a new transaction', () => {
    expect(isRiskIntentCorrection('金额改成3000万，证券改成102501348.IB')).toBe(true);
    expect(isRiskIntentCorrection('把动作调整为正回购，期限改为7天')).toBe(true);
    expect(isRiskIntentCorrection('安联ESG纯债1号 买入 0.1亿元 102680271.IB')).toBe(false);
  });

  it('accepts 修改为 wording for explicit field replacement', () => {
    const previous = {
      accountQuery: '安联ESG纯债1号',
      action: 'buy' as const,
      securityQuery: '019115.SH',
      amountText: '1000万',
      market: 'primary' as const,
    };
    const revised = { ...previous, action: 'subscription' as const, market: 'secondary' as const };

    expect(
      mergeRiskIntentDraft(previous, revised, '证券修改为102501348.IB'),
    ).toMatchObject({ action: 'buy', securityQuery: '102501348.IB', market: 'primary' });
  });

  it('keeps incomplete account, amount, and security requests resumable', async () => {
    const service = fakeService();

    const missingAccount = await normalizeRiskDraft(
      '买1000万国债0115',
      parseRiskIntentOutputPartial(
        '{"account_query":"","action":"buy","security_query":"国债0115","amount_text":"1000万"}',
        '买1000万国债0115',
      ),
      service,
    );
    expect(missingAccount).toMatchObject({ stage: 'account', products: [] });

    const missingAmount = await normalizeRiskDraft(
      'ESG纯债1号买国债0115',
      parseRiskIntentOutputPartial(
        '{"account_query":"ESG纯债1号","action":"buy","security_query":"国债0115","amount_text":""}',
        'ESG纯债1号买国债0115',
      ),
      service,
    );
    expect(missingAmount).toMatchObject({
      stage: 'freeform',
      field: 'amount',
      product: '安联ESG纯债1号资产管理产品',
      security: { code: '019115.SH' },
    });

    const missingSecurity = await normalizeRiskDraft(
      'ESG纯债1号买1000万',
      parseRiskIntentOutputPartial(
        '{"account_query":"ESG纯债1号","action":"buy","security_query":"","amount_text":"1000万"}',
        'ESG纯债1号买1000万',
      ),
      service,
    );
    expect(missingSecurity).toMatchObject({ stage: 'security', product: '安联ESG纯债1号资产管理产品' });
  });

  it('does not auto-lock a generic product query even with one fuzzy candidate', async () => {
    const searchSecurities = vi.fn(async () => [
      { name: '国债0115', code: '100115.SZ', label: '国债0115 100115.SZ' },
      { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
    ]);
    const state = await normalizeRiskDraft(
      '安联纯债 买入 0.1亿元 国债',
      {
        accountQuery: '安联纯债',
        action: 'buy',
        securityQuery: '国债',
        amountText: '0.1亿元',
        market: 'secondary',
      },
      fakeService({
        listProducts: vi.fn(async () => ['安联ESG纯债1号资产管理产品']),
        searchSecurities,
      }),
    );

    expect(state).toMatchObject({
      stage: 'account',
      products: ['安联ESG纯债1号资产管理产品'],
    });
    expect(searchSecurities).not.toHaveBeenCalled();
  });

  it('lists multiple risk-service candidates plus Other', async () => {
    const service = fakeService({
      listProducts: vi.fn(async () => ['安联ESG纯债1号A', '安联ESG纯债1号B']),
    });
    const draft = parseRiskIntentOutput(
      '{"account_query":"ESG纯债1号","action":"subscription","security_query":null,"amount_text":"0.1"}',
      'ESG纯债1号申购0.1',
    );
    const state = await normalizeRiskDraft('ESG纯债1号申购0.1', draft, service);
    expect(state.stage).toBe('account');
    expect(buildIntentSelection(state, 1000).options.at(-1)).toMatchObject({
      label: '其他',
      value: '__other_account__',
    });

    const securityService = fakeService({
      searchSecurities: vi.fn(async () => [
        { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
        { name: '国债0116', code: '019116.SH', label: '国债0116 019116.SH' },
      ]),
    });
    const securityState = await normalizeRiskDraft(
      'ESG纯债1号买1000万国债',
      { ...draft, accountQuery: 'ESG纯债1号', action: 'buy', securityQuery: '国债' },
      securityService,
    );
    expect(buildIntentSelection(securityState, 1000).options.at(-1)).toMatchObject({
      label: '其他',
      value: '__other_security__',
    });
  });

  it('bounds large security results without silently choosing a candidate', async () => {
    const options = Array.from({ length: 12 }, (_, index) => ({
      name: '中信债券',
      code: `CODE${index + 1}.IB`,
      label: `中信债券 CODE${index + 1}.IB`,
    }));
    const state = await normalizeSecurity(
      '安联ESG纯债1号买入0.1亿元中信',
      {
        accountQuery: 'ESG纯债1号',
        action: 'buy',
        securityQuery: '中信',
        amountText: '0.1亿元',
        market: 'secondary',
      },
      '安联ESG纯债1号资产管理产品',
      fakeService({ searchSecurities: vi.fn(async () => options) }),
    );

    expect(state).toMatchObject({ stage: 'security' });
    if (state.stage === 'security') {
      expect(state.securities).toHaveLength(9);
      expect(buildIntentSelection(state, 1000).options).toHaveLength(10);
    }
  });

  it('bounds large product results with an actionable selection card', async () => {
    const products = Array.from({ length: 12 }, (_, index) =>
      `安联稳益${index + 1}号资产管理产品`,
    );
    const state = await normalizeRiskDraft(
      '稳益买入0.1亿元600519.SH',
      {
        accountQuery: '稳益',
        action: 'buy',
        securityQuery: '600519.SH',
        amountText: '0.1亿元',
        market: 'secondary',
      },
      fakeService({ listProducts: vi.fn(async () => products) }),
    );

    expect(state).toMatchObject({ stage: 'account' });
    if (state.stage === 'account') {
      expect(state.products).toHaveLength(9);
      expect(buildIntentSelection(state, 1000).options).toHaveLength(10);
    }
  });

  it('keeps same-name securities with different codes on the selection path', async () => {
    const state = await normalizeSecurity(
      '安联ESG纯债1号买入0.1亿元国债0115',
      {
        accountQuery: 'ESG纯债1号',
        action: 'buy',
        securityQuery: '国债0115',
        amountText: '0.1亿元',
        market: 'secondary',
      },
      '安联ESG纯债1号资产管理产品',
      fakeService({
        searchSecurities: vi.fn(async () => [
          { name: '国债0115', code: '100115.SZ', label: '国债0115 100115.SZ' },
          { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
        ]),
      }),
    );

    expect(state).toMatchObject({ stage: 'security' });
    if (state.stage === 'security') {
      expect(state.securities.map((item) => item.code)).toEqual(['100115.SZ', '019115.SH']);
    }
  });

  it('promotes a same-name code pair before truncating a large security list', async () => {
    const unique = Array.from({ length: 10 }, (_, index) => ({
      name: `国债${index + 2000}`,
      code: `${index + 2000}.IB`,
      label: `国债${index + 2000} ${index + 2000}.IB`,
    }));
    const state = await normalizeSecurity(
      '安联ESG纯债1号买入0.1亿元国债',
      {
        accountQuery: 'ESG纯债1号',
        action: 'buy',
        securityQuery: '国债',
        amountText: '0.1亿元',
        market: 'secondary',
      },
      '安联ESG纯债1号资产管理产品',
      fakeService({
        searchSecurities: vi.fn(async () => [
          { name: '国债0115', code: '100115.SZ', label: '国债0115 100115.SZ' },
          ...unique,
          { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
        ]),
      }),
    );

    expect(state.stage).toBe('security');
    if (state.stage === 'security') {
      expect(state.securities.map((item) => item.code)).toEqual(
        expect.arrayContaining(['100115.SZ', '019115.SH']),
      );
    }
  });

  it('confirms an exact code even when other same-name candidates exist', async () => {
    const state = await normalizeSecurity(
      '安联ESG纯债1号买入0.1亿元019115.SH',
      {
        accountQuery: 'ESG纯债1号',
        action: 'buy',
        securityQuery: '019115.SH',
        amountText: '0.1亿元',
        market: 'secondary',
      },
      '安联ESG纯债1号资产管理产品',
      fakeService({
        searchSecurities: vi.fn(async () => [
          { name: '国债0115', code: '100115.SZ', label: '国债0115 100115.SZ' },
          { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
        ]),
      }),
    );

    expect(state).toMatchObject({ stage: 'confirm', security: { code: '019115.SH' } });
  });

  it('explains when risk-service returns no account or security candidates', async () => {
    const accountService = fakeService({ listProducts: vi.fn(async () => []) });
    const draft = parseRiskIntentOutput(
      '{"account_query":"不存在账户","action":"buy","security_query":"国债","amount_text":"1000万"}',
      '不存在账户买1000万国债',
    );
    const accountState = await normalizeRiskDraft('不存在账户买1000万国债', draft, accountService);
    expect(buildIntentSelection(accountState, 1000)).toMatchObject({
      subTitle: expect.stringContaining('未找到匹配的产品'),
      replyHint: expect.stringContaining('输入'),
      options: [{ value: '__other_account__' }],
    });

    const securityService = fakeService({ searchSecurities: vi.fn(async () => []) });
    const securityDraft = { ...draft, accountQuery: 'ESG纯债1号' };
    const securityState = await normalizeRiskDraft(
      'ESG纯债1号买1000万国债',
      securityDraft,
      securityService,
    );
    expect(buildIntentSelection(securityState, 1000)).toMatchObject({
      subTitle: expect.stringContaining('未找到匹配的证券'),
      replyHint: expect.stringContaining('输入'),
      options: [{ value: '__other_security__' }],
    });
  });

  it('does not classify ordinary or read-only 买 queries as pretrade intents', () => {
    expect(isPretradeIntentCandidate('帮我买一本书')).toBe(false);
    expect(isPretradeIntentCandidate('安联ESG纯债1号 能不能买 国债0115')).toBe(false);
    expect(isPretradeIntentCandidate('安联ESG纯债1号 是否能买 国债0115')).toBe(false);
    expect(isPretradeIntentCandidate('安联ESG纯债1号 禁投 国债0115')).toBe(false);
    expect(isPretradeIntentCandidate('ESG纯债1号买1000万国债')).toBe(true);
    expect(isPretradeIntentCandidate('ESG纯债1号申购0.1')).toBe(true);
    expect(isPretradeIntentCandidate('ESG纯债1号正回购1亿7天')).toBe(true);
  });

  it('infers an omitted account from the text before the action', () => {
    const draft = parseRiskIntentOutput(
      '{"account_query":"","action":"subscription","security_query":null,"amount_text":"1000万"}',
      'ESG纯债1号申购1000万',
    );
    expect(draft.accountQuery).toBe('ESG纯债1号');
  });

  it('requires and standardizes security for primary-market subscription', async () => {
    expect(() =>
      parseRiskIntentOutput(
        '{"account_query":"ESG纯债1号","action":"subscription","security_query":null,"amount_text":"1000万"}',
        'ESG纯债1号 一级申购 1000万',
      ),
    ).toThrow(/交易标的/);

    const service = fakeService();
    const draft = parseRiskIntentOutput(
      '{"account_query":"ESG纯债1号","action":"subscription","security_query":"国债0115","amount_text":"1000万"}',
      'ESG纯债1号 一级申购 1000万 国债0115',
    );
    const state = await normalizeRiskDraft(
      'ESG纯债1号 一级申购 1000万 国债0115',
      draft,
      service,
    );
    expect(service.searchSecurities).toHaveBeenCalledWith('国债0115');
    expect(state).toMatchObject({
      stage: 'confirm',
      product: '安联ESG纯债1号资产管理产品',
      security: { code: '019115.SH' },
      draft: { market: 'primary', action: 'subscription' },
    });
  });

  it('expires conversation and card intent state', () => {
    vi.useFakeTimers();
    try {
      const registry = new RiskIntentStateRegistry(Date.now, 100);
      const state = {
        stage: 'freeform' as const,
        originalText: '原话',
        draft: parseRiskIntentOutput(
          '{"account_query":"账户","action":"subscription","amount_text":"1"}',
          '账户申购1',
        ),
        field: 'amount' as const,
      };
      registry.set('single:u1', state);
      registry.registerTask('risk_1', 'single:u1', state, Date.now() + 100);
      expect(registry.has('single:u1')).toBe(true);
      expect(registry.getTask('risk_1')).toBe(state);
      vi.advanceTimersByTime(101);
      expect(registry.has('single:u1')).toBe(false);
      expect(registry.getTask('risk_1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeService(overrides: Partial<RiskService> = {}): RiskService {
  return {
    listProducts: vi.fn(async () => ['安联ESG纯债1号资产管理产品']),
    searchSecurities: vi.fn(async () => [
      { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
    ]),
    checkSecurity: async () => ({}),
    checkCounterparty: async () => ({}),
    getHoldings: async () => ({}),
    getRestrictions: async () => ({}),
    getCredit: async () => ({}),
    calculatePretrade: async () => ({}),
    ...overrides,
  };
}
