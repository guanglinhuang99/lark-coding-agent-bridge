import { describe, expect, it, vi } from 'vitest';
import type { RiskService } from '../../../src/wecom/risk/client';
import { RiskSelectionTaskRegistry } from '../../../src/wecom/risk/card';
import {
  confirmationSummary,
  type RiskIntentState,
} from '../../../src/wecom/risk/intent';
import {
  RiskInteractionController,
  riskIntentInputPrompt,
} from '../../../src/wecom/risk/interaction';
import { RiskStateRegistry } from '../../../src/wecom/risk/state';

function setup() {
  const states = new RiskStateRegistry();
  const events: string[] = [];
  const service: RiskService = {
    listProducts: vi.fn(async () => ['测试账户']),
    searchSecurities: vi.fn(async (code: string) => [{ code, name: code, label: code }]),
    calculatePretrade: vi.fn(async () => ({ status: 'success', result: {} })),
    getHoldings: vi.fn(async () => ({})),
    getRestrictions: vi.fn(async () => ({})),
    getCredit: vi.fn(async () => ({})),
    checkSecurity: vi.fn(async () => ({})),
    checkCounterparty: vi.fn(async () => ({})),
  };
  const controller = new RiskInteractionController({
    riskClient: service,
    riskStates: states,
    riskSelectionTasks: new RiskSelectionTaskRegistry(),
    conversationQueue: { submit: vi.fn() } as never,
    runGate: { run: async <T>(fn: () => Promise<T>) => fn() },
    startingRuns: new Set(),
    streamMaxBytes: 1200,
    selectionCardDelayMs: 0,
    refreshHealth: vi.fn(async () => {}),
    isRiskUserAllowed: () => true,
    updateTemplateCard: vi.fn(async () => {}),
    sendMarkdownMessage: vi.fn(async () => {}),
    sendControlCardMessage: vi.fn(async () => { events.push('card'); }),
    createRiskTaskId: () => 'risk-test',
  });
  return { controller, events, service, states };
}

function pending(): Extract<RiskIntentState, { stage: 'security' }> {
  return {
    stage: 'security', originalText: '测试账户拟投资债券', product: '测试账户', transactionIndex: 1,
    securities: [{ code: '900000002.IB', name: '虚构债乙', label: '虚构债乙' }],
    draft: {
      accountQuery: '测试账户', market: 'primary', transactions: [
        { action: 'buy', amountText: '120w', market: 'primary', securityQuery: '900000001.IB',
          resolvedSecurity: { code: '900000001.IB', name: '虚构债甲', label: '虚构债甲' } },
        { action: 'buy', amountText: '340w', market: 'secondary', securityQuery: '虚构债乙' },
        { action: 'buy', amountText: '560w', market: 'primary', securityQuery: '900000003.IB' },
      ],
    },
  };
}

describe('batch risk interaction presentation and selection', () => {
  it('keeps the leg index when Other is chosen for an ambiguous security', async () => {
    const api = setup();
    const execute = vi.spyOn(api.controller, 'executeSelection');
    await api.controller.handleIntentChoice(
      {} as never,
      {},
      'conversation',
      'task',
      pending(),
      '__other_security__',
      '其他',
    );
    const state = api.states.getPretrade('conversation');
    expect(state).toMatchObject({ stage: 'freeform', field: 'security', transactionIndex: 1 });
    if (state?.stage !== 'freeform') throw new Error('expected freeform state');
    expect(state.draft.transactions).toHaveLength(3);
    expect(riskIntentInputPrompt(state)).toContain('第2笔');
    expect(execute).not.toHaveBeenCalled();
  });

  it('resolves a selected leg and remaining securities before offering whole-batch confirmation', async () => {
    const api = setup();
    const schedule = vi.spyOn(api.controller, 'scheduleSelectionCard').mockImplementation(() => {});
    const execute = vi.spyOn(api.controller, 'executeSelection');
    const state = pending();
    await api.controller.handleIntentChoice(
      {} as never,
      {},
      'conversation',
      'task',
      state,
      JSON.stringify(state.securities[0]),
      '虚构债乙',
    );
    const next = api.states.getPretrade('conversation');
    expect(next?.stage).toBe('confirm');
    if (next?.stage !== 'confirm') throw new Error('expected confirm state');
    expect(next.draft.transactions?.map((item) => item.resolvedSecurity?.code)).toEqual([
      '900000001.IB', '900000002.IB', '900000003.IB',
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledOnce();
  });

  it('sends every detail of a long batch before registering its confirmation card', async () => {
    const api = setup();
    const sent: string[] = [];
    vi.spyOn(api.controller, 'sendRiskMarkdown').mockImplementation(async (_body, content) => {
      sent.push(content);
    });
    const schedule = vi.spyOn(api.controller, 'scheduleSelectionCard').mockImplementation(() => {});
    const transactions = Array.from({ length: 35 }, (_, index) => ({
      action: 'buy' as const, amountText: `${index + 1}w`, market: 'primary' as const,
      resolvedSecurity: { code: `${900000001 + index}.IB`, name: `虚构测试债券第${index + 1}只`, label: '虚构债' },
    }));
    const state: Extract<RiskIntentState, { stage: 'confirm' }> = {
      stage: 'confirm', originalText: '长清单', product: '测试账户',
      draft: { accountQuery: '测试账户', action: 'buy', amountText: '1w', market: 'primary', transactions },
    };
    const stream = { update: vi.fn(async () => {}), finish: vi.fn(async () => {}) };
    await api.controller.finishIntentState({}, 'conversation', stream, state);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join('')).toBe(confirmationSummary(state));
    expect(sent.every((chunk) => Buffer.byteLength(chunk) <= 688)).toBe(true);
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule.mock.calls[0]?.[2].subTitle).toContain('共35笔');
  });
});

// A correction may mention the old and new code; only the initial-list coverage gate
// should reject a single-object extraction of multiple original transactions.
describe('single-transaction correction compatibility', () => {
  it('allows the legacy output schema while replacing a single security', async () => {
    const { parseRiskIntentOutputPartial } = await import('../../../src/wecom/risk/intent');
    const draft = parseRiskIntentOutputPartial(JSON.stringify({
      account_query: '测试账户', action: 'buy', security_query: '900000002.IB', amount_text: '120w',
    }), '测试账户买入120w 900000001.IB 证券改为900000002.IB');
    expect(draft.securityQuery).toBe('900000002.IB');
    expect(draft.transactions).toBeUndefined();
  });
});
