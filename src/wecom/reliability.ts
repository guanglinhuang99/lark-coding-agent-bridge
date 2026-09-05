export type WeComFailureKind =
  | 'timeout'
  | 'rate-limit'
  | 'http-5xx'
  | 'http-4xx'
  | 'network'
  | 'circuit-open'
  | 'other';

export interface WeComOperationPolicy {
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

type WeComQueueReason = 'queue-full' | 'queue-timeout' | 'shutting-down';

export class WeComOperationTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'WeComOperationTimeoutError';
  }
}

export class WeComCircuitOpenError extends Error {
  readonly code = 'ECIRCUITOPEN';

  constructor(
    readonly operation: string,
    readonly retryAfterMs: number,
  ) {
    super(`${operation} circuit is open`);
    this.name = 'WeComCircuitOpenError';
  }
}

/**
 * Shared retry/timeout/circuit-breaker policy for idempotent infrastructure calls.
 * Agent runs and other potentially mutating operations should keep idempotent=false,
 * which intentionally disables automatic retry.
 */
export class WeComOperationRunner {
  private readonly circuits = new Map<string, CircuitState>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async run<T>(
    operation: string,
    fn: () => Promise<T>,
    policy: WeComOperationPolicy = {},
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
      try {
        const value = await withTimeout(operation, timeoutMs, fn());
        this.circuits.delete(operation);
        return value;
      } catch (err) {
        lastError = err;
        const kind = failureKind(err);
        const retryable = idempotent && isRetryableFailure(kind) && attempt < maxAttempts;
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
    const state = this.circuits.get(operation);
    if (!state || state.openedUntil === 0) return;
    const now = this.now();
    if (state.openedUntil <= now) {
      this.circuits.delete(operation);
      return;
    }
    throw new WeComCircuitOpenError(operation, state.openedUntil - now);
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

export function failureKind(err: unknown): WeComFailureKind {
  if (err instanceof WeComCircuitOpenError) return 'circuit-open';
  const item: ErrorLike = err && typeof err === 'object' ? (err as ErrorLike) : {};
  if (item.name === 'WeComMediaTimeoutError' || item.name === 'WeComOperationTimeoutError') {
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

export function capacityNotice(reason: WeComQueueReason): string {
  if (reason === 'queue-full') return '任务队列已满';
  if (reason === 'queue-timeout') return '排队等待超时';
  return '服务正在停止';
}

export function conversationQueueNotice(reason: WeComQueueReason): string {
  if (reason === 'queue-full') return '当前会话队列已满';
  if (reason === 'queue-timeout') return '等待时间过长，消息已从队列移除，请重新发送';
  return '服务正在停止';
}

export function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function classifyTask(
  text: string,
  options: { hasAttachments: boolean; risk: boolean },
): { kind: 'command' | 'codex' | 'risk' | 'attachment'; label: string } {
  const command = text.trim().toLowerCase();
  if (command.startsWith('/')) {
    return { kind: 'command', label: commandLabel(command) };
  }
  if (options.risk) return { kind: 'risk', label: '风险测算 / 查询' };
  if (options.hasAttachments) return { kind: 'attachment', label: '附件分析' };
  return { kind: 'codex', label: 'Codex 对话' };
}

function commandLabel(command: string): string {
  if (command === '/doctor') return '系统诊断';
  if (command === '/runs') return '最近任务';
  if (command === '/menu') return '打开工作台';
  if (command === '/status') return '查看状态';
  if (command === '/settings') return '查看设置';
  if (command === '/workspace') return '选择工作区';
  if (command === '/model') return '选择模型';
  if (command === '/reasoning') return '选择推理强度';
  if (command === '/resume') return '恢复会话';
  if (command === '/stop') return '停止任务';
  if (command === '/new' || command === '/reset') return '新建会话';
  if (command === '/help') return '查看帮助';
  if (command.startsWith('/测算')) return '风险测算 / 查询';
  return '控制命令';
}

function isRetryableFailure(kind: WeComFailureKind): boolean {
  return kind === 'timeout' || kind === 'network' || kind === 'rate-limit' || kind === 'http-5xx';
}

async function withTimeout<T>(operation: string, timeoutMs: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WeComOperationTimeoutError(operation, timeoutMs)), timeoutMs);
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
