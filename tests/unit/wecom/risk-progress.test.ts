import { describe, expect, it, vi } from 'vitest';
import { RiskProgressRelay } from '../../../src/wecom/risk/progress';

describe('WeCom risk progress relay', () => {
  it('sends every distinct stage in order and waits for delivery', async () => {
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const relay = new RiskProgressRelay(async (message) => {
      if (delivered.length === 0) await firstBlocked;
      delivered.push(message);
    });

    relay.push('正在查询持仓…');
    relay.push('正在查询持仓…');
    relay.push('正在计算限额…');
    expect(delivered).toEqual([]);

    releaseFirst();
    await relay.flush();
    expect(delivered).toEqual(['正在查询持仓…', '正在计算限额…']);
  });

  it('continues after one progress delivery fails', async () => {
    const delivered: string[] = [];
    const onError = vi.fn();
    const relay = new RiskProgressRelay(async (message) => {
      if (message.includes('持仓')) throw new Error('send failed');
      delivered.push(message);
    }, onError);

    relay.push('正在查询持仓…');
    relay.push('正在计算限额…');
    await relay.flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(delivered).toEqual(['正在计算限额…']);
  });
});
