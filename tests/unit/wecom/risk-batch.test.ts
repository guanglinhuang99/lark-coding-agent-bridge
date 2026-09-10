import { describe, expect, it, vi } from 'vitest';
import type { RiskSecuritySuggestion, RiskService } from '../../../src/wecom/risk/client';
import { WeComRiskRouter } from '../../../src/wecom/risk/router';
import {
  applySimpleRiskCorrection,
  confirmationSummary,
  confirmedRiskAmount,
  mergeRiskIntentDraft,
  normalizeRiskDraft,
  parseRiskIntentOutputPartial,
  resolveInitialRiskIntent,
  RiskIntentClarificationError,
  selectRiskIntentSecurity,
  type RiskAiDraft,
  type RiskIntentState,
} from '../../../src/wecom/risk/intent';

const product = '安联ESG纯债1号资产管理产品';
const esg1Product = '安联资产ESG1号资产管理产品';
const secondProduct = '安联全享多利6号资产管理产品';
const securities: Record<string, RiskSecuritySuggestion> = {
  '102583394.IB': {
    name: '25深圳特发MTN003',
    code: '102583394.IB',
    label: '25深圳特发MTN003 102583394.IB',
  },
  '232580009.IB': {
    name: '25中信银行二级资本债01BC',
    code: '232580009.IB',
    label: '25中信银行二级资本债01BC 232580009.IB',
  },
  '102600001.IB': {
    name: '一级发行信用债A',
    code: '102600001.IB',
    label: '一级发行信用债A 102600001.IB',
  },
};

const sampleTwoBondText = [
  '/测算',
  '我司【**ESG1号产品**】明天（9.9）拟投资以下信用债（信评系统已发起）。',
  '烦请风险管理部同事确认、ESG同事评估，非常感谢！',
  '1、 3.93Y 102583394.IB 25深圳特发MTN003 1.76 1000w',
  '2、3.69Y+5Y(休1) 232580009.IB 25中信银行二级资本债01BC 1.7125行权 4000w',
].join('\n');

function successfulCalculation(): Record<string, unknown> {
  return {
    status: 'success',
    product,
    result: {
      before: { status_counts: { PASS: 1 } },
      after: { status_counts: { PASS: 1 } },
      comparison: [],
    },
  };
}

function fakeService(overrides: Partial<RiskService> = {}): RiskService {
  return {
    listProducts: vi.fn(async () => [product]),
    searchSecurities: vi.fn(async (query: string) => {
      const exact = securities[query.trim().toUpperCase()];
      return exact ? [exact] : [];
    }),
    checkSecurity: vi.fn(async () => ({})),
    checkCounterparty: vi.fn(async () => ({})),
    getHoldings: vi.fn(async () => ({})),
    getRestrictions: vi.fn(async () => ({})),
    getCredit: vi.fn(async () => ({})),
    calculatePretrade: vi.fn(async () => successfulCalculation()),
    ...overrides,
  };
}

function batchState(
  transactions: Array<Record<string, unknown>>,
): Extract<RiskIntentState, { stage: 'confirm' }> {
  const first = transactions[0] ?? {};
  return {
    stage: 'confirm',
    originalText: 'ESG1号拟投资多只信用债',
    product,
    draft: {
      accountQuery: 'ESG1号',
      action: first.action as 'buy',
      amountText: String(first.amountText ?? ''),
      market: (first.market ?? 'secondary') as 'primary' | 'secondary',
      transactions: transactions as never,
    },
  };
}

function validTwoBuyDraft(): RiskAiDraft {
  return {
    accountQuery: 'ESG纯债1号',
    action: 'buy',
    amountText: '1000w',
    market: 'secondary',
    transactions: [
      {
        action: 'buy',
        securityQuery: '102583394.IB',
        amountText: '1000w',
        market: 'secondary',
      },
      {
        action: 'buy',
        securityQuery: '232580009.IB',
        amountText: '4000w',
        market: 'secondary',
      },
    ],
  };
}

describe('batch AI risk intent', () => {
  it('preserves account, date, and per-transaction bond metadata and source markets', () => {
    const originalText = [
      '我司ESG1号产品明天（9.9）拟投资以下信用债',
      '1、一级市场 102583394.IB 25深圳特发MTN003 1000w',
      '2、二级市场 232580009.IB 25中信银行二级资本债01BC 4000w',
    ].join('\n');
    const draft = parseRiskIntentOutputPartial(
      JSON.stringify({
        account_query: 'ESG1号',
        trade_date_text: '明天（9.9）',
        transactions: [
          {
            action: 'buy',
            security_query: '102583394.IB',
            amount_text: '1000w',
            tenor_text: '3.93Y',
            yield_text: '1.76',
            source_text: '一级市场',
          },
          {
            action: 'buy',
            security_query: '232580009.IB',
            amount_text: '4000w',
            tenor_text: '3.69Y+5Y(休1)',
            yield_text: '1.7125行权',
            source_text: '二级市场',
          },
        ],
      }),
      originalText,
    );

    expect(draft).toMatchObject({
      accountQuery: 'ESG1号',
      tradeDateText: '明天（9.9）',
      transactions: [
        {
          action: 'buy',
          securityQuery: '102583394.IB',
          amountText: '1000w',
          tenorText: '3.93Y',
          yieldText: '1.76',
          sourceText: '1、一级市场 102583394.IB 25深圳特发MTN003 1000w',
          market: 'primary',
        },
        {
          action: 'buy',
          securityQuery: '232580009.IB',
          amountText: '4000w',
          tenorText: '3.69Y+5Y(休1)',
          yieldText: '1.7125行权',
          sourceText: '2、二级市场 232580009.IB 25中信银行二级资本债01BC 4000w',
          market: 'secondary',
        },
      ],
    });
  });

  it('normalizes each transaction before confirmation and records the missing leg index', async () => {
    const searchSecurities = vi.fn(async (query: string) => {
      const exact = securities[query.trim().toUpperCase()];
      return exact ? [exact] : [];
    });
    const service = fakeService({ searchSecurities });
    const draft = parseRiskIntentOutputPartial(
      JSON.stringify({
        account_query: 'ESG纯债1号',
        transactions: [
          { action: 'buy', security_query: '102583394.IB', amount_text: '1000w', source_text: '二级市场' },
          { action: 'buy', security_query: '待确认证券', amount_text: '4000w', source_text: '二级市场' },
        ],
      }),
      'ESG纯债1号拟投资两只信用债\n1、二级市场 102583394.IB 1000w\n2、二级市场 待确认证券 4000w',
    );

    const state = await normalizeRiskDraft(
      'ESG纯债1号拟投资两只信用债\n1、二级市场 102583394.IB 1000w\n2、二级市场 待确认证券 4000w',
      draft,
      service,
    );

    expect(state).toMatchObject({
      stage: 'security',
      product,
      transactionIndex: 1,
      draft: {
        transactions: [
          { resolvedSecurity: { code: securities['102583394.IB']!.code } },
          { securityQuery: '待确认证券' },
        ],
      },
    });
    expect(searchSecurities).toHaveBeenNthCalledWith(1, '102583394.IB');
    expect(searchSecurities).toHaveBeenNthCalledWith(2, '待确认证券');
    expect(service.calculatePretrade).not.toHaveBeenCalled();
  });

  it('resolves independent batch securities concurrently with a four-query bound', async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let releaseFirstWave!: () => void;
    const firstWave = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
    const searchSecurities = vi.fn(async (query: string) => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      if (started <= 4) {
        if (started === 4) releaseFirstWave();
        await firstWave;
      }
      await Promise.resolve();
      active -= 1;
      return [{ name: query, code: query, label: query }];
    });
    const service = fakeService({ searchSecurities });
    const transactions = Array.from({ length: 8 }, (_, index) => ({
      action: 'buy' as const,
      securityQuery: `${100000000 + index}.IB`,
      amountText: '1000w',
      market: 'secondary' as const,
    }));
    const state = await normalizeRiskDraft(
      'ESG纯债1号拟投资八只信用债',
      {
        accountQuery: 'ESG纯债1号', action: 'buy', amountText: '1000w',
        market: 'secondary', transactions,
      },
      service,
    );

    expect(state.stage).toBe('confirm');
    expect(searchSecurities).toHaveBeenCalledTimes(8);
    expect(maxActive).toBe(4);
    expect(state.draft.transactions?.every((item) => Boolean(item.resolvedSecurity))).toBe(true);
  });

  it('advances a selected batch security and confirms after the final leg is resolved', async () => {
    const service = fakeService();
    const state = {
      stage: 'security',
      originalText: 'ESG1号拟投资多只信用债',
      product,
      securities: [securities['232580009.IB']!],
      transactionIndex: 1,
      draft: {
        accountQuery: 'ESG1号',
        market: 'secondary',
        transactions: [
          {
            action: 'buy',
            securityQuery: '102583394.IB',
            amountText: '1000w',
            market: 'secondary',
            resolvedSecurity: securities['102583394.IB'],
          },
          {
            action: 'buy',
            securityQuery: '232580009.IB',
            amountText: '4000w',
            market: 'secondary',
          },
        ],
      },
    } as Extract<RiskIntentState, { stage: 'security' }>;

    const next = await selectRiskIntentSecurity(state, securities['232580009.IB']!, service);

    expect(next).toMatchObject({
      stage: 'confirm',
      product,
      draft: {
        transactions: [
          { resolvedSecurity: { code: '102583394.IB' } },
          { resolvedSecurity: { code: '232580009.IB' } },
        ],
      },
    });
    expect(service.searchSecurities).not.toHaveBeenCalled();
    expect(service.calculatePretrade).not.toHaveBeenCalled();
  });

  it('accepts w amounts as yuan-scale billion amounts', () => {
    expect(confirmedRiskAmount('1000w')).toMatchObject({ amount: 0.1 });
    expect(confirmedRiskAmount('1000W')).toMatchObject({ amount: 0.1 });
  });

  it('keeps the complete two-bond input while waiting for account selection', async () => {
    const analyze = vi.fn(async (): Promise<RiskAiDraft> => ({
      accountQuery: 'ESG1号',
      action: 'buy',
      amountText: '1000w',
      market: 'secondary',
      tradeDateText: '明天（9.9）',
      transactions: [
        {
          action: 'buy',
          securityQuery: '102583394.IB',
          amountText: '1000w',
          market: 'secondary',
          tenorText: '3.93Y',
          yieldText: '1.76',
          sourceText: '1、 3.93Y 102583394.IB 25深圳特发MTN003 1.76 1000w',
        },
        {
          action: 'buy',
          securityQuery: '232580009.IB',
          amountText: '4000w',
          market: 'secondary',
          tenorText: '3.69Y+5Y(休1)',
          yieldText: '1.7125行权',
          sourceText: '2、3.69Y+5Y(休1) 232580009.IB 25中信银行二级资本债01BC 1.7125行权 4000w',
        },
      ],
    }));
    const service = fakeService({
      listProducts: vi.fn(async () => ['安联ESG1号产品A', '安联ESG1号产品B']),
    });

    const state = await resolveInitialRiskIntent(sampleTwoBondText, service, analyze);

    expect(state).toMatchObject({
      stage: 'account',
      originalText: sampleTwoBondText,
      draft: {
        accountQuery: 'ESG1号',
        tradeDateText: '明天（9.9）',
        transactions: [
          { securityQuery: '102583394.IB', amountText: '1000w' },
          { securityQuery: '232580009.IB', amountText: '4000w' },
        ],
      },
      products: ['安联ESG1号产品A', '安联ESG1号产品B'],
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect(service.searchSecurities).not.toHaveBeenCalled();
    expect(service.calculatePretrade).not.toHaveBeenCalled();
  });

  it('rejects an AI batch that drops the last transaction from the original text', async () => {
    const analyze = vi.fn(async (): Promise<RiskAiDraft> => ({
      accountQuery: 'ESG1号',
      action: 'buy',
      amountText: '1000w',
      market: 'secondary',
      transactions: [
        {
          action: 'buy',
          securityQuery: '102583394.IB',
          amountText: '1000w',
          market: 'secondary',
        },
      ],
    }));
    const service = fakeService({
      listProducts: vi.fn(async () => ['安联ESG1号产品']),
    });

    await expect(resolveInitialRiskIntent(sampleTwoBondText, service, analyze)).rejects.toThrow(
      /证券清单未完整识别/,
    );
    expect(service.searchSecurities).not.toHaveBeenCalled();
    expect(service.calculatePretrade).not.toHaveBeenCalled();
  });

  it('changes only the selected transaction amount in a batch correction', () => {
    const state = batchState([
      {
        action: 'buy',
        market: 'secondary',
        amountText: '1000w',
        securityQuery: '102583394.IB',
      },
      {
        action: 'buy',
        market: 'secondary',
        amountText: '4000w',
        securityQuery: '232580009.IB',
      },
    ]);

    const changed = applySimpleRiskCorrection(state, '第2笔金额改为3000w');

    expect(changed).toMatchObject({
      stage: 'confirm',
      draft: {
        transactions: [
          { amountText: '1000w' },
          { amountText: '3000w' },
        ],
      },
    });
    expect(state.draft.transactions?.[0]?.amountText).toBe('1000w');
    expect(state.draft.transactions?.[1]?.amountText).toBe('4000w');
  });

  it('keeps a negative second-leg amount negative and returns that leg for amount completion', async () => {
    const previous = validTwoBuyDraft();
    const revised: RiskAiDraft = {
      ...previous,
      transactions: previous.transactions!.map((item, index) =>
        index === 1 ? { ...item, amountText: '-1000万' } : item,
      ),
    };
    const merged = mergeRiskIntentDraft(previous, revised, '第2笔金额改为-1000万');
    expect(merged.transactions?.[1]?.amountText).toBe('-1000万');

    const service = fakeService();
    const state = await normalizeRiskDraft(
      'ESG纯债1号拟投资两只信用债',
      merged,
      service,
    );

    expect(state).toMatchObject({
      stage: 'freeform',
      field: 'amount',
      transactionIndex: 1,
      draft: {
        transactions: [
          { amountText: '1000w' },
          { amountText: '-1000万' },
        ],
      },
    });
    expect(confirmedRiskAmount('-1000万')).toBeUndefined();
  });

  it('requires a transaction number for a multi-transaction amount correction', () => {
    const previous = validTwoBuyDraft();
    expect(() => mergeRiskIntentDraft(previous, previous, '金额改为3000万')).toThrow(/指定第几笔/);
  });

  it('clears stale security and bond metadata when the second security changes', () => {
    const previous: RiskAiDraft = {
      ...validTwoBuyDraft(),
      transactions: [
        ...validTwoBuyDraft().transactions!.slice(0, 1),
        {
          action: 'buy',
          securityQuery: '232580009.IB',
          amountText: '4000w',
          market: 'secondary',
          resolvedSecurity: securities['232580009.IB'],
          tenorText: '3.69Y+5Y(休1)',
          yieldText: '1.7125行权',
          sourceText: '2、二级市场 232580009.IB 4000w',
        },
      ],
    };
    const revised: RiskAiDraft = {
      ...previous,
      transactions: previous.transactions!.map((item, index) =>
        index === 1 ? { ...item, securityQuery: '102600001.IB' } : item,
      ),
    };

    const changed = mergeRiskIntentDraft(previous, revised, '第2笔证券改为102600001.IB');
    const second = changed.transactions?.[1];
    expect(second).toMatchObject({ securityQuery: '102600001.IB' });
    expect(second?.resolvedSecurity).toBeUndefined();
    expect(second?.tenorText).toBeUndefined();
    expect(second?.yieldText).toBeUndefined();
    expect(changed.transactions?.[0]).toMatchObject({ securityQuery: '102583394.IB' });
  });

  it('uses each full source_text row for market detection instead of inheriting the first row', () => {
    const originalText = [
      'ESG纯债1号产品拟投资以下信用债',
      '1、一级市场 102583394.IB 25深圳特发MTN003 1000w',
      '2、232580009.IB 25中信银行二级资本债01BC 4000w',
    ].join('\n');
    const draft = parseRiskIntentOutputPartial(
      JSON.stringify({
        account_query: 'ESG纯债1号',
        transactions: [
          {
            action: 'buy',
            security_query: '102583394.IB',
            amount_text: '1000w',
            source_text: '1、一级市场 102583394.IB 25深圳特发MTN003 1000w',
          },
          {
            action: 'buy',
            security_query: '232580009.IB',
            amount_text: '4000w',
            source_text: '2、232580009.IB 25中信银行二级资本债01BC 4000w',
          },
        ],
      }),
      originalText,
    );

    expect(draft.transactions).toMatchObject([
      {
        sourceText: '1、一级市场 102583394.IB 25深圳特发MTN003 1000w',
        market: 'primary',
      },
      {
        sourceText: '2、232580009.IB 25中信银行二级资本债01BC 4000w',
        market: 'secondary',
      },
    ]);
  });
});

describe('batch router confirmation', () => {
  it('does not calculate before confirmation and submits two buys once with 0.1 and 0.4', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const service = fakeService({ calculatePretrade });
    const router = new WeComRiskRouter(service);
    const state = batchState([
      {
        action: 'buy',
        market: 'secondary',
        amountText: '1000w',
        securityQuery: '102583394.IB',
        resolvedSecurity: securities['102583394.IB'],
      },
      {
        action: 'buy',
        market: 'secondary',
        amountText: '4000w',
        securityQuery: '232580009.IB',
        resolvedSecurity: securities['232580009.IB'],
      },
    ]);

    expect(calculatePretrade).not.toHaveBeenCalled();
    await router.executeConfirmed(state);

    expect(calculatePretrade).toHaveBeenCalledTimes(1);
    expect(calculatePretrade).toHaveBeenCalledWith(
      product,
      [
        { type: 'buy', market: 'secondary', amount: 0.1, security_name: '102583394.IB' },
        { type: 'buy', market: 'secondary', amount: 0.4, security_name: '232580009.IB' },
      ],
      undefined,
    );
  });

  it('rejects an invalid leg without submitting any part of the batch', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const service = fakeService({ calculatePretrade });
    const router = new WeComRiskRouter(service);
    const state = batchState([
      {
        action: 'buy',
        market: 'secondary',
        amountText: '1000w',
        securityQuery: '102583394.IB',
        resolvedSecurity: securities['102583394.IB'],
      },
      {
        action: 'buy',
        market: 'secondary',
        amountText: '1.7125行权',
        securityQuery: '232580009.IB',
        resolvedSecurity: securities['232580009.IB'],
      },
    ]);

    const result = await router.executeConfirmed(state);

    expect(result).toMatchObject({ handled: true, intent: 'risk-error' });
    expect(calculatePretrade).not.toHaveBeenCalled();
  });

  it('submits three primary subscriptions once, even when one bond name contains 二级资本债', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const service = fakeService({
      calculatePretrade,
      searchSecurities: vi.fn(async (query: string) => {
        const normalized = query.trim().toUpperCase();
        if (normalized === '一级发行信用债A') return [securities['102600001.IB']!];
        if (normalized === '25深圳特发MTN003') return [securities['102583394.IB']!];
        if (normalized === '25中信银行二级资本债01BC') return [securities['232580009.IB']!];
        return [];
      }),
    });
    const router = new WeComRiskRouter(service);
    const originalText = [
      'ESG纯债1号产品拟投资以下信用债',
      '1、一级市场 一级发行信用债A 1000w',
      '2、一级市场 25深圳特发MTN003 2000w',
      '3、一级市场 25中信银行二级资本债01BC 3000w',
    ].join('\n');
    const draft = parseRiskIntentOutputPartial(
      JSON.stringify({
        account_query: 'ESG纯债1号',
        transactions: [
          { action: 'subscription', security_query: '一级发行信用债A', amount_text: '1000w', source_text: '一级市场' },
          { action: 'subscription', security_query: '25深圳特发MTN003', amount_text: '2000w', source_text: '一级市场' },
          { action: 'subscription', security_query: '25中信银行二级资本债01BC', amount_text: '3000w', source_text: '一级市场' },
        ],
      }),
      originalText,
    );

    const beforeConfirmation = await normalizeRiskDraft(originalText, draft, service);

    expect(beforeConfirmation).toMatchObject({
      stage: 'confirm',
      draft: {
        transactions: [
          { market: 'primary', resolvedSecurity: { code: '102600001.IB' } },
          { market: 'primary', resolvedSecurity: { code: '102583394.IB' } },
          { market: 'primary', resolvedSecurity: { code: '232580009.IB' } },
        ],
      },
    });
    expect(calculatePretrade).not.toHaveBeenCalled();
    if (beforeConfirmation.stage !== 'confirm') throw new Error('expected confirmation state');

    await router.executeConfirmed(beforeConfirmation);

    expect(calculatePretrade).toHaveBeenCalledTimes(1);
    expect(calculatePretrade).toHaveBeenCalledWith(
      product,
      [
        { type: 'subscription', market: 'primary', amount: 0.1, security_name: '102600001.IB' },
        { type: 'subscription', market: 'primary', amount: 0.2, security_name: '102583394.IB' },
        { type: 'subscription', market: 'primary', amount: 0.3, security_name: '232580009.IB' },
      ],
      undefined,
    );
  });

  it('keeps mixed markets per transaction when source_text is explicit', async () => {
    const draft = parseRiskIntentOutputPartial(
      JSON.stringify({
        account_query: 'ESG纯债1号',
        transactions: [
          { action: 'subscription', security_query: '102583394.IB', amount_text: '1000w', source_text: '一级市场申购' },
          { action: 'buy', security_query: '232580009.IB', amount_text: '4000w', source_text: '二级市场买入' },
        ],
      }),
      'ESG纯债1号拟投资两笔债券\n1、一级市场申购 102583394.IB 1000w\n2、二级市场买入 232580009.IB 4000w',
    );

    expect(draft.transactions).toMatchObject([
      { action: 'subscription', market: 'primary' },
      { action: 'buy', market: 'secondary' },
    ]);
  });
});

describe('multi-account pretrade batches', () => {
  const text = [
    '测算',
    'ESG1号拟投资26粤铁建MTN005 4000万、26中银金租债03BC 4000w',
    '全享多利6号拟投资26粤铁建MTN005 1000万、26中银金租债03BC 1000w',
  ].join('\n');
  const yue = { name: '26粤铁建MTN005', code: '102683578.IB', label: '26粤铁建MTN005 102683578.IB' };
  const yueOther = { name: '26粤铁建MTN005', code: '102683579.IB', label: '26粤铁建MTN005 102683579.IB' };
  const boc = { name: '26中银金租债03BC', code: '262680003.IB', label: '26中银金租债03BC 262680003.IB' };

  function parsedDraft(): RiskAiDraft {
    return parseRiskIntentOutputPartial(JSON.stringify({
      accounts: [
        {
          account_query: 'ESG1号',
          transactions: [
            { action: 'buy', security_query: yue.name, amount_text: '4000万', source_text: text.split('\n')[1] },
            { action: 'buy', security_query: boc.name, amount_text: '4000w', source_text: text.split('\n')[1] },
          ],
        },
        {
          account_query: '全享多利6号',
          transactions: [
            { action: 'buy', security_query: yue.name, amount_text: '1000万', source_text: text.split('\n')[2] },
            { action: 'buy', security_query: boc.name, amount_text: '1000w', source_text: text.split('\n')[2] },
          ],
        },
      ],
    }), text);
  }

  it('parses two accounts with two transactions each in source order', () => {
    const draft = parsedDraft();
    expect(draft.accounts?.map(account => ({
      account: account.accountQuery,
      amounts: account.transactions.map(transaction => transaction.amountText),
    }))).toEqual([
      { account: 'ESG1号', amounts: ['4000万', '4000w'] },
      { account: '全享多利6号', amounts: ['1000万', '1000w'] },
    ]);
  });

  it('uses the deterministic path for the two-account line format without AI', async () => {
    const traditionalText = text.replaceAll('粤', '粵');
    const analyze = vi.fn(async () => parsedDraft());
    const service = fakeService({
      listProducts: vi.fn(async () => [esg1Product, secondProduct]),
      searchSecurities: vi.fn(async (query: string) => query.includes('粤') || query.includes('粵') ? [yue] : [boc]),
    });

    const state = await resolveInitialRiskIntent(traditionalText, service, analyze);

    expect(analyze).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      stage: 'confirm',
      draft: { accounts: [
        { resolvedProduct: esg1Product, transactions: [{ amountText: '4000万' }, { amountText: '4000w' }] },
        { resolvedProduct: secondProduct, transactions: [{ amountText: '1000万' }, { amountText: '1000w' }] },
      ] },
    });
  });

  it.each(['拟投', '投'])('uses AI fallback for multi-account “%s” input and continues to confirmation', async (verb) => {
    const fallbackText = [
      '测算',
      `ESG1号${verb}26粤铁建MTN005 4000万、26中银金租债03BC 4000w`,
      `全享多利6号${verb}26粤铁建MTN005 1000万、26中银金租债03BC 1000w`,
    ].join('\n');
    const aiDraft = parsedDraft();
    aiDraft.accounts = aiDraft.accounts?.map((account, accountIndex) => ({
      ...account,
      transactions: account.transactions.map(transaction => ({
        ...transaction,
        sourceText: fallbackText.split('\n')[accountIndex + 1],
      })),
    }));
    const analyze = vi.fn(async () => aiDraft);
    const searchSecurities = vi.fn(async (query: string) => query === yue.name ? [yue] : [boc]);
    const service = fakeService({
      listProducts: vi.fn(async () => [esg1Product, secondProduct]),
      searchSecurities,
    });

    const state = await resolveInitialRiskIntent(fallbackText, service, analyze);

    expect(analyze).toHaveBeenCalledOnce();
    expect(searchSecurities).toHaveBeenCalledTimes(4);
    expect(state).toMatchObject({
      stage: 'confirm',
      draft: {
        accounts: [
          { resolvedProduct: esg1Product, transactions: [{ amountText: '4000万' }, { amountText: '4000w' }] },
          { resolvedProduct: secondProduct, transactions: [{ amountText: '1000万' }, { amountText: '1000w' }] },
        ],
      },
    });
  });

  it('keeps an AI extraction failure inside the risk flow as a clarification error', async () => {
    const fallbackText = [
      '/测算',
      'ESG1号拟投26粤铁建MTN005 4000万、26中银金租债03BC 4000w',
      '全享多利6号拟投26粤铁建MTN005 1000万、26中银金租债03BC 1000w',
    ].join('\n');
    const analyze = vi.fn(async (): Promise<RiskAiDraft> => {
      throw new RiskIntentClarificationError(['交易信息无法确认']);
    });
    const searchSecurities = vi.fn(async () => [yue]);
    const service = fakeService({
      listProducts: vi.fn(async () => [esg1Product, secondProduct]),
      searchSecurities,
    });

    await expect(resolveInitialRiskIntent(fallbackText, service, analyze)).rejects.toMatchObject({
      name: 'RiskIntentClarificationError',
      missing: ['交易信息无法确认'],
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect(searchSecurities).not.toHaveBeenCalled();
  });

  it('rejects a model result that collapses multiple account blocks', async () => {
    const aiText = `请协助核对以下交易\n${text}`;
    const collapsed: RiskAiDraft = {
      accountQuery: 'ESG1号', market: 'secondary',
      transactions: parsedDraft().accounts![0]!.transactions,
    };
    const service = fakeService({ listProducts: vi.fn(async () => [esg1Product, secondProduct]) });

    await expect(resolveInitialRiskIntent(aiText, service, async () => collapsed))
      .rejects.toThrow('多账户交易清单未完整识别');
  });

  it('requires an account index for corrections and changes only the targeted account', () => {
    const previous = parsedDraft();
    expect(() => mergeRiskIntentDraft(previous, previous, '第1笔金额改为2000万'))
      .toThrow('请指定账户');

    const merged = mergeRiskIntentDraft(previous, previous, '第2个账户 第1笔金额改为2000万');

    expect(merged.accounts?.[0]?.transactions.map(item => item.amountText)).toEqual(['4000万', '4000w']);
    expect(merged.accounts?.[1]?.transactions.map(item => item.amountText)).toEqual(['2000万', '1000w']);
  });

  it('advances a security-disambiguation cursor across accounts', async () => {
    const service = fakeService({
      listProducts: vi.fn(async () => [esg1Product, secondProduct]),
      searchSecurities: vi.fn(async (query: string) => query === yue.name ? [yue, yueOther] : [boc]),
    });
    const first = await normalizeRiskDraft(text, parsedDraft(), service);
    expect(first).toMatchObject({ stage: 'security', accountIndex: 0, transactionIndex: 0, product: esg1Product });
    if (first.stage !== 'security') throw new Error('expected first security selection');
    const second = await selectRiskIntentSecurity(first, yue, service);
    expect(second).toMatchObject({ stage: 'security', accountIndex: 1, transactionIndex: 0, product: secondProduct });
    if (second.stage !== 'security') throw new Error('expected second security selection');
    const confirmed = await selectRiskIntentSecurity(second, yue, service);
    expect(confirmed).toMatchObject({
      stage: 'confirm',
      draft: { accounts: [
        { resolvedProduct: esg1Product, transactions: [{ resolvedSecurity: { code: yue.code } }, { resolvedSecurity: { code: boc.code } }] },
        { resolvedProduct: secondProduct, transactions: [{ resolvedSecurity: { code: yue.code } }, { resolvedSecurity: { code: boc.code } }] },
      ] },
    });
  });

  it('validates globally, then calculates each account once with its own two actions', async () => {
    const calculatePretrade = vi.fn(async (selectedProduct: string) => ({
      ...successfulCalculation(), product: selectedProduct,
    }));
    const service = fakeService({
      listProducts: vi.fn(async () => [esg1Product, secondProduct]),
      searchSecurities: vi.fn(async (query: string) => query === yue.name ? [yue] : [boc]),
      calculatePretrade,
    });
    const state = await normalizeRiskDraft(text, parsedDraft(), service);
    expect(state.stage).toBe('confirm');
    if (state.stage !== 'confirm') throw new Error('expected confirmation');
    expect(confirmationSummary(state)).toContain('多个账户、共4笔；按账户分别测算');

    const result = await new WeComRiskRouter(service).executeConfirmed(state);

    expect(result).toMatchObject({ handled: true, intent: 'pretrade_calc' });
    expect(calculatePretrade).toHaveBeenCalledTimes(2);
    expect(calculatePretrade).toHaveBeenNthCalledWith(1, esg1Product, [
      { type: 'buy', market: 'secondary', amount: 0.4, security_name: yue.code },
      { type: 'buy', market: 'secondary', amount: 0.4, security_name: boc.code },
    ], undefined);
    expect(calculatePretrade).toHaveBeenNthCalledWith(2, secondProduct, [
      { type: 'buy', market: 'secondary', amount: 0.1, security_name: yue.code },
      { type: 'buy', market: 'secondary', amount: 0.1, security_name: boc.code },
    ], undefined);
  });

  it('continues with later accounts when one account returns a failed result', async () => {
    const calculatePretrade = vi.fn(async (selectedProduct: string) => selectedProduct === esg1Product
      ? { status: 'error', error: 'first account failed' }
      : { ...successfulCalculation(), product: selectedProduct });
    const service = fakeService({
      listProducts: vi.fn(async () => [esg1Product, secondProduct]),
      searchSecurities: vi.fn(async (query: string) => query === yue.name ? [yue] : [boc]),
      calculatePretrade,
    });
    const state = await normalizeRiskDraft(text, parsedDraft(), service);
    if (state.stage !== 'confirm') throw new Error('expected confirmation');

    const result = await new WeComRiskRouter(service).executeConfirmed(state);

    expect(calculatePretrade).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ handled: true, intent: 'pretrade_calc' });
    if (!result.handled) throw new Error('expected handled result');
    expect(result.markdown).toContain('1个成功，1个失败');
    expect(result.markdown).toContain(`账户2：${secondProduct}`);
  });

  it('submits no account when validation fails in a later account', async () => {
    const calculatePretrade = vi.fn(async () => successfulCalculation());
    const service = fakeService({
      listProducts: vi.fn(async () => [esg1Product, secondProduct]),
      searchSecurities: vi.fn(async (query: string) => query === yue.name ? [yue] : [boc]),
      calculatePretrade,
    });
    const state = await normalizeRiskDraft(text, parsedDraft(), service);
    if (state.stage !== 'confirm' || !state.draft.accounts) throw new Error('expected confirmation');
    state.draft.accounts[1]!.transactions[1]!.amountText = '金额待定';

    const result = await new WeComRiskRouter(service).executeConfirmed(state);

    expect(result).toMatchObject({ handled: true, intent: 'risk-error' });
    expect(calculatePretrade).not.toHaveBeenCalled();
  });
});


describe('real-model code and name output normalization', () => {
  it('uses the unique code when Luna returns the code together with the name', () => {
    const draft = parseRiskIntentOutputPartial(JSON.stringify({account_query: '测试账户甲', transactions: [
      {action: 'buy', security_query: '900000001.ib 虚构测试债券甲', amount_text: '120w'},
      {action: 'buy', security_query: '900000002.IB 虚构测试银行二级资本债', amount_text: '340w'},
    ]}), '测试账户甲拟投资以下信用债\n1、900000001.ib 虚构测试债券甲 120w\n2、900000002.IB 虚构测试银行二级资本债 340w');
    expect(draft.transactions?.map(item => item.securityQuery)).toEqual(['900000001.IB', '900000002.IB']);
  });

  it('does not silently pick one code when a model merges two securities into one leg', () => {
    expect(() => parseRiskIntentOutputPartial(JSON.stringify({account_query: '测试账户甲', transactions: [
      {action: 'buy', security_query: '900000001.IB 900000002.IB', amount_text: '460w'},
    ]}), '测试账户甲拟买入两只证券')).toThrow('单笔含多个证券代码');
  });
});


describe('real-model source excerpt fallback', () => {
  it('uses the original row and shared primary heading instead of model-added wording', () => {
    const row = '1、900000001.IB 虚构债券 120w';
    const draft = parseRiskIntentOutputPartial(JSON.stringify({ account_query: '测试账户甲', transactions: [
      { action: 'subscription', security_query: '900000001.IB', amount_text: '120w', source_text: '一级市场申购：'+row },
    ]}), '测试账户甲拟在一级市场申购以下债券：\n'+row);
    expect(draft.transactions?.[0]).toMatchObject({ market: 'primary', sourceText: row });
  });

  it('does not accept a model-added primary marker when the original transaction is secondary', () => {
    const row = '1、900000001.IB 虚构债券 120w';
    const draft = parseRiskIntentOutputPartial(JSON.stringify({ account_query: '测试账户甲', transactions: [
      { action: 'buy', security_query: '900000001.IB', amount_text: '120w', source_text: '一级市场：'+row },
    ]}), '测试账户甲拟买入以下债券：\n'+row);
    expect(draft.transactions?.[0]).toMatchObject({ market: 'secondary', sourceText: row });
  });

  it('requires clarification when an invalid excerpt matches multiple original rows', () => {
    expect(() => parseRiskIntentOutputPartial(JSON.stringify({ account_query: '测试账户甲', transactions: [
      { action: 'buy', security_query: '900000001.IB', amount_text: '120w', source_text: '模型改写的摘录' },
    ]}), '测试账户甲\n1、一级 900000001.IB 120w\n2、二级 900000001.IB 340w')).toThrow('无法唯一定位交易原文');
  });
});

describe('copied ESG account input', () => {
  it.each(['ESG1号产品', ''])('resolves the account and keeps both bonds: %s', async (accountQuery) => {
    const text = sampleTwoBondText.replace('1000w', '1000w&#x20;') + '。';
    const draft = parseRiskIntentOutputPartial(JSON.stringify({
      account_query: accountQuery,
      transactions: [
        { action: 'buy', security_query: '102583394.IB', amount_text: '1000w' },
        { action: 'buy', security_query: '232580009.IB', amount_text: '4000w' },
      ],
    }), text);
    const formal = '安联资产ESG1号资产管理产品';
    const service = fakeService({ listProducts: vi.fn(async () => [product, formal]) });
    const state = await normalizeRiskDraft(text, draft, service);
    expect(state).toMatchObject({ stage: 'confirm', product: formal });
    expect(state.draft.transactions).toHaveLength(2);
    expect(service.calculatePretrade).not.toHaveBeenCalled();
  });
});
