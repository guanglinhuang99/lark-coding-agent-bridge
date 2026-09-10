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

function client(
  options: {
    timeoutMs?: number;
    startupTimeoutMs?: number;
    onStage?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return new RiskDirectClient({
    pythonPath: '/test/python',
    serviceDir: '/test/risk-service',
    stateDir: '/test/state',
    bridgePath: '/test/direct_bridge.py',
    timeoutMs: options.timeoutMs,
    startupTimeoutMs: options.startupTimeoutMs,
    onStage: options.onStage,
    intranetProbe: async () => true,
  });
}

afterEach(() => {
  childProcessMocks.spawn.mockReset();
});

describe('riskservice direct client', () => {
  it('sends one credit subject through the singular bridge request', async () => {
    const requests: Record<string, unknown>[] = [];
    installBridge((request, child) => {
      requests.push(request);
      child.stdout.write(`${JSON.stringify({ id: request.id, type: 'result', data: { entity: '公司甲' } })}\n`);
    });
    const service = client();
    await expect(service.getCredit('公司甲')).resolves.toEqual({ entity: '公司甲' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'get_credit', args: { entity: '公司甲' } });
    await service.close();
  });

  it('sends all credit subjects in one bridge request', async () => {
    const requests: Record<string, unknown>[] = [];
    installBridge((request, child) => {
      requests.push(request);
      child.stdout.write(`${JSON.stringify({ id: request.id, type: 'result', data: { reports: [] } })}\n`);
    });
    const service = client();
    await expect(service.getCredits(['公司甲', '公司乙'])).resolves.toEqual({ reports: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'get_credits', args: { entities: ['公司甲', '公司乙'] } });
    await service.close();
  });
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

  it('submits multiple pretrade actions in one request and preserves single-action calls', async () => {
    const requests: Array<Record<string, unknown>> = [];
    installBridge((request, child) => {
      if (request.method === 'calculate_pretrade') requests.push(request);
      child.stdout.write(
        `${JSON.stringify({
          id: request.id,
          type: 'result',
          data: { status: 'success', result: {} },
        })}\n`,
      );
    });
    const service = client();
    const actions = [
      { type: 'buy' as const, market: 'secondary' as const, amount: 0.1, security_name: '102583394.IB' },
      { type: 'buy' as const, market: 'secondary' as const, amount: 0.4, security_name: '232580009.IB' },
    ];

    await service.calculatePretrade('产品A', actions);
    await service.calculatePretrade('产品A', actions[0]!);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      args: { product: '产品A', action: actions },
    });
    expect(requests[1]).toMatchObject({
      args: { product: '产品A', action: actions[0] },
    });
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


  it('times out startup, kills the stuck process, and can start cleanly on the next call', async () => {
    const stuck = new FakeChild();
    const healthy = new FakeChild();
    let healthyInput = '';
    healthy.stdin.on('data', (chunk) => {
      healthyInput += chunk.toString();
      const lines = healthyInput.split('\n');
      healthyInput = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        healthy.stdout.write(
          `${JSON.stringify({ id: request.id, type: 'result', data: { products: ['产品B'] } })}\n`,
        );
      }
    });
    childProcessMocks.spawn
      .mockReturnValueOnce(stuck)
      .mockImplementationOnce(() => {
        queueMicrotask(() => healthy.stdout.write('{"type":"ready"}\n'));
        return healthy;
      });
    const service = client({ startupTimeoutMs: 5 });

    await expect(service.listProducts()).rejects.toMatchObject({
      code: 'direct-start-timeout',
    });
    expect(stuck.kill).toHaveBeenCalledWith('SIGTERM');

    await expect(service.listProducts()).resolves.toEqual(['产品B']);
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('ignores a delayed exit from an obsolete child after a clean restart', async () => {
    const stuck = new FakeChild();
    stuck.kill.mockImplementation(() => {
      stuck.exitCode = 0;
      return true;
    });
    const healthy = new FakeChild();
    let healthyInput = '';
    healthy.stdin.on('data', (chunk) => {
      healthyInput += chunk.toString();
      const lines = healthyInput.split('\n');
      healthyInput = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        healthy.stdout.write(
          `${JSON.stringify({ id: request.id, type: 'result', data: { products: ['产品B'] } })}\n`,
        );
      }
    });
    childProcessMocks.spawn
      .mockReturnValueOnce(stuck)
      .mockImplementationOnce(() => {
        queueMicrotask(() => healthy.stdout.write('{"type":"ready"}\n'));
        return healthy;
      });
    const service = client({ startupTimeoutMs: 5 });

    await expect(service.listProducts()).rejects.toMatchObject({ code: 'direct-start-timeout' });
    await expect(service.listProducts()).resolves.toEqual(['产品B']);

    stuck.emit('exit', 0, null);
    service.clearLookupCache();
    await expect(service.listProducts()).resolves.toEqual(['产品B']);
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('rejects an in-progress startup when the client closes', async () => {
    const stuck = new FakeChild();
    childProcessMocks.spawn.mockReturnValue(stuck);
    const service = client({ startupTimeoutMs: 10_000 });
    const pending = service.listProducts().catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));

    await service.close();

    expect(await pending).toMatchObject({ code: 'direct-process' });
    expect(stuck.kill).toHaveBeenCalledWith('SIGTERM');
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

describe('shared lookup cache and admission', () => {
  it('coalesces concurrent lookups, isolates cached values, and refreshes after expiry', async () => {
    const requests: string[] = [];
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    installBridge((request, child) => {
      requests.push(String(request.method));
      child.stdout.write(JSON.stringify({ id: request.id, type: 'result', data: { products: ['产品A'] } }) + '\n');
    });
    const service = new RiskDirectClient({
      pythonPath: '/test/python', serviceDir: '/test/service', stateDir: '/test/state',
      bridgePath: '/test/bridge', productCacheTtlMs: 100,
      intranetProbe: async () => true,
    });
    try {
      const [a, b] = await Promise.all([service.listProducts(), service.listProducts()]);
      a.push('mutation');
      expect(b).toEqual(['产品A']);
      expect(await service.listProducts()).toEqual(['产品A']);
      expect(requests).toHaveLength(1);
      now += 101;
      await service.listProducts();
      expect(requests).toHaveLength(2);
    } finally { clock.mockRestore(); await service.close(); }
  });
  it('does not retain failed lookups or share different security queries', async () => {
    const requests: string[] = []; let fail = true;
    installBridge((request, child) => {
      requests.push(String((request.args as Record<string, unknown>).query));
      child.stdout.write(JSON.stringify(fail
        ? { id: request.id, type: 'error', error: 'temporary' }
        : { id: request.id, type: 'result', data: { suggestions: [{ name: '国债', code: '100115.SZ' }] } }) + '\n');
    });
    const service = client();
    await expect(service.searchSecurities('a')).rejects.toThrow();
    fail = false;
    await service.searchSecurities('a'); await service.searchSecurities('a'); await service.searchSecurities('b');
    expect(requests).toEqual(['a', 'a', 'b']);
    await service.close();
  });
  it('sends cancellation for timed-out requests without killing the process', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = installBridge(request => { requests.push(request); });
    const service = client({ timeoutMs: 5 });
    await expect(service.getHoldings('产品A')).rejects.toMatchObject({ code: 'direct-timeout' });
    expect(requests[1]).toMatchObject({ id: requests[0]!.id, method: 'cancel' });
    expect(child.kill).not.toHaveBeenCalled();
    await service.close();
  });
  it('bounds pending requests and rejects outstanding work when closed', async () => {
    installBridge(() => {});
    const service = new RiskDirectClient({
      pythonPath: '/test/python', serviceDir: '/test/service', stateDir: '/test/state',
      bridgePath: '/test/bridge', maxPendingCalls: 1,
      intranetProbe: async () => true,
    });
    const first = service.getHoldings('产品A').catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    await expect(service.getHoldings('产品B')).rejects.toMatchObject({ code: 'direct-capacity' });
    await service.close();
    expect(await first).toMatchObject({ code: 'direct-process' });
  });
});

describe('intranet availability gate', () => {
  it('fails before starting the Python bridge when 10.8.11.57 is unavailable', async () => {
    const intranetProbe = vi.fn(async () => false);
    const service = new RiskDirectClient({
      pythonPath: '/test/python', serviceDir: '/test/service', stateDir: '/test/state',
      bridgePath: '/test/bridge', intranetProbe,
    });

    await expect(service.listProducts()).rejects.toMatchObject({
      code: 'intranet-unavailable',
    });
    expect(intranetProbe).toHaveBeenCalledWith('10.8.11.57', 80, 1_500);
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    await service.close();
  });

  it('checks connectivity before serving cached master data', async () => {
    let available = true;
    const intranetProbe = vi.fn(async () => available);
    installBridge((request, child) => {
      child.stdout.write(JSON.stringify({ id: request.id, type: 'result', data: { products: ['产品A'] } }) + '\n');
    });
    const service = new RiskDirectClient({
      pythonPath: '/test/python', serviceDir: '/test/service', stateDir: '/test/state',
      bridgePath: '/test/bridge', productCacheTtlMs: 60_000, intranetCacheTtlMs: 0, intranetProbe,
    });

    await expect(service.listProducts()).resolves.toEqual(['产品A']);
    available = false;
    await expect(service.listProducts()).rejects.toMatchObject({ code: 'intranet-unavailable' });
    expect(intranetProbe).toHaveBeenCalledTimes(2);
    await service.close();
  });
});
