import { describe, expect, it, vi } from 'vitest';
import type { RiskSecuritySuggestion, RiskService } from '../../../src/wecom/risk/client';
import {
  applyDirectRiskIntentInput,
  buildIntentSelection,
  canonicalCommand,
  confirmationSummary,
  isPretradeIntentCandidate,
  normalizeRiskDraft,
  normalizeSecurity,
  parseRiskIntentOutput,
  type RiskIntentState,
} from '../../../src/wecom/risk/intent';
import { isRiskCandidate, parseRiskMessage } from '../../../src/wecom/risk/parser';
import { WeComRiskRouter } from '../../../src/wecom/risk/router';
import { RiskProgressRelay } from '../../../src/wecom/risk/progress';

const products = [
  '安联纯债1号资产管理产品',
  '安联稳益3号资产管理产品',
  '安联稳益7号资产管理产品',
  '安联远见10号资产管理产品',
];

const securities: RiskSecuritySuggestion[] = [
  { name: '国债0115', code: '019115.SH', label: '国债0115 019115.SH' },
  { name: '国债0116', code: '019116.SH', label: '国债0116 019116.SH' },
  { name: '金融债240201', code: '240201.IB', label: '金融债240201 240201.IB' },
  { name: '短融1024001', code: '1024001.IB', label: '短融1024001 1024001.IB' },
  { name: '企业债148001', code: '148001.SZ', label: '企业债148001 148001.SZ' },
  { name: '股票600000', code: '600000.SH', label: '股票600000 600000.SH' },
  { name: '基金510300', code: '510300.SH', label: '基金510300 510300.SH' },
  { name: '同业存单1124001', code: '1124001.IB', label: '同业存单1124001 1124001.IB' },
];

function successfulCalculation(): Record<string, unknown> {
  return { status: 'success', result: { before: { status_counts: { PASS: 1 } }, after: { status_counts: { PASS: 1 } }, comparison: [] } };
}

function mockRiskService(overrides: Partial<RiskService> = {}): RiskService {
  return {
    listProducts: vi.fn(async () => products),
    searchSecurities: vi.fn(async (query: string) => securities.filter((item) => item.label.includes(query) || item.code === query.toUpperCase())),
    checkSecurity: vi.fn(async () => ({ hit: false })),
    checkCounterparty: vi.fn(async () => ({ hit: false })),
    getHoldings: vi.fn(async () => ({ holdings: [] })),
    getRestrictions: vi.fn(async () => ({ investment_restrictions: [] })),
    getCredit: vi.fn(async () => ({})),
    calculatePretrade: vi.fn(async () => successfulCalculation()),
    ...overrides,
  };
}

describe('risk transaction parser matrix', () => {
  it.each([
    ['buy', '安联稳益3号', '买入', '0.1亿', '国债0115', { amount: 0.1 }],
    ['sell', '安联远见10号', '卖出', '1000万', '金融债240201', { amount: 0.1 }],
    ['buy', '安联纯债1号', '买', '500000元', '股票600000', { amount: 0.005 }],
    ['sell', '安联稳益7号', '卖', '5股', '基金510300', { quantity: 5 }],
    ['buy', '安联远见10号', '买', '6手', '短融1024001', { quantity: 6 }],
    ['sell', '安联纯债1号', '卖', '7张', '企业债148001', { quantity: 7 }],
    ['buy', '安联稳益3号', '买', '8份', '同业存单1124001', { quantity: 8 }],
  ])('parses %s for %s with %s', (action, product, verb, amountText, security, expected) => {
    const parsed = parseRiskMessage(`${product} ${verb} ${amountText} ${security}`, products);
    expect(parsed).toMatchObject({
      kind: 'pretrade_calc',
      action,
      ...expected,
      securityQuery: security,
      missing: [],
    });
  });

  it.each([
    ['安联稳益3号', '安联稳益3号资产管理产品'],
    ['安联资管 稳在 三号', undefined],
  ])('distinguishes exact and fuzzy product matches: %s', (query, product) => {
    const parsed = parseRiskMessage(`${query} 买入 0.1亿 国债0115`, products);
    expect(parsed).toMatchObject({ kind: 'pretrade_calc', product });
    if (!product) expect(parsed).toMatchObject({ productCandidates: expect.any(Array) });
  });

  it('keeps multiple and zero security candidates on the selection path', () => {
    const multi = parseRiskMessage('安联稳益3号 买入 1万 国债011', products);
    expect(multi).toMatchObject({ kind: 'pretrade_calc', securityQuery: '国债011', missing: [] });
    const none = parseRiskMessage('安联稳益3号 买入 1万 不存在证券', products);
    expect(none).toMatchObject({ kind: 'pretrade_calc', securityQuery: '不存在证券', missing: [] });
  });

  it.each([
    ['买入', 'buy', '一级市场', 'primary'],
    ['买入', 'buy', '二级市场', 'secondary'],
    ['卖出', 'sell', '一级市场', 'primary'],
    ['卖出', 'sell', '二级市场', 'secondary'],
  ])('detects %s in %s for %s', (verb, action, market, expected) => {
    expect(parseRiskMessage(`安联远见10号 ${market} ${verb} 2亿 金融债240201`, products)).toMatchObject({ action, market: expected });
  });

  it.each([
    ['申购', 'subscription', '1000万'],
    ['认购', 'subscription', '0.1'],
    ['赎回', 'redemption', '500000元'],
  ])('parses %s with and without explicit units', (verb, action, amountText) => {
    expect(parseRiskMessage(`安联纯债1号 ${verb} ${amountText}`, products)).toMatchObject({ kind: 'pretrade_calc', action, missing: [] });
  });

  it.each([
    ['回购', 'repo', '3000万', 7],
    ['逆回购', 'reverse_repo', '2亿', 14],
  ])('parses %s amount and days without security', (verb, action, amountText, days) => {
    expect(parseRiskMessage(`安联远见10号 ${verb} ${amountText} ${days}天`, products)).toMatchObject({ action, amount: expect.any(Number), days, securityQuery: undefined, missing: [] });
  });

  it('reports missing product and repo amount', () => {
    expect(parseRiskMessage('逆回购 7天', products)).toMatchObject({ kind: 'pretrade_calc', missing: expect.arrayContaining(['产品名', '金额']) });
  });

  it('keeps read-only checks separate from trades and rejects a book purchase', () => {
    expect(parseRiskMessage('安联纯债1号 能不能买 国债0115', products)).toMatchObject({ kind: 'check_security', securityQuery: '国债0115' });
    expect(parseRiskMessage('安联纯债1号 禁投 股票600000', products)).toMatchObject({ kind: 'check_security' });
    expect(isRiskCandidate('帮我买一本书')).toBe(false);
  });
});

describe('risk intent normalization and confirmation matrix', () => {
  it.each([
    ['安联稳益3号', 'subscription', '1000万', 'secondary'],
    ['安联资管 稳益 3 号', 'subscription', '0.1', 'secondary'],
    ['安联远见10号', 'redemption', '500000元', 'secondary'],
  ])('normalizes %s %s without requiring a security', async (accountQuery, action, amountText, market) => {
    const state = await normalizeRiskDraft('原始交易', { accountQuery, action: action as never, amountText, market: market as 'secondary' }, mockRiskService());
    expect(state.stage).toBe('confirm');
    if (state.stage === 'confirm') {
      expect(state.security).toBeUndefined();
      expect(confirmationSummary(state)).toContain(`操作：${action === 'redemption' ? '赎回' : '申购'}`);
      expect(canonicalCommand(state)).toContain(amountText);
    }
  });

  it('renders canonical primary subscription confirmation including security', async () => {
    const state = await normalizeRiskDraft('一级认购', { accountQuery: products[0]!, action: 'subscription', securityQuery: '国债0115', amountText: '1亿', market: 'primary' }, mockRiskService());
    expect(state.stage).toBe('confirm');
    if (state.stage === 'confirm') {
      expect(confirmationSummary(state)).toContain('市场：一级市场');
      expect(canonicalCommand(state)).toContain('019115.SH');
    }
  });

  it('supports direct account, security, and amount corrections', async () => {
    const service = mockRiskService();
    let state: RiskIntentState = { stage: 'account', originalText: '买入', draft: { accountQuery: '', action: 'buy', securityQuery: '国债0115', amountText: '1万', market: 'secondary' }, products: [] };
    state = (await applyDirectRiskIntentInput(state, '安联稳益3号', service))!;
    expect(state.stage).toBe('confirm');
    state = (await applyDirectRiskIntentInput({ stage: 'security', originalText: '买入', draft: { accountQuery: products[0]!, action: 'buy', amountText: '1万', market: 'secondary' }, product: products[0]!, securities: [] }, '国债0115', service))!;
    expect(state.stage).toBe('confirm');
    state = (await applyDirectRiskIntentInput({ stage: 'freeform', originalText: '买入', draft: { accountQuery: products[0]!, action: 'buy', securityQuery: '国债0115', market: 'secondary' }, field: 'amount', product: products[0]!, security: securities[0] }, '2万', service))!;
    expect(state.stage).toBe('confirm');
  });

  it.each([
    ['准确产品 + 准确证券', products[1]!, '国债0115', [securities[0]], 'confirm'],
    ['模糊产品 + 准确证券', '安联资管 稳在 三号', '金融债240201', [securities[2]], 'account'],
    ['准确产品 + 模糊证券', products[3]!, '国债', securities.slice(0, 2), 'security'],
    ['模糊产品 + 模糊证券', '安联资管 远建 十号', '债券', securities.slice(2, 5), 'account'],
  ])('normalizes %s without guessing ambiguous candidates', async (_label, accountQuery, securityQuery, matches, expectedStage) => {
    const searchSecurities = vi.fn(async () => matches as RiskSecuritySuggestion[]);
    const state = await normalizeRiskDraft(
      `${accountQuery}买1000万${securityQuery}`,
      { accountQuery, action: 'buy', securityQuery, amountText: '1000万', market: 'secondary' },
      mockRiskService({ searchSecurities }),
    );
    expect(state.stage).toBe(expectedStage);
    if (expectedStage !== 'account') {
      expect(searchSecurities).toHaveBeenCalledWith(securityQuery);
    } else {
      expect(searchSecurities).not.toHaveBeenCalled();
    }
    if (state.stage === 'security') {
      expect(state.securities).toEqual(matches);
      expect(buildIntentSelection(state, 123).options.at(-1)).toMatchObject({
        label: '其他',
        value: '__other_security__',
      });
    }
  });

  it('renders Other for zero account and zero security candidates, then accepts direct input', async () => {
    const noAccount = await normalizeRiskDraft(
      '不存在产品买1000万国债',
      { accountQuery: '不存在产品', action: 'buy', securityQuery: '国债', amountText: '1000万', market: 'secondary' },
      mockRiskService({ listProducts: vi.fn(async () => []) }),
    );
    expect(noAccount.stage).toBe('account');
    expect(buildIntentSelection(noAccount, 123).options).toEqual([
      { key: 'other', label: '其他', value: '__other_account__' },
    ]);

    const noSecurity = await normalizeSecurity(
      '安联纯债1号买1000万不存在证券',
      { accountQuery: products[0]!, action: 'buy', securityQuery: '不存在证券', amountText: '1000万', market: 'secondary' },
      products[0]!,
      mockRiskService({ searchSecurities: vi.fn(async () => []) }),
    );
    expect(noSecurity.stage).toBe('security');
    expect(buildIntentSelection(noSecurity, 123).options).toEqual([
      { key: 'other', label: '其他', value: '__other_security__' },
    ]);
  });

  it('keeps other freeform input undefined', async () => {
    const state: RiskIntentState = { stage: 'freeform', originalText: '交易', draft: { accountQuery: products[0]!, market: 'secondary' }, field: 'other', product: products[0]! };
    expect(await applyDirectRiskIntentInput(state, '补充说明', mockRiskService())).toBeUndefined();
  });

  it('switches a pending confirmation to a complete new transaction', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(mockRiskService({ calculatePretrade }));
    const first = await router.handle('matrix', '安联稳益3号 申购');
    expect(first).toMatchObject({ handled: true, intent: 'pretrade_calc' });
    const second = await router.handle('matrix', '安联远见10号 赎回 1000万');
    expect(second).toMatchObject({ handled: true, intent: 'pretrade_calc' });
    expect(calculatePretrade).toHaveBeenCalledWith(products[3], { type: 'redemption', market: 'secondary', amount: 0.1 }, undefined);
    expect(isPretradeIntentCandidate('安联远见10号 赎回 1000万')).toBe(true);
  });

  it('builds confirmation options for complete intent', () => {
    const state = { stage: 'confirm', originalText: '', product: products[0], draft: { accountQuery: products[0], action: 'repo', amountText: '1亿', days: 7, market: 'secondary' } } as RiskIntentState;
    const selection = buildIntentSelection(state as Extract<RiskIntentState, { stage: 'confirm' }>, 123);
    expect(selection.options.map((item) => item.key)).toEqual(['confirm', 'account', 'amount', 'market', 'other']);
  });

  it('parses complete AI output for canonical confirmation', () => {
    const draft = parseRiskIntentOutput('{"account_query":"安联远见10号","action":"reverse_repo","amount_text":"2亿","days":14}', '安联远见10号 逆回购 2亿 14天');
    expect(draft).toMatchObject({ action: 'reverse_repo', amountText: '2亿', days: 14, market: 'secondary' });
  });
});

describe('risk router service matrix', () => {
  it.each([
    ['buy', products[0]!, '买入', '国债0115', '0.1亿', '', { type: 'buy', market: 'secondary', amount: 0.1, security_name: '019115.SH' }],
    ['sell', products[1]!, '卖出', '短融1024001', '10张', '', { type: 'sell', market: 'secondary', quantity: 10, security_name: '1024001.IB' }],
    ['subscription', products[2]!, '申购', undefined, '500000元', '', { type: 'subscription', market: 'secondary', amount: 0.005 }],
    ['redemption', products[3]!, '赎回', undefined, '250份', '', { type: 'redemption', market: 'secondary', shares: 250 }],
    ['repo', products[1]!, '回购', undefined, '2亿', '7天', { type: 'repo', market: 'secondary', amount: 2, days: 7 }],
    ['reverse_repo', products[2]!, '逆回购', undefined, '3000万', '14天', { type: 'reverse_repo', market: 'secondary', amount: 0.3, days: 14 }],
  ])('submits the normalized RiskService payload for %s', async (action, product, verb, security, amountText, tenor, expectedAction) => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const service = mockRiskService({
      searchSecurities: vi.fn(async () => security ? securities.filter((item) => item.name === security) : []),
      calculatePretrade,
    });
    const router = new WeComRiskRouter(service);
    const result = await router.handle(
      `matrix-${action}`,
      [product, verb, amountText, security, tenor].filter(Boolean).join(' '),
    );
    if (result.handled && (action === 'buy' || action === 'sell') && result.selection) {
      await router.handle(`matrix-${action}`, '确认');
    }
    expect(result.handled).toBe(true);
    expect(calculatePretrade).toHaveBeenCalledWith(product, expectedAction, undefined);
  });

  it('requires a security choice for an ambiguous name and submits the selected code', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(mockRiskService({
      searchSecurities: vi.fn(async () => securities.slice(0, 2)),
      calculatePretrade,
    }));

    const choice = await router.handle('matrix-security-choice', `${products[0]} 买入 3000万 国债`);
    expect(choice).toMatchObject({
      handled: true,
      selection: { kind: 'security', options: expect.arrayContaining([{ key: '2', label: securities[1]!.label }]) },
    });
    expect(calculatePretrade).not.toHaveBeenCalled();

    await router.handle('matrix-security-choice', '2');
    expect(calculatePretrade).toHaveBeenCalledWith(
      products[0],
      { type: 'buy', market: 'secondary', amount: 0.3, security_name: '019116.SH' },
      undefined,
    );
  });

  it('does not calculate when a security has no candidates', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(mockRiskService({
      searchSecurities: vi.fn(async () => []),
      calculatePretrade,
    }));
    const result = await router.handle('matrix-security-none', `${products[1]} 卖出 1000万 不存在证券`);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.selection).toBeUndefined();
      expect(result.markdown).toContain('没有找到');
    }
    expect(calculatePretrade).not.toHaveBeenCalled();
  });

  it('resolves a fuzzy product choice before resolving an ambiguous security', async () => {
    const productChoices = ['安联稳益3号A资产管理产品', '安联稳益3号B资产管理产品'];
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(mockRiskService({
      listProducts: vi.fn(async () => productChoices),
      searchSecurities: vi.fn(async () => securities.slice(0, 2)),
      calculatePretrade,
    }));

    const account = await router.handle('matrix-both-fuzzy', '安联稳益3号 买入 1000万 国债');
    expect(account).toMatchObject({ handled: true, selection: { kind: 'product' } });
    const security = await router.handle('matrix-both-fuzzy', 'b');
    expect(security).toMatchObject({ handled: true, selection: { kind: 'security' } });
    await router.handle('matrix-both-fuzzy', '1');
    expect(calculatePretrade).toHaveBeenCalledWith(
      productChoices[1],
      { type: 'buy', market: 'secondary', amount: 0.1, security_name: '019115.SH' },
      undefined,
    );
  });

  it.each([
    ['买入 1000万 国债0115', '产品名'],
    [`${products[0]} 买入 1000万`, '证券名称或代码'],
    [`${products[0]} 逆回购 7天`, '金额'],
  ])('keeps incomplete transaction pending: %s', async (text, missing) => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const router = new WeComRiskRouter(mockRiskService({ calculatePretrade }));
    const result = await router.handle(`matrix-missing-${missing}`, text);
    expect(result).toMatchObject({ handled: true });
    if (result.handled) expect(result.markdown).toContain(missing);
    expect(calculatePretrade).not.toHaveBeenCalled();
  });
});

describe('RiskProgressRelay matrix', () => {
  it('merges, deduplicates, and preserves delivery order', async () => {
    const delivered: string[] = [];
    const relay = new RiskProgressRelay(async (message) => { delivered.push(message); });
    relay.push('  查询持仓  ');
    relay.push('查询持仓');
    relay.push('正在检查买入证券的禁投和关联方…');
    relay.push('正在检查信用类资产授信额度…');
    relay.push('完成');
    await relay.flush();
    expect(delivered).toEqual(['查询持仓', '正在依次检查买入证券的禁投、关联方及信用类资产授信额度…', '完成']);
  });
});
