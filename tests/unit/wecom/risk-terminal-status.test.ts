import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function loadExecuteRiskCardSelection(result: Record<string, unknown>) {
  const source = readFileSync('src/wecom/cli.ts', 'utf8');
  const block = source.slice(
    source.indexOf('async function executeRiskCardSelection('),
    source.indexOf('async function sendRiskRouteResult('),
  );
  const sendRiskRouteResult = vi.fn(async () => {});
  const context: Record<string, unknown> = {
    riskRouter: { handle: vi.fn(async () => result), executeConfirmed: vi.fn(async () => result) },
    refreshHealth: vi.fn(async () => {}),
    RiskProgressRelay: class {
      constructor(..._args: unknown[]) {}
      push(_progress: string): void {}
      async finish(): Promise<void> {}
    },
    reportMetric: vi.fn(),
    log: { fail: vi.fn(), warn: vi.fn() },
    truncateUtf8: (value: string) => value,
    renderWeComNotice: (title: string, lines: string[]) => `${title}\n${lines.join('\n')}`,
    streamMaxBytes: 4_000,
    sendRiskRouteResult,
    WeComRunCapacityError: class extends Error {},
    startingRuns: new Set(),
    runGate: { run: async (fn: () => Promise<void>) => fn(), snapshot: () => ({}) },
    withReservation: async (_set: Set<string>, _key: string, fn: () => Promise<void>) => fn(),
    capacityNotice: () => 'capacity',
    sendRiskMarkdown: vi.fn(async () => {}),
  };
  vm.runInNewContext(
    ts.transpileModule(`${block}\nglobalThis.__execute = executeRiskCardSelection;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
  return { execute: context.__execute as (...args: unknown[]) => Promise<void>, sendRiskRouteResult };
}

describe('risk terminal status', () => {
  it('does not announce completion when the handled result is a risk error', async () => {
    const { execute, sendRiskRouteResult } = loadExecuteRiskCardSelection({
      handled: true,
      intent: 'risk-error',
      markdown: '⚠️ 交易规模无效：本次未执行测算。',
    });
    const stream = { update: vi.fn(async () => {}), finish: vi.fn(async () => {}) };

    await execute({}, 'conversation', 'invalid transaction', true, { kind: 'stream', stream });

    expect(stream.finish).toHaveBeenCalledOnce();
    const terminal = (stream.finish.mock.calls as unknown as Array<[string]>)[0]?.[0] ?? '';
    expect(terminal).toContain('风险限额测算失败');
    expect(terminal).not.toContain('风险限额测算完成');
    expect(sendRiskRouteResult).toHaveBeenCalledOnce();
  });
});
