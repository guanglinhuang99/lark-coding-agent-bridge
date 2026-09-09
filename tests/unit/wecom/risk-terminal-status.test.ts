import { describe, expect, it, vi } from 'vitest';
import type { RiskService } from '../../../src/wecom/risk/client';
import { RiskSelectionTaskRegistry } from '../../../src/wecom/risk/card';
import type { RiskIntentState } from '../../../src/wecom/risk/intent';
import { RiskInteractionController } from '../../../src/wecom/risk/interaction';
import type { WeComRiskRouter } from '../../../src/wecom/risk/router';
import { RiskStateRegistry } from '../../../src/wecom/risk/state';

function controllerFor(result: Record<string, unknown>) {
  const riskRouter = {
    executeConfirmed: vi.fn(async () => result),
    continue: vi.fn(async () => result),
  } as unknown as WeComRiskRouter;
  const controller = new RiskInteractionController({
    riskClient: {} as RiskService,
    riskRouter,
    riskStates: new RiskStateRegistry(),
    riskSelectionTasks: new RiskSelectionTaskRegistry(),
    conversationQueue: { submit: vi.fn() } as never,
    runGate: { run: async <T>(fn: () => Promise<T>) => fn() },
    startingRuns: new Set(),
    streamMaxBytes: 4_000,
    refreshHealth: vi.fn(async () => {}),
    isRiskUserAllowed: () => true,
    updateTemplateCard: vi.fn(async () => {}),
    sendMarkdownMessage: vi.fn(async () => {}),
    sendControlCardMessage: vi.fn(async () => {}),
    createRiskTaskId: () => 'risk-test',
  });
  return { controller, riskRouter };
}

const confirmed: Extract<RiskIntentState, { stage: 'confirm' }> = {
  stage: 'confirm',
  originalText: '测试账户 申购 1000万',
  product: '测试账户',
  draft: {
    accountQuery: '测试账户',
    action: 'subscription',
    amountText: '1000万',
    market: 'secondary',
  },
};

describe('risk terminal status', () => {
  it('does not announce completion when the handled result is a risk error', async () => {
    const { controller } = controllerFor({
      handled: true,
      intent: 'risk-error',
      markdown: '⚠️ 交易规模无效：本次未执行测算。',
    });
    const sendRouteResult = vi.spyOn(controller, 'sendRouteResult').mockResolvedValue();
    const stream = { update: vi.fn(async () => {}), finish: vi.fn(async () => {}) };

    await controller.executeSelection(
      {},
      'conversation',
      { kind: 'pretrade', state: confirmed },
      true,
      { kind: 'stream', stream },
    );

    expect(stream.finish).toHaveBeenCalledOnce();
    const terminal = (stream.finish.mock.calls as unknown as Array<[string]>)[0]?.[0] ?? '';
    expect(terminal).toContain('风险限额测算失败');
    expect(terminal).not.toContain('风险限额测算完成');
    expect(sendRouteResult).toHaveBeenCalledOnce();
  });
});
