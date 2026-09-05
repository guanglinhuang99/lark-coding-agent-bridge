import { describe, expect, it } from 'vitest';
import {
  WeComCircuitOpenError,
  WeComOperationRunner,
  WeComOperationTimeoutError,
  classifyTask,
  failureKind,
} from '../../../src/wecom/reliability';

describe('WeComOperationRunner', () => {
  it('retries transient failures only for idempotent operations', async () => {
    const runner = new WeComOperationRunner();
    let calls = 0;
    const value = await runner.run(
      'history',
      async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return 'ok';
      },
      { idempotent: true, retryDelayMs: 0 },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      runner.run(
        'mutating-operation',
        async () => {
          calls++;
          throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        },
        { idempotent: false, maxAttempts: 3, retryDelayMs: 0 },
      ),
    ).rejects.toThrow('reset');
    expect(calls).toBe(1);
  });

  it('normalizes timeouts and opens a circuit after repeated failures', async () => {
    const runner = new WeComOperationRunner();
    await expect(
      runner.run('timeout', () => new Promise<never>(() => {}), {
        timeoutMs: 5,
        maxAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(WeComOperationTimeoutError);

    await expect(
      runner.run(
        'downstream',
        async () => {
          throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
        },
        { idempotent: true, maxAttempts: 1, circuitThreshold: 1, circuitResetMs: 60_000 },
      ),
    ).rejects.toThrow('down');

    await expect(runner.run('downstream', async () => 'never')).rejects.toBeInstanceOf(
      WeComCircuitOpenError,
    );
    expect(failureKind(new WeComCircuitOpenError('x', 10))).toBe('circuit-open');
  });

  it('classifies task labels without retaining message content', () => {
    expect(classifyTask('/doctor', { hasAttachments: false, risk: false })).toEqual({
      kind: 'command',
      label: '系统诊断',
    });
    expect(classifyTask('任意业务问题', { hasAttachments: false, risk: true })).toEqual({
      kind: 'risk',
      label: '风险测算 / 查询',
    });
    expect(classifyTask('请检查附件里的内容', { hasAttachments: true, risk: false })).toEqual({
      kind: 'attachment',
      label: '附件分析',
    });
  });
});
