import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  buildIntentSelection, confirmationSummary, normalizeSecurity, selectRiskIntentSecurity,
  type RiskIntentState,
} from '../../../src/wecom/risk/intent';

// Exercise the actual CLI callbacks with transport replaced, without connecting a bot.
function setup() {
  const source = readFileSync('src/wecom/cli.ts', 'utf8');
  const block = source.slice(source.indexOf('async function finishRiskIntentState('), source.indexOf('async function runCodexPrompt('));
  const events: string[] = [];
  const service = { searchSecurities: vi.fn(async (code: string) => [{ code, name: code, label: code }]) };
  const states = new Map();
  const context: any = {
    Buffer, Date, riskClient: service, riskIntents: states, buildIntentSelection, confirmationSummary,
    normalizeSecurity, selectRiskIntentSecurity,
    streamMaxBytes: 1200,
    renderWeComNotice: (_title: string, lines: string[]) => lines.join('\n'),
    truncateUtf8: (value: string) => value,
    sendRiskMarkdown: vi.fn(async () => { events.push('details'); }),
    scheduleRiskSelectionCard: vi.fn(() => { events.push('card'); }),
    client: { updateTemplateCard: vi.fn(async () => {}) },
    updateRiskCardBestEffort: async (fn: () => Promise<void>) => fn(),
    buildRiskSelectionStatusCard: vi.fn(),
    executeRiskCardSelection: vi.fn(async () => {}),
    log: { fail: vi.fn() },
  };
  vm.runInNewContext(ts.transpileModule(block + '\nglobalThis.api={finishRiskIntentState,handleRiskIntentChoice,riskIntentInputPrompt};', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return { ...context, ...context.api, events, service, states };
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

describe('batch risk CLI presentation and selection', () => {
  it('keeps the leg index when Other is chosen for an ambiguous security', async () => {
    const api = setup();
    await api.handleRiskIntentChoice({}, {}, 'conversation', 'task', pending(), '__other_security__', '其他');
    const state = api.states.get('conversation');
    expect(state).toMatchObject({ stage: 'freeform', field: 'security', transactionIndex: 1 });
    expect(state.draft.transactions).toHaveLength(3);
    expect(api.riskIntentInputPrompt(state)).toContain('第2笔');
    expect(api.executeRiskCardSelection).not.toHaveBeenCalled();
  });

  it('resolves a selected leg and the remaining securities before offering whole-batch confirmation', async () => {
    const api = setup();
    const state = pending();
    await api.handleRiskIntentChoice({}, {}, 'conversation', 'task', state, JSON.stringify(state.securities[0]), '虚构债乙');
    const next = api.states.get('conversation');
    expect(next.stage).toBe('confirm');
    expect(next.draft.transactions.map((item: any) => item.resolvedSecurity.code)).toEqual([
      '900000001.IB', '900000002.IB', '900000003.IB',
    ]);
    expect(api.executeRiskCardSelection).not.toHaveBeenCalled();
    expect(api.scheduleRiskSelectionCard).toHaveBeenCalledOnce();
  });

  it('sends every detail of a long batch before registering its confirmation card', async () => {
    const api = setup();
    const transactions = Array.from({ length: 35 }, (_, index) => ({
      action: 'buy' as const, amountText: `${index + 1}w`, market: 'primary' as const,
      resolvedSecurity: { code: `${900000001 + index}.IB`, name: `虚构测试债券第${index + 1}只`, label: '虚构债' },
    }));
    const state: Extract<RiskIntentState, { stage: 'confirm' }> = {
      stage: 'confirm', originalText: '长清单', product: '测试账户',
      draft: { accountQuery: '测试账户', action: 'buy', amountText: '1w', market: 'primary', transactions },
    };
    const stream = { finish: vi.fn(async () => {}) };
    await api.finishRiskIntentState({}, 'conversation', stream, state);
    const chunks = api.sendRiskMarkdown.mock.calls.map((call: any[]) => call[1]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(confirmationSummary(state));
    expect(chunks.every((chunk: string) => Buffer.byteLength(chunk) <= 688)).toBe(true);
    expect(api.events.at(-1)).toBe('card');
    expect(api.scheduleRiskSelectionCard.mock.calls[0][2].subTitle).toContain('共35笔');
    expect(api.executeRiskCardSelection).not.toHaveBeenCalled();
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
