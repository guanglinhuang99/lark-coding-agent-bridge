import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parseWeComCommand } from '../../../src/wecom/commands';
import { executeCreditCommand } from '../../../src/wecom/risk/credit-command';

function setup() {
  const source = readFileSync('src/wecom/cli.ts', 'utf8');
  const block = source.slice(source.indexOf('async function executeConversationMessage('), source.indexOf('function isRiskIntentConfirmation('));
  const riskIntents = new Map([['conversation', { stage: 'confirm', draft: { accountQuery: '原交易' } }]]);
  const context: any = {
    Date, Buffer, parseWeComCommand, executeCreditCommand, startingRuns: new Set(),
    withReservation: async (_set: unknown, _key: string, fn: () => Promise<void>) => fn(),
    runGate: { run: async (fn: () => Promise<void>) => fn() },
    refreshHealth: vi.fn(async () => {}), reportMetric: vi.fn(), log: { info: vi.fn() },
    riskClient: {
      getCredit: vi.fn(async () => ({ ...creditReport('公司甲'), date: '2026-09-08' })),
      getCredits: vi.fn(),
    },
    riskRouter: { handle: vi.fn() }, riskIntents,
    streamMaxBytes: 4000, messageTarget: () => 'target', client: { sendMessage: vi.fn() },
    renderWeComNotice: (title: string, lines: string[]) => [title, ...lines].join('\n'),
  };
  vm.runInNewContext(ts.transpileModule(block + '\nglobalThis.execute = executeConversationMessage;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return context;
}

describe('credit CLI dispatch', () => {
  it('dispatches before pending trade state and does not modify the pending trade', async () => {
    const api = setup();
    const before = api.riskIntents.get('conversation');
    const stream = { finish: vi.fn(async (_content: string) => true) };
    await api.execute({ body: { from: { userid: 'u1' } } }, 'conversation', '/授信 公司甲', [], stream, true, false, 'task', false);
    expect(api.riskClient.getCredit).toHaveBeenCalledWith('公司甲');
    expect(api.riskClient.getCredits).not.toHaveBeenCalled();
    expect(api.riskRouter.handle).not.toHaveBeenCalled();
    expect(api.riskIntents.get('conversation')).toBe(before);
    expect(stream.finish.mock.calls[0]?.[0]).toContain('| 公司甲 |');
  });

  it('enforces the existing risk access gate before querying credit', async () => {
    const api = setup();
    const stream = { finish: vi.fn(async (_content: string) => true) };
    await api.execute({ body: { from: { userid: 'u1' } } }, 'conversation', '/授信 公司甲', [], stream, false, true, 'task', false);
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
