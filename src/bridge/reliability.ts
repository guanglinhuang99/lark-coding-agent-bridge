export type FailureKind =
  | 'timeout'
  | 'rate-limit'
  | 'http-5xx'
  | 'http-4xx'
  | 'network'
  | 'circuit-open'
  | 'other';

export interface OperationPolicy {
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  idempotent?: boolean;
  circuitThreshold?: number;
  circuitResetMs?: number;
}

interface CircuitState {
  failures: number;
  openedUntil: number;
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  response?: { status?: unknown };
}

export class OperationTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
  }
}

export class CircuitOpenError extends Error {
  readonly code = 'ECIRCUITOPEN';

  constructor(
    readonly operation: string,
    readonly retryAfterMs: number,
  ) {
    super(`${operation} circuit is open`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Shared retry/timeout/circuit-breaker policy for idempotent infrastructure calls.
 * Agent runs and other potentially mutating operations should keep idempotent=false,
 * which intentionally disables automatic retry.
 */
export class OperationRunner {
  private readonly circuits = new Map<string, CircuitState>();
  private readonly lingering = new Map<string, Set<object>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async run<T>(
    operation: string,
    fn: (signal: AbortSignal) => Promise<T>,
    policy: OperationPolicy = {},
  ): Promise<T> {
    const idempotent = policy.idempotent ?? false;
    const maxAttempts = positiveInt(policy.maxAttempts, idempotent ? 2 : 1);
    const timeoutMs = positiveInt(policy.timeoutMs, 30_000);
    const retryDelayMs = nonNegativeInt(policy.retryDelayMs, 250);
    const circuitThreshold = positiveInt(policy.circuitThreshold, 3);
    const circuitResetMs = positiveInt(policy.circuitResetMs, 30_000);

    this.assertCircuit(operation);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.assertCircuit(operation);
      const controller = new AbortController();
      const token = {};
      let settled = false;
      const work = Promise.resolve().then(() => fn(controller.signal));
      const markSettled = () => {
        settled = true;
        const pending = this.lingering.get(operation);
        pending?.delete(token);
        if (pending?.size === 0) this.lingering.delete(operation);
      };
      void work.then(markSettled, markSettled);
      try {
        const value = await withTimeout(operation, timeoutMs, work, () => controller.abort());
        if (!this.lingering.has(operation)) this.circuits.delete(operation);
        return value;
      } catch (err) {
        lastError = err;
        const kind = failureKind(err);
        if (err instanceof OperationTimeoutError && !settled) {
          const pending = this.lingering.get(operation) ?? new Set<object>();
          pending.add(token);
          this.lingering.set(operation, pending);
        }
        const retryable = !(err instanceof OperationTimeoutError) && idempotent &&
          isRetryableFailure(kind) && attempt < maxAttempts;
        if (!retryable) {
          this.recordFailure(operation, circuitThreshold, circuitResetMs);
          throw err;
        }
        await sleep(retryDelayMs * attempt);
      }
    }
    throw lastError;
  }

  snapshot(operation: string): { state: 'closed' | 'open'; retryAfterMs: number } {
    if (this.lingering.has(operation)) return { state: 'open', retryAfterMs: 0 };
    const state = this.circuits.get(operation);
    if (!state || state.openedUntil === 0) return { state: 'closed', retryAfterMs: 0 };
    const now = this.now();
    if (state.openedUntil <= now) {
      this.circuits.delete(operation);
      return { state: 'closed', retryAfterMs: 0 };
    }
    return { state: 'open', retryAfterMs: state.openedUntil - now };
  }

  private assertCircuit(operation: string): void {
    if (this.lingering.has(operation)) throw new CircuitOpenError(operation, 0);
    const state = this.circuits.get(operation);
    if (!state || state.openedUntil === 0) return;
    const now = this.now();
    if (state.openedUntil <= now) {
      this.circuits.delete(operation);
      return;
    }
    throw new CircuitOpenError(operation, state.openedUntil - now);
  }

  private recordFailure(operation: string, threshold: number, resetMs: number): void {
    const previous = this.circuits.get(operation) ?? { failures: 0, openedUntil: 0 };
    const failures = previous.failures + 1;
    this.circuits.set(operation, {
      failures,
      openedUntil: failures >= threshold ? this.now() + resetMs : 0,
    });
  }
}

export function failureKind(err: unknown): FailureKind {
  if (err instanceof CircuitOpenError) return 'circuit-open';
  const item: ErrorLike = err && typeof err === 'object' ? (err as ErrorLike) : {};
  if (item.name === 'WeComMediaTimeoutError' || item.name === 'OperationTimeoutError' || item.name === 'WeComOperationTimeoutError') {
    return 'timeout';
  }
  const status = item.response?.status;
  if (typeof status === 'number') {
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'http-5xx';
    if (status >= 400) return 'http-4xx';
  }
  const code = typeof item.code === 'string' ? item.code.toUpperCase() : '';
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return 'timeout';
  if (code === 'ECIRCUITOPEN') return 'circuit-open';
  if (code.startsWith('ECONN') || code.startsWith('ENET') || code === 'EHOSTUNREACH') {
    return 'network';
  }
  return 'other';
}

function isRetryableFailure(kind: FailureKind): boolean {
  return kind === 'timeout' || kind === 'network' || kind === 'rate-limit' || kind === 'http-5xx';
}

async function withTimeout<T>(operation: string, timeoutMs: number, promise: Promise<T>, abort: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OperationTimeoutError(operation, timeoutMs));
      abort();
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.floor(value as number);
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? -1) < 0) return fallback;
  return Math.floor(value as number);
}
