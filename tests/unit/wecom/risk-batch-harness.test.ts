import { describe, expect, it, vi } from 'vitest';
import * as intentApi from '../../../src/wecom/risk/intent';
import { WeComRiskRouter } from '../../../src/wecom/risk/router';
import { RiskSelectionTaskRegistry, buildRiskSelectionCard } from '../../../src/wecom/risk/card';

// @ts-expect-error The benchmark harness is an executable .mjs fixture without a project declaration.
import { runCalculationOnly, runIntentChain } from '../../../docs/benchmarks/risk-live-2026-09-08/harness/risk-live-intent-chain.mjs';

const product = '安联ESG纯债1号资产管理产品';
const state = {
  stage: 'confirm',
  originalText: 'ESG1号产品拟投资两只信用债',
  product,
  draft: {
    accountQuery: 'ESG1号',
    action: 'buy',
    amountText: '1000w',
    market: 'secondary',
    transactions: [
      {
        action: 'buy',
        amountText: '1000w',
        market: 'secondary',
        resolvedSecurity: { name: '债券A', code: '102583394.IB', label: '债券A 102583394.IB' },
      },
      {
        action: 'buy',
        amountText: '4000w',
        market: 'secondary',
        resolvedSecurity: { name: '债券B', code: '232580009.IB', label: '债券B 232580009.IB' },
      },
    ],
  },
};

const expected = {
  product,
  actions: [
    { type: 'buy', market: 'secondary', amount: 0.1, securityCode: '102583394.IB' },
    { type: 'buy', market: 'secondary', amount: 0.4, securityCode: '232580009.IB' },
  ],
};

function confirmedRiskAmount(text: string): { amount: number; note: string; source: string } | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*[wW]$/.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]) / 10_000;
  return { amount: value, note: `${value} 亿元`, source: match[0] };
}

class SelectionTaskRegistry {
  private readonly tasks = new Map<string, { key: string; selection: { options: Array<{ key?: string; value?: string }>; expiresAt?: number } }>();

  register(taskId: string, key: string, selection: { options: Array<{ key?: string; value?: string }>; expiresAt?: number }): void {
    this.tasks.set(taskId, { key, selection });
  }

  resolve(taskId: string, key: string, value: string): { status: string; option?: { value?: string } } {
    const task = this.tasks.get(taskId);
    if (!task) return { status: 'missing' };
    if (task.selection.expiresAt !== undefined && task.selection.expiresAt < Date.now()) {
      this.tasks.delete(taskId);
      return { status: 'expired' };
    }
    if (task.key !== key) return { status: 'mismatch' };
    const option = task.selection.options.find((item) => item.key === value || item.value === value);
    if (!option) return { status: 'invalid' };
    this.tasks.delete(taskId);
    return { status: 'selected', option };
  }
}

class IntentStateRegistry {
  private readonly states = new Map<string, unknown>();

  registerTask(taskId: string, _key: string, value: unknown): void {
    this.states.set(taskId, value);
  }

  getTask(taskId: string): unknown {
    return this.states.get(taskId);
  }

  deleteTask(taskId: string): void {
    this.states.delete(taskId);
  }
}

function fakeApi(resolve: (text: string, service: FakeService) => Promise<unknown> | unknown = async () => state) {
  class Router {
    constructor(private readonly service: FakeService) {}

    async executeConfirmed(value: typeof state): Promise<Record<string, unknown>> {
      const actions = value.draft.transactions!.map((item) => ({
        type: item.action,
        market: item.market,
        amount: confirmedRiskAmount(item.amountText!)!.amount,
        security_name: item.resolvedSecurity!.code,
      }));
      await this.service.calculatePretrade(value.product, actions);
      return { handled: true, intent: 'pretrade_calc', markdown: 'ok' };
    }
  }

  return {
    confirmedRiskAmount,
    resolveInitialRiskIntent: resolve,
    buildIntentSelection: () => ({
      kind: 'intent-confirm',
      title: '确认',
      subTitle: '确认全部交易',
      replyHint: '确认',
      options: [{ key: 'confirm', label: '确认', value: '__confirm__' }],
      expiresAt: Date.now() + 300_000,
    }),
    buildRiskSelectionCard: () => ({}),
    RiskSelectionTaskRegistry: SelectionTaskRegistry,
    RiskIntentStateRegistry: IntentStateRegistry,
    WeComRiskRouter: Router,
  };
}

class FakeService {
  readonly calculatePretrade = vi.fn(async (_product: string, _action: unknown) => ({
    status: 'success',
    id: 'harness-test-run',
    result: { before: { status_counts: { PASS: 1 }, metrics: {} }, after: { status_counts: { PASS: 1 } }, comparison: [] },
  }));
}

describe('risk benchmark batch harness', () => {
  it('checks and executes all batch legs in one array call after confirmation', async () => {
    const service = new FakeService();
    const api = fakeApi();

    const metrics = await runIntentChain(
      api,
      service,
      { text: state.originalText, expected, approvedForLocalCalculation: true },
      { allowAI: false },
      '/tmp/risk-batch-harness-test',
    );

    expect(metrics.calculationCalls).toBe(1);
    expect(metrics.preConfirmationCalculationCalls).toBe(0);
    expect(service.calculatePretrade).toHaveBeenCalledTimes(1);
    expect(service.calculatePretrade.mock.calls[0]?.[1]).toEqual([
      { type: 'buy', market: 'secondary', amount: 0.1, security_name: '102583394.IB' },
      { type: 'buy', market: 'secondary', amount: 0.4, security_name: '232580009.IB' },
    ]);
  });

  it('rejects a calculation attempted before confirmation', async () => {
    const service = new FakeService();
    const api = fakeApi(async (_text, currentService) => {
      await currentService.calculatePretrade(product, { type: 'buy', market: 'secondary', amount: 0.1 });
      return state;
    });

    await expect(runIntentChain(
      api,
      service,
      { text: state.originalText, expected, approvedForLocalCalculation: true },
      { allowAI: false },
      '/tmp/risk-batch-harness-test',
    )).rejects.toMatchObject({ code: 'calculation-before-confirmation' });
    expect(service.calculatePretrade).toHaveBeenCalledTimes(0);
  });

  it('passes a batch array through calculation-only mode', async () => {
    const service = new FakeService();
    await runCalculationOnly(service, { expected, approvedForLocalCalculation: true });

    expect(service.calculatePretrade).toHaveBeenCalledTimes(1);
    expect(service.calculatePretrade.mock.calls[0]).toEqual([
      product,
      [
        { type: 'buy', market: 'secondary', amount: 0.1, security_name: '102583394.IB' },
        { type: 'buy', market: 'secondary', amount: 0.4, security_name: '232580009.IB' },
      ],
    ]);
  });

  it('maps a primary subscription quantity to the client shares field', async () => {
    const service = new FakeService();
    await runCalculationOnly(service, {
      approvedForLocalCalculation: true,
      expected: {
        product,
        actions: [{ type: 'subscription', market: 'primary', quantity: 250, securityCode: '102583394.IB' }],
      },
    });

    expect(service.calculatePretrade.mock.calls[0]).toEqual([
      product,
      [{ type: 'subscription', market: 'primary', shares: 250, security_name: '102583394.IB' }],
    ]);
  });
});


describe('batch harness compatibility and incomplete selections', () => {
  it('keeps product outside the action in the legacy calculation-only call', async () => {
    const service = new FakeService();
    await runCalculationOnly(service, {
      approvedForLocalCalculation: true,
      expected: { product, type: 'buy', market: 'secondary', amount: 0.1, securityCode: '102583394.IB' },
    });
    expect(service.calculatePretrade.mock.calls[0]).toEqual([
      product, { type: 'buy', market: 'secondary', amount: 0.1, security_name: '102583394.IB' },
    ]);
  });

  it('uses actual selection helpers to resolve a security before filling its missing amount', async () => {
    const service = new FakeService();
    const first = state.draft.transactions[0]!;
    const pending = {
      stage: 'security', originalText: state.originalText, product, transactionIndex: 0,
      securities: [first.resolvedSecurity],
      draft: { accountQuery: product, market: 'secondary', transactions: [
        { ...first, amountText: undefined, resolvedSecurity: undefined },
        state.draft.transactions[1],
      ] },
    };
    const api = {
      ...intentApi, WeComRiskRouter, RiskSelectionTaskRegistry, buildRiskSelectionCard,
      resolveInitialRiskIntent: async () => pending,
    };
    const metrics = await runIntentChain(api, service, {
      text: state.originalText, expected, approvedForLocalCalculation: true,
      selections: ['102583394.IB', { text: '1000w' }],
    }, { allowAI: false }, '/tmp/risk-batch-harness-test');
    expect(metrics.calculationCalls).toBe(1);
    expect(metrics.preConfirmationCalculationCalls).toBe(0);
    expect(service.calculatePretrade).toHaveBeenCalledOnce();
    expect(service.calculatePretrade.mock.calls[0]?.[1]).toHaveLength(2);
  });
});
