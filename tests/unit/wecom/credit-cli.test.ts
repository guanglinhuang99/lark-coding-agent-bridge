import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parseWeComCommand } from '../../../src/wecom/commands';
import { executeCreditCommand } from '../../../src/wecom/risk/credit-command';
import { RiskApplication, type RiskReply } from '../../../src/business/risk/application';
import { RiskStateRegistry } from '../../../src/business/risk/state';
import { RiskProgressRelay } from '../../../src/business/risk/progress';
import { truncateUtf8 } from '../../../src/wecom/presentation';

function setup() {
  const source = readFileSync('src/wecom/cli.ts', 'utf8');
  const block = source.slice(source.indexOf('async function executeConversationMessage('), source.indexOf('function isWorkspaceScope('));
  const riskStates = new RiskStateRegistry();
  riskStates.setPretrade('conversation', { stage: 'confirm', originalText: '原交易', product: '原交易',
    draft: { accountQuery: '原交易', action: 'subscription', amountText: '1000万', market: 'secondary' } });
  const context: any = {
    Date, Buffer, parseWeComCommand, executeCreditCommand, startingRuns: new Set(),
    RiskProgressRelay, truncateUtf8, isRiskUserAllowed: () => true,
    riskKeyFor: (key: string) => key,
    riskInteraction: { renderReply: async (_body: unknown, _key: string, stream: any, reply: RiskReply) => {
      if (reply.handled && reply.kind === 'pages') await stream.finish(reply.pages[0]);
    } },
    RiskIntentInterruptedError: class extends Error {},
    withReservation: async (_set: unknown, _key: string, fn: () => Promise<void>) => fn(),
    runGate: { run: async (fn: () => Promise<void>) => fn() },
    refreshHealth: vi.fn(async () => {}), reportMetric: vi.fn(), log: { info: vi.fn() },
    riskClient: {
      getCredit: vi.fn(async () => ({ ...creditReport('公司甲'), date: '2026-09-08' })),
      getCredits: vi.fn(),
    },
    riskRouter: { handle: vi.fn() }, riskStates,
    streamMaxBytes: 4000, messageTarget: () => 'target', client: { sendMessage: vi.fn() },
    renderWeComNotice: (title: string, lines: string[]) => [title, ...lines].join('\n'),
  };
  context.riskApplication = new RiskApplication({ service: context.riskClient, router: context.riskRouter, states: riskStates });
  vm.runInNewContext(ts.transpileModule(block + '\nglobalThis.execute = executeConversationMessage;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return context;
}

describe('credit CLI dispatch', () => {
  it('dispatches before pending trade state and does not modify the pending trade', async () => {
    const api = setup();
    const before = api.riskStates.getPretrade('conversation');
    const stream = { finish: vi.fn(async (_content: string) => true) };
    await api.execute({ body: { from: { userid: 'u1' } } }, 'conversation', '/授信 公司甲', [], stream, true, false, false, 'task', false);
    expect(api.riskClient.getCredit).toHaveBeenCalledWith('公司甲');
    expect(api.riskClient.getCredits).not.toHaveBeenCalled();
    expect(api.riskRouter.handle).not.toHaveBeenCalled();
    expect(api.riskStates.getPretrade('conversation')).toBe(before);
    expect(stream.finish.mock.calls[0]?.[0]).toContain('| 公司甲 |');
  });

  it('enforces the existing risk access gate before querying credit', async () => {
    const api = setup();
    const stream = { finish: vi.fn(async (_content: string) => true) };
    await api.execute({ body: { from: { userid: 'u1' } } }, 'conversation', '/授信 公司甲', [], stream, false, true, false, 'task', false);
    expect(api.riskClient.getCredit).not.toHaveBeenCalled();
    expect(api.riskClient.getCredits).not.toHaveBeenCalled();
    expect(stream.finish.mock.calls[0]?.[0]).toContain('没有风险限额查询权限');
  });
});

function creditReport(entity: string) {
  return {
    entity,
    group_internal: { credit_limit_yuan: 100_000, used_credit_yuan: 20_000, remaining_credit_yuan: 80_000 },
    third_party: { credit_limit_yuan: null, used_credit_yuan: 0, remaining_credit_yuan: null },
  };
}
