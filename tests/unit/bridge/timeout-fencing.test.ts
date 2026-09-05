import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationRunner } from '../../../src/bridge/reliability';

afterEach(() => vi.useRealTimers());

describe('deadline cancellation and late-operation fencing', () => {
  it('aborts cooperatively but never automatically overlaps a locally timed-out attempt', async () => {
    vi.useFakeTimers();
    const runner = new OperationRunner();
    let release!: (value: string) => void;
    let signal: AbortSignal | undefined;
    const fn = vi.fn((s: AbortSignal) => { signal = s; return new Promise<string>((resolve) => { release = resolve; }); });
    const result = runner.run('read', fn, { timeoutMs: 10, maxAttempts: 3, idempotent: true });
    const rejected = expect(result).rejects.toMatchObject({ name: 'OperationTimeoutError' });
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(fn).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(true);
    const replacement = vi.fn(async () => 'new');
    await expect(runner.run('read', replacement)).rejects.toMatchObject({ code: 'ECIRCUITOPEN' });
    expect(replacement).not.toHaveBeenCalled();
    release('late'); await Promise.resolve(); await Promise.resolve();
    await expect(runner.run('read', replacement)).resolves.toBe('new');
  });

  it('does not let late success close a circuit opened by its timeout', async () => {
    vi.useFakeTimers();
    const runner = new OperationRunner(); let release!: () => void;
    const result = runner.run('read', () => new Promise<void>((resolve) => { release = resolve; }), {
      timeoutMs: 10, circuitThreshold: 1, circuitResetMs: 1000, idempotent: true,
    });
    const rejected = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10); await rejected;
    release(); await Promise.resolve(); await Promise.resolve();
    expect(runner.snapshot('read').state).toBe('open');
    await expect(runner.run('read', async () => 'fresh')).rejects.toMatchObject({ code: 'ECIRCUITOPEN' });
    await vi.advanceTimersByTimeAsync(1001);
    await expect(runner.run('read', async () => 'fresh')).resolves.toBe('fresh');
  });

  it('still retries settled transient failures only when explicitly idempotent', async () => {
    const runner = new OperationRunner(); let calls = 0;
    await expect(runner.run('read', async () => {
      if (++calls === 1) throw Object.assign(new Error('network'), { code: 'ECONNRESET' });
      return 'ok';
    }, { idempotent: true, retryDelayMs: 0 })).resolves.toBe('ok');
    expect(calls).toBe(2);
    const write = vi.fn(async () => { throw Object.assign(new Error('network'), { code: 'ECONNRESET' }); });
    await expect(runner.run('write', write, { maxAttempts: 4, retryDelayMs: 0 })).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
