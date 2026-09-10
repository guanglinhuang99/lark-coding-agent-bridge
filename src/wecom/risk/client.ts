import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import type { RiskActionType } from './parser';

export interface RiskSecuritySuggestion {
  name: string;
  code: string;
  label: string;
}

export interface RiskPretradeAction {
  type: RiskActionType;
  market?: 'primary' | 'secondary';
  amount?: number;
  quantity?: number;
  shares?: number;
  security_name?: string;
  days?: number;
}

export interface RiskService {
  listProducts(): Promise<string[]>;
  searchSecurities(query: string): Promise<RiskSecuritySuggestion[]>;
  checkSecurity(product: string, security: string): Promise<Record<string, unknown>>;
  checkCounterparty(product: string, counterparty: string): Promise<Record<string, unknown>>;
  getHoldings(product: string): Promise<Record<string, unknown>>;
  getRestrictions(product: string): Promise<Record<string, unknown>>;
  getCredit(entity: string): Promise<Record<string, unknown>>;
  calculatePretrade(
    product: string,
    action: RiskPretradeAction | RiskPretradeAction[],
    onProgress?: (progress: string) => void,
  ): Promise<Record<string, unknown>>;
}

export interface RiskDirectClientOptions {
  pythonPath: string;
  serviceDir: string;
  stateDir: string;
  bridgePath: string;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  workers?: number;
  onStage?: (event: RiskStageEvent) => void;
  onDiagnostic?: (line: string) => void;
  productCacheTtlMs?: number;
  securityCacheTtlMs?: number;
  maxPendingCalls?: number;
  intranetHost?: string;
  intranetPort?: number;
  intranetTimeoutMs?: number;
  intranetCacheTtlMs?: number;
  intranetProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  onCall?: (event: { method: string; durationMs: number; outcome: 'success' | 'error' | 'cache' | 'joined' }) => void;
  onStartup?: (timings: Record<string, number>) => void;
}

export interface RiskStageEvent {
  stage: 'direct';
  durationMs: number;
  outcome: 'success' | 'error' | 'timeout';
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: unknown) => void;
  onProgress?: (message: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RiskDirectClient implements RiskService {
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private childGeneration = 0;
  private lines?: ReadLineInterface;
  private ready = false;
  private startPromise?: Promise<void>;
  private startResolve?: () => void;
  private startReject?: (reason: unknown) => void;
  private closing = false;
  private readonly pending = new Map<string, PendingCall>();
  private readonly cache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();
  private readonly lookups = new Map<string, Promise<Record<string, unknown>>>();
  private intranetProbePromise?: Promise<void>;
  private intranetAvailableUntil = 0;
  private cacheEpoch = 0;

  constructor(private readonly options: RiskDirectClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  }

  async listProducts(): Promise<string[]> {
    const data = await this.lookup('list_products', {}, this.options.productCacheTtlMs ?? 3_600_000);
    const products = Array.isArray(data.products) ? data.products : [];
    return products.map(productName).filter((item): item is string => Boolean(item));
  }

  async searchSecurities(query: string): Promise<RiskSecuritySuggestion[]> {
    const data = await this.lookup('search_securities', { query: query.trim() }, this.options.securityCacheTtlMs ?? 30_000);
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    return suggestions
      .map(securitySuggestion)
      .filter((item): item is RiskSecuritySuggestion => Boolean(item));
  }

  checkSecurity(product: string, security: string): Promise<Record<string, unknown>> {
    return this.call('check_security', { product, security });
  }

  checkCounterparty(product: string, counterparty: string): Promise<Record<string, unknown>> {
    return this.call('check_counterparty', { product, counterparty });
  }

  getHoldings(product: string): Promise<Record<string, unknown>> {
    return this.call('get_holdings', { product });
  }

  getRestrictions(product: string): Promise<Record<string, unknown>> {
    return this.call('get_restrictions', { product });
  }

  getCredit(entity: string): Promise<Record<string, unknown>> {
    return this.call('get_credit', { entity }, undefined, 180_000);
  }

  getCredits(entities: string[]): Promise<Record<string, unknown>> {
    return this.call('get_credits', { entities }, undefined, 180_000);
  }

  async calculatePretrade(
    product: string,
    action: RiskPretradeAction | RiskPretradeAction[],
    onProgress?: (progress: string) => void,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    try {
      const result = await this.call('calculate_pretrade', { product, action }, onProgress);
      this.reportStage(startedAt, 'success');
      return result;
    } catch (error) {
      this.reportStage(
        startedAt,
        error instanceof RiskServiceError && error.code === 'direct-timeout' ? 'timeout' : 'error',
      );
      throw error;
    }
  }

  async prewarm(): Promise<void> {
    await this.ensureStarted();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearLookupCache();
    const failure = new RiskServiceError('risk-service 已关闭', 'direct-process');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    this.lines?.close();
    this.lines = undefined;
    const child = this.child;
    this.startReject?.(failure);
    this.startResolve = undefined;
    this.startReject = undefined;
    this.childGeneration++;
    this.child = undefined;
    this.ready = false;
    this.startPromise = undefined;
    if (!isChildRunning(child)) return;
    await terminateChild(child, 2_000, 1_000);
  }

  private reportStage(startedAt: number, outcome: RiskStageEvent['outcome']): void {
    try {
      this.options.onStage?.({
        stage: 'direct',
        durationMs: Date.now() - startedAt,
        outcome,
      });
    } catch {
      // Metrics must never change risk-query behavior.
    }
  }

  clearLookupCache(): void {
    this.cacheEpoch++;
    this.cache.clear();
    this.lookups.clear();
  }

  private metric(method: string, startedAt: number, outcome: 'success' | 'error' | 'cache' | 'joined'): void {
    try { this.options.onCall?.({ method, durationMs: Date.now() - startedAt, outcome }); }
    catch { /* Diagnostics cannot affect a query. */ }
  }

  private async lookup(method: string, args: Record<string, unknown>, ttlMs: number): Promise<Record<string, unknown>> {
    await this.ensureIntranetAvailable();
    const key = JSON.stringify([method, args]);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.metric(method, Date.now(), 'cache');
      return structuredClone(cached.value);
    }
    this.cache.delete(key);
    const existing = this.lookups.get(key);
    if (existing) {
      this.metric(method, Date.now(), 'joined');
      return structuredClone(await existing);
    }
    if (this.lookups.size >= (this.options.maxPendingCalls ?? 32)) {
      throw new RiskServiceError('risk-service 当前查询较多', 'direct-capacity');
    }
    const epoch = this.cacheEpoch;
    const promise = this.call(method, args, undefined, this.timeoutMs, true);
    this.lookups.set(key, promise);
    try {
      const value = await promise;
      const rows = method === 'list_products' ? value.products : value.suggestions;
      // Do not retain misses/errors; live checks and calculations are never cached.
      if (epoch === this.cacheEpoch && ttlMs > 0 && Array.isArray(rows) && rows.length > 0) {
        if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expiresAt: Date.now() + ttlMs, value: structuredClone(value) });
      }
      return structuredClone(value);
    } finally {
      if (this.lookups.get(key) === promise) this.lookups.delete(key);
    }
  }

  private async call(
    method: string,
    args: Record<string, unknown>,
    onProgress?: (message: string) => void,
    timeoutMs = this.timeoutMs,
    intranetChecked = false,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    if (!intranetChecked) await this.ensureIntranetAvailable();
    await this.ensureStarted();
    if (this.pending.size >= (this.options.maxPendingCalls ?? 32)) {
      throw new RiskServiceError('risk-service 当前任务较多', 'direct-capacity');
    }
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new RiskServiceError('risk-service 本地进程不可用', 'direct-process');
    }
    const id = randomUUID();
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Cancel queued work; running backend operations drain without killing peers.
        if (child.stdin.writable) child.stdin.write(JSON.stringify({ id, method: 'cancel' }) + '\n', () => {});
        this.metric(method, startedAt, 'error');
        reject(new RiskServiceError('risk-service 本地调用超时', 'direct-timeout'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: value => { this.metric(method, startedAt, 'success'); resolve(value); },
        reject: error => { this.metric(method, startedAt, 'error'); reject(error); },
        onProgress, timer,
      });
      child.stdin.write(`${JSON.stringify({ id, method, args, timeout_ms: timeoutMs })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new RiskServiceError(error.message, 'direct-process'));
      });
    });
  }

  private async ensureIntranetAvailable(): Promise<void> {
    if (this.intranetAvailableUntil > Date.now()) return;
    if (this.intranetProbePromise) return await this.intranetProbePromise;
    const host = this.options.intranetHost ?? '10.8.11.57';
    const port = this.options.intranetPort ?? 80;
    const timeoutMs = this.options.intranetTimeoutMs ?? 1_500;
    const probe = this.options.intranetProbe ?? probeTcpConnection;
    const pending = (async () => {
      let available = false;
      try {
        available = await probe(host, port, timeoutMs);
      } catch {
        available = false;
      }
      if (!available) {
        this.intranetAvailableUntil = 0;
        throw new RiskServiceError(
          `公司内网不可用：无法连接 ${host}:${port}`,
          'intranet-unavailable',
        );
      }
      this.intranetAvailableUntil = Date.now() + (this.options.intranetCacheTtlMs ?? 0);
    })();
    this.intranetProbePromise = pending;
    try {
      await pending;
    } finally {
      if (this.intranetProbePromise === pending) this.intranetProbePromise = undefined;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready && isChildRunning(this.child)) return;
    if (this.startPromise) return await this.startPromise;
    this.closing = false;
    const generation = ++this.childGeneration;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const failure = new RiskServiceError(
          'risk-service 本地进程启动超时',
          'direct-start-timeout',
        );
        const child = this.child;
        if (isChildRunning(child)) child.kill('SIGTERM');
        this.handleExit(failure, child, generation);
      }, this.startupTimeoutMs);
      timer.unref();
      this.startResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.startReject = (reason) => {
        clearTimeout(timer);
        reject(reason);
      };
    });
    const child = spawn(
      this.options.pythonPath,
      [
        '-u',
        this.options.bridgePath,
        '--service-dir',
        this.options.serviceDir,
        '--state-dir',
        this.options.stateDir,
        '--workers',
        String(this.options.workers ?? 4),
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      },
    );
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line) => this.options.onDiagnostic?.(line));
    child.once('error', (error) => this.handleExit(error, child, generation));
    child.once('exit', (code, signal) => {
      stderr.close();
      this.handleExit(
        new RiskServiceError(
          `risk-service 本地进程退出：code=${code ?? ''} signal=${signal ?? ''}`,
          'direct-process',
        ),
        child,
        generation,
      );
    });
    return await this.startPromise;
  }

  private handleLine(line: string): void {
    const message = parseJson(line);
    if (!isRecord(message)) return;
    if (message.type === 'ready') {
      const startupTimings = numberRecord(message.startup_timings);
      if (startupTimings) {
        try { this.options.onStartup?.(startupTimings); }
        catch { /* Diagnostics cannot affect readiness. */ }
      }
      this.ready = true;
      this.startResolve?.();
      this.startResolve = undefined;
      this.startReject = undefined;
      return;
    }
    const id = stringValue(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    if (message.type === 'progress') {
      const progress = stringValue(message.message);
      if (progress) pending.onProgress?.(progress);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.type === 'result' && isRecord(message.data)) {
      pending.resolve(message.data);
      return;
    }
    pending.reject(
      new RiskServiceError(
        stringValue(message.error) || 'risk-service 本地调用失败',
        'direct-error',
      ),
    );
  }

  private handleExit(
    error: unknown,
    child: ChildProcessWithoutNullStreams | undefined,
    generation: number,
  ): void {
    if (generation !== this.childGeneration || (child && this.child !== child)) return;
    this.clearLookupCache();
    const failure =
      error instanceof RiskServiceError
        ? error
        : new RiskServiceError(
            error instanceof Error ? error.message : String(error),
            'direct-process',
          );
    if (!this.ready) this.startReject?.(failure);
    this.ready = false;
    this.startPromise = undefined;
    this.startResolve = undefined;
    this.startReject = undefined;
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      this.pending.delete(id);
    }
    if (!this.closing) this.options.onDiagnostic?.(failure.message);
  }
}

function probeTcpConnection(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function isChildRunning(
  child: ChildProcessWithoutNullStreams | undefined,
): child is ChildProcessWithoutNullStreams {
  return Boolean(child && child.exitCode === null && child.signalCode == null);
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  gracefulMs: number,
  forcedMs: number,
): Promise<void> {
  if (!isChildRunning(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  if (await waitForChildExit(child, gracefulMs)) return;
  if (!isChildRunning(child)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
  await waitForChildExit(child, forcedMs);
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (!isChildRunning(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once('exit', onExit);
  });
}

export class RiskServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RiskServiceError';
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function productName(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  return stringValue(value.product) || stringValue(value.name) || stringValue(value.product_name);
}

function securitySuggestion(value: unknown): RiskSecuritySuggestion | undefined {
  if (!isRecord(value)) return undefined;
  const name = stringValue(value.security_name) || stringValue(value.name);
  const code =
    stringValue(value.security_code) ||
    stringValue(value.code) ||
    stringValue(value.security_id);
  if (!name && !code) return undefined;
  return {
    name: name || code,
    code,
    label: stringValue(value.label) || [name, code].filter(Boolean).join(' '),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}
