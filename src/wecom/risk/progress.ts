export class RiskProgressRelay {
  private lastMessage: string | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly send: (message: string) => Promise<unknown>,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  push(message: string): void {
    const normalized = message.trim();
    if (!normalized || normalized === this.lastMessage) return;
    this.lastMessage = normalized;
    this.pending = this.pending.then(async () => {
      try {
        await this.send(normalized);
      } catch (error) {
        this.onError(error);
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
