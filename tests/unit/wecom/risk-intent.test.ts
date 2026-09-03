import { describe, expect, it, vi } from 'vitest';
import type { RiskService } from '../../../src/wecom/risk/client';
import { parseRiskMessage } from '../../../src/wecom/risk/parser';
import {
  buildIntentSelection,
  canonicalCommand,
  normalizeRiskDraft,
  parseRiskIntentOutput,
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

  it('explains when risk-service returns no account or security candidates', async () => {
    const accountService = fakeService({ listProducts: vi.fn(async () => []) });
    const draft = parseRiskIntentOutput(
      '{"account_query":"不存在账户","action":"buy","security_query":"国债","amount_text":"1000万"}',
      '不存在账户买1000万国债',
    );
    const accountState = await normalizeRiskDraft('不存在账户买1000万国债', draft, accountService);
    expect(buildIntentSelection(accountState, 1000)).toMatchObject({
      subTitle: expect.stringContaining('未找到匹配的产品'),
      replyHint: expect.stringContaining('其他'),
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
      replyHint: expect.stringContaining('其他'),
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
