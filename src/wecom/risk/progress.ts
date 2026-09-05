export class RiskProgressRelay {
  private lastMessage: string | undefined;
  private pending: Promise<void> = Promise.resolve();
  private combinedInvestmentChecksStarted = false;
  private readonly emittedStages = new Set<RiskProgressStage>();

  constructor(
    private readonly send: (message: string) => Promise<unknown>,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly options: { includeStageCount?: boolean } = {},
  ) {}

  push(message: string): void {
    let normalized = message.trim();
    if (normalized.startsWith('正在检查买入证券的禁投和关联方')) {
      this.combinedInvestmentChecksStarted = true;
      normalized = '正在依次检查买入证券的禁投、关联方及信用类资产授信额度…';
    } else if (
      this.combinedInvestmentChecksStarted &&
      normalized.startsWith('正在检查信用类资产授信额度')
    ) {
      return;
    }
    if (!normalized || normalized === this.lastMessage) return;
    this.lastMessage = normalized;
    let visibleMessage = normalized;
    if (this.options.includeStageCount) {
      const stage = progressStage(normalized);
      if (this.emittedStages.has(stage)) return;
      this.emittedStages.add(stage);
      visibleMessage = `当前阶段：${normalized}\n已完成 ${this.emittedStages.size}/4`;
    }
    this.pending = this.pending.then(async () => {
      try {
        await this.send(visibleMessage);
      } catch (error) {
        this.onError(error);
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}

type RiskProgressStage = 'data' | 'security' | 'checks' | 'result';

function progressStage(message: string): RiskProgressStage {
  if (/(?:提交投前测算|计算|生成|输出|结果|完成|测算)/.test(message)) {
    return 'result';
  }
  if (/(?:禁投|关联方|交易对手|授信|信用额度|风险限额)/.test(message)) {
    return 'checks';
  }
  if (/(?:证券|债券|股票)/.test(message)) {
    return 'security';
  }
  if (/(?:查询|读取|加载|获取|持仓|规则|证券|产品|账户)/.test(message)) {
    return 'data';
  }
  return 'data';
}
