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

  it('combines investment restriction and credit checks into one visible stage', async () => {
    const delivered: string[] = [];
    const relay = new RiskProgressRelay(async (message) => {
      delivered.push(message);
    });

    relay.push('正在检查买入证券的禁投和关联方…（距上阶段0.06s，累计4.52s）');
    relay.push('正在检查信用类资产授信额度…（距上阶段0.51s，累计5.03s）');
    await relay.flush();

    expect(delivered).toEqual([
      '正在依次检查买入证券的禁投、关联方及信用类资产授信额度…',
    ]);
  });

  it('shows a bounded four-stage count using user-facing stage text', async () => {
    const delivered: string[] = [];
    const relay = new RiskProgressRelay(
      async (message) => {
        delivered.push(message);
      },
      undefined,
      { includeStageCount: true },
    );

    relay.push('正在查询产品持仓…');
    relay.push('正在读取持仓明细…');
    relay.push('正在检查证券禁投和关联方…');
    relay.push('正在检查信用类资产授信额度…');
    relay.push('正在提交投前测算…');
    relay.push('正在计算限额…');
    await relay.flush();

    expect(delivered).toEqual([
      '当前阶段：正在查询产品持仓…\n已完成 1/4',
      '当前阶段：正在检查证券禁投和关联方…\n已完成 2/4',
      '当前阶段：正在提交投前测算…\n已完成 3/4',
    ]);
  });
});
