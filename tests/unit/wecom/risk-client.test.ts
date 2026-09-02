import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: childProcessMocks.spawn,
}));

import { RiskDirectClient } from '../../../src/wecom/risk/client';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly kill = vi.fn(() => {
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  });
}

function installBridge(
  handler: (request: Record<string, unknown>, child: FakeChild) => void,
): FakeChild {
  const child = new FakeChild();
  let input = '';
  child.stdin.on('data', (chunk) => {
    input += chunk.toString();
    const lines = input.split('\n');
    input = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      handler(JSON.parse(line) as Record<string, unknown>, child);
    }
  });
  childProcessMocks.spawn.mockReturnValue(child);
  queueMicrotask(() => child.stdout.write('{"type":"ready"}\n'));
  return child;
}

function client(options: { timeoutMs?: number; onStage?: ReturnType<typeof vi.fn> } = {}) {
  return new RiskDirectClient({
    pythonPath: '/test/python',
    serviceDir: '/test/risk-service',
    stateDir: '/test/state',
    bridgePath: '/test/direct_bridge.py',
    timeoutMs: options.timeoutMs,
    onStage: options.onStage,
  });
}

afterEach(() => {
  childProcessMocks.spawn.mockReset();
});

describe('riskservice direct client', () => {
  it('reads structured content from the persistent local process', async () => {
    installBridge((request, child) => {
      child.stdout.write(
        `${JSON.stringify({
          id: request.id,
          type: 'result',
          data: { products: ['产品A'] },
        })}\n`,
      );
    });
    const service = client();

    await expect(service.listProducts()).resolves.toEqual(['产品A']);
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    await service.close();
  });

  it('keeps one process for repeated calls', async () => {
    installBridge((request, child) => {
      child.stdout.write(
        `${JSON.stringify({
          id: request.id,
          type: 'result',
          data: { suggestions: [{ security_name: '国债0115', security_code: '019115.SH' }] },
        })}\n`,
      );
    });
    const service = client();

    await service.searchSecurities('国债');
    await service.searchSecurities('国债0115');
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    await service.close();
  });

  it('forwards progress and reports direct-call timing', async () => {
    const onStage = vi.fn();
    installBridge((request, child) => {
      child.stdout.write(
        `${JSON.stringify({ id: request.id, type: 'progress', message: '正在读取持仓' })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          id: request.id,
          type: 'result',
          data: { status: 'success', result: { timings: { total: 1.2 } } },
        })}\n`,
      );
    });
    const service = client({ onStage });
    const progress = vi.fn();

    await expect(
      service.calculatePretrade('产品A', { type: 'subscription', amount: 1 }, progress),
    ).resolves.toMatchObject({ status: 'success' });
    expect(progress).toHaveBeenCalledWith('正在读取持仓');
    expect(onStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'direct', outcome: 'success' }),
    );
    await service.close();
  });

  it('raises a typed error returned by the Python process', async () => {
    installBridge((request, child) => {
      child.stdout.write(
        `${JSON.stringify({ id: request.id, type: 'error', error: 'denied' })}\n`,
      );
    });
    const service = client();

    await expect(service.listProducts()).rejects.toMatchObject({
      name: 'RiskServiceError',
      code: 'direct-error',
      message: 'denied',
    });
    await service.close();
  });

  it('times out a local call without killing the shared process', async () => {
    installBridge(() => {});
    const service = client({ timeoutMs: 5 });

    await expect(service.listProducts()).rejects.toMatchObject({
      code: 'direct-timeout',
    });
    expect(childProcessMocks.spawn).toHaveBeenCalledOnce();
    await service.close();
  });
});
