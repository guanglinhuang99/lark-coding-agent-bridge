import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import { RiskServiceError } from './client';

type JsonObject = Record<string, unknown>;

export interface StdioMcpOptions {
  pythonPath: string;
  serviceDir: string;
  launcherPath: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onDiagnostic?: (line: string) => void;
}

export class StdioMcpSession {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: ReadLineInterface;
  private starting?: Promise<void>;
  private initialized = false;
  private closed = false;
  private readonly pending = new Map<string, {
    resolve: (value: JsonObject) => void;
    reject: (reason: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly options: StdioMcpOptions) {}

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    await this.ensureStarted();
    return await this.sendRequest(method, params);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.initialized = false;
    const failure = new RiskServiceError('本地 risk-service MCP 已关闭', 'mcp-closed');
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(failure);
    }
    this.pending.clear();
    this.lines?.close();
    this.lines = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 2_000);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new RiskServiceError('本地 risk-service MCP 已关闭', 'mcp-closed');
    if (this.initialized && this.child?.exitCode === null) return;
    if (this.starting) return await this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return await this.starting;
  }

  private async start(): Promise<void> {
    const child = spawn(this.options.pythonPath, [this.options.launcherPath, this.options.serviceDir], {
      cwd: this.options.serviceDir,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => this.handleLine(line));
    createInterface({ input: child.stderr }).on('line', line => this.options.onDiagnostic?.(line));
    child.once('error', error => this.handleExit(error));
    child.once('exit', (code, signal) => this.handleExit(new Error(`local MCP exited: code=${code ?? ''} signal=${signal ?? ''}`)));
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wecom-bot-risk-client', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    this.initialized = true;
  }

  private sendRequest(method: string, params: JsonObject): Promise<JsonObject> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new RiskServiceError('本地 risk-service MCP 不可用', 'mcp-process'));
    const id = randomUUID();
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RiskServiceError('本地 risk-service MCP 调用超时', 'mcp-timeout'));
      }, this.options.timeoutMs ?? 180_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return;
        const item = this.pending.get(id);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(id);
        item.reject(new RiskServiceError('无法写入本地 risk-service MCP', 'mcp-process'));
      });
    });
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject; } catch { return; }
    const id = typeof message.id === 'string' ? message.id : '';
    const item = this.pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(id);
    const error = message.error && typeof message.error === 'object' ? message.error as JsonObject : undefined;
    if (error) {
      item.reject(new RiskServiceError(typeof error.message === 'string' ? error.message : '本地 MCP 请求失败', 'mcp-rpc'));
      return;
    }
    const result = message.result && typeof message.result === 'object' ? message.result as JsonObject : undefined;
    result ? item.resolve(result) : item.reject(new RiskServiceError('本地 MCP 响应格式无效', 'mcp-protocol'));
  }

  private handleExit(error: unknown): void {
    this.initialized = false;
    this.child = undefined;
    const failure = new RiskServiceError(error instanceof Error ? error.message : '本地 MCP 已退出', 'mcp-process');
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(failure);
    }
    this.pending.clear();
  }
}
