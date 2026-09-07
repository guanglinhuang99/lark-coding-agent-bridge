import { AsyncLocalStorage } from 'node:async_hooks';
import { log, reportMetric } from '../core/logger';

export type RunCapacityReason = 'queue-full' | 'queue-timeout' | 'shutting-down';
export class RunCapacityError extends Error {
  constructor(readonly reason: RunCapacityReason) {
    super(`Run admission rejected: ${reason}`);
    this.name = 'RunCapacityError';
  }
}
export interface ProcessPoolOptions { maxQueued?: number; queueTimeoutMs?: number }
export type RunPermit = () => void;
interface PermitState { released: boolean; borrowed: boolean; returned: boolean }
interface Waiter {
  resolve: (permit: RunPermit) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/** Instance-local FIFO admission shared by both bridges; never a global singleton. */
export class ProcessPool {
  private active = 0;
  private closed = false;
  private readonly waiters: Waiter[] = [];
  private readonly permits = new WeakMap<RunPermit, PermitState>();
  private readonly context = new AsyncLocalStorage<RunPermit>();
  private readonly maxQueued: number;
  private readonly queueTimeoutMs: number;
  constructor(private readonly cap: () => number, options: ProcessPoolOptions = {}) {
    this.maxQueued = options.maxQueued ?? Number.POSITIVE_INFINITY;
    this.queueTimeoutMs = options.queueTimeoutMs ?? 0;
    if (!(this.maxQueued >= 0) || !(this.queueTimeoutMs >= 0)) {
      throw new RangeError('Pool queue limits must be non-negative');
    }
  }
  async acquire(): Promise<RunPermit> {
    if (this.closed) throw new RunCapacityError('shutting-down');
    this.drain();
    if (!this.waiters.length && this.active < this.limit()) return this.allocate();
    if (this.waiters.length >= this.maxQueued) throw new RunCapacityError('queue-full');
    return new Promise<RunPermit>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (this.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          reject(new RunCapacityError('queue-timeout'));
        }, this.queueTimeoutMs);
        waiter.timer.unref?.();
      }
      this.waiters.push(waiter);
      reportMetric('pool_waiting', this.waiters.length);
    });
  }
  tryAcquire(): RunPermit | undefined {
    if (this.closed) return undefined;
    this.drain();
    if (this.waiters.length || this.active >= this.limit()) return undefined;
    return this.allocate();
  }
  /** A live permit from this pool may be borrowed by ONE agent execution.
   * Returning the outer permit early cannot free a still-borrowed slot. */
  borrow(permit: RunPermit): RunPermit {
    const state = this.permits.get(permit);
    if (!state || state.released || state.returned || state.borrowed) {
      throw new Error('Admission permit is foreign, released, or already in use');
    }
    state.borrowed = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.borrowed = false;
      if (state.released) this.returnSlot(state);
    };
  }
  currentPermit(): RunPermit | undefined {
    const permit = this.context.getStore();
    const state = permit && this.permits.get(permit);
    return state && !state.released && !state.returned ? permit : undefined;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    const permit = await this.acquire();
    try { return await this.context.run(permit, task); }
    finally { permit(); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new RunCapacityError('shutting-down'));
    }
  }
  snapshot(): { active: number; waiting: number; cap: number } {
    return { active: this.active, waiting: this.waiters.length, cap: this.limit() };
  }
  private limit(): number {
    const value = this.cap();
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1;
  }
  private allocate(): RunPermit {
    this.active++;
    const state: PermitState = { released: false, borrowed: false, returned: false };
    const permit = () => {
      if (state.released) return;
      state.released = true;
      if (!state.borrowed) this.returnSlot(state);
    };
    this.permits.set(permit, state);
    log.info('pool', 'acquired', { active: this.active, cap: this.limit() });
    reportMetric('pool_active', this.active);
    return permit;
  }
  private returnSlot(state: PermitState): void {
    if (state.returned) return;
    state.returned = true;
    this.active--;
    reportMetric('pool_active', this.active);
    this.drain();
  }
  private drain(): void {
    // Reserve BEFORE waking: a newcomer cannot steal a queued request's slot.
    while (!this.closed && this.waiters.length && this.active < this.limit()) {
      const waiter = this.waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(this.allocate());
    }
  }
}
