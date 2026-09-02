import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import type { RiskActionType } from './parser';

export interface RiskSecuritySuggestion {
  name: string;
  code: string;
  label: string;
}

export interface RiskPretradeAction {
  type: RiskActionType;
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
    action: RiskPretradeAction,
    onProgress?: (progress: string) => void,
  ): Promise<Record<string, unknown>>;
}

export interface RiskDirectClientOptions {
  pythonPath: string;
  serviceDir: string;
  stateDir: string;
  bridgePath: string;
  timeoutMs?: number;
  workers?: number;
  onStage?: (event: RiskStageEvent) => void;
  onDiagnostic?: (line: string) => void;
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
  private child?: ChildProcessWithoutNullStreams;
  private lines?: ReadLineInterface;
  private ready = false;
  private startPromise?: Promise<void>;
  private startResolve?: () => void;
  private startReject?: (reason: unknown) => void;
  private closing = false;
  private readonly pending = new Map<string, PendingCall>();

  constructor(private readonly options: RiskDirectClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async listProducts(): Promise<string[]> {
    const data = await this.call('list_products', {});
    const products = Array.isArray(data.products) ? data.products : [];
    return products.map(productName).filter((item): item is string => Boolean(item));
  }

  async searchSecurities(query: string): Promise<RiskSecuritySuggestion[]> {
    const data = await this.call('search_securities', { query });
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

  async calculatePretrade(
    product: string,
    action: RiskPretradeAction,
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

  async close(): Promise<void> {
    this.closing = true;
    this.lines?.close();
    this.lines = undefined;
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    this.startPromise = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
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

  private async call(
    method: string,
    args: Record<string, unknown>,
    onProgress?: (message: string) => void,
    timeoutMs = this.timeoutMs,
  ): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new RiskServiceError('risk-service 本地进程不可用', 'direct-process');
    }
    const id = randomUUID();
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RiskServiceError('risk-service 本地调用超时', 'direct-timeout'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, onProgress, timer });
      child.stdin.write(`${JSON.stringify({ id, method, args })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new RiskServiceError(error.message, 'direct-process'));
      });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready && this.child?.exitCode === null) return;
    if (this.startPromise) return await this.startPromise;
    this.closing = false;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
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
    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code, signal) => {
      stderr.close();
      this.handleExit(
        new RiskServiceError(
          `risk-service 本地进程退出：code=${code ?? ''} signal=${signal ?? ''}`,
          'direct-process',
        ),
      );
    });
    return await this.startPromise;
  }

  private handleLine(line: string): void {
    const message = parseJson(line);
    if (!isRecord(message)) return;
    if (message.type === 'ready') {
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

  private handleExit(error: unknown): void {
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
