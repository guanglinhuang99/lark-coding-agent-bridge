import { randomUUID } from 'node:crypto';
import type {
  RiskBusinessCapabilities,
  RiskPretradeAction,
  RiskSecuritySuggestion,
  RiskService,
} from './client';
import { RiskServiceError } from './client';

export interface RiskMcpClientOptions {
  url?: string;
  endpointLabel?: string;
  requestHandler?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  closeHandler?: () => Promise<void>;
  authorization?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  productCacheTtlMs?: number;
  securityCacheTtlMs?: number;
  onCall?: (event: { method: string; durationMs: number; outcome: 'success' | 'error' | 'cache' | 'joined' }) => void;
  onStage?: (event: { stage: 'mcp'; durationMs: number; outcome: 'success' | 'error' | 'timeout' }) => void;
  fetch?: typeof fetch;
}

export interface RiskMcpRuntimeStatus {
  ready: boolean;
  endpoint?: string;
  businessCapabilities?: RiskBusinessCapabilities;
}

type JsonObject = Record<string, unknown>;

export class RiskMcpClient implements RiskService {
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, { expiresAt: number; value: JsonObject }>();
  private readonly lookups = new Map<string, Promise<JsonObject>>();
  private ready = false;
  private closed = false;
  private tools?: Set<string>;

  constructor(private readonly options: RiskMcpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.fetchImpl = options.fetch ?? fetch;
    if (!options.url && !options.requestHandler) throw new Error('Risk MCP transport is not configured');
  }

  async listProducts(): Promise<string[]> {
    const data = await this.lookup('list_pretrade_products', {}, this.options.productCacheTtlMs ?? 3_600_000);
    return (Array.isArray(data.products) ? data.products : []).map(text).filter(Boolean) as string[];
  }

  async searchSecurities(query: string): Promise<RiskSecuritySuggestion[]> {
    const data = await this.lookup('search_pretrade_securities', { query: query.trim() }, this.options.securityCacheTtlMs ?? 30_000);
    return (Array.isArray(data.suggestions) ? data.suggestions : []).map(suggestion).filter(Boolean) as RiskSecuritySuggestion[];
  }

  checkSecurity(product: string, security: string): Promise<JsonObject> {
    return this.callTool('check_security_restricted', { ptf: product, security_name: security });
  }

  checkCounterparty(product: string, counterparty: string): Promise<JsonObject> {
    return this.callTool('check_counterparty_related_party', { ptf: product, counterparty_name: counterparty });
  }

  getHoldings(product: string): Promise<JsonObject> {
    return this.callTool('get_product_holdings', { product });
  }

  getRestrictions(product: string): Promise<JsonObject> {
    return this.callTool('get_product_investment_restrictions', { product });
  }

  getCredit(entity: string): Promise<JsonObject> {
    return this.callTool('get_entity_credit', { entity });
  }

  async getCredits(entities: string[]): Promise<JsonObject> {
    const reports = await Promise.all(entities.map(entity => this.getCredit(entity)));
    return { date: reports[0]?.date, amount_unit: reports[0]?.amount_unit, reports };
  }

  async calculatePretrade(
    product: string,
    action: RiskPretradeAction | RiskPretradeAction[],
    onProgress?: (progress: string) => void,
  ): Promise<JsonObject> {
    const startedAt = Date.now();
    try {
      const submitted = await this.callTool('calculate_pretrade_limits', {
        product,
        actions: Array.isArray(action) ? action : [action],
      });
      const runId = text(submitted.run_id);
      if (!runId) throw new RiskServiceError('MCP 未返回投前测算任务 ID', 'mcp-protocol');
      let lastProgress = '';
      while (Date.now() - startedAt < this.timeoutMs) {
        const run = await this.callTool('get_pretrade_limits_run', { run_id: runId });
        const progress = text(run.progress);
        if (progress && progress !== lastProgress) {
          lastProgress = progress;
          onProgress?.(progress);
        }
        const status = text(run.status);
        if (status === 'success') {
          const result = object(run.result);
          const value = result ? { ...run, ...result, status } : run;
          this.options.onStage?.({ stage: 'mcp', durationMs: Date.now() - startedAt, outcome: 'success' });
          return value;
        }
        if (status === 'error' || status === 'failed') {
          throw new RiskServiceError(text(run.error) || '投前测算失败', 'mcp-tool');
        }
        await delay(this.pollIntervalMs);
      }
      throw new RiskServiceError('risk-service MCP 调用超时', 'mcp-timeout');
    } catch (error) {
      this.options.onStage?.({
        stage: 'mcp', durationMs: Date.now() - startedAt,
        outcome: error instanceof RiskServiceError && error.code === 'mcp-timeout' ? 'timeout' : 'error',
      });
      throw error;
    }
  }

  async prewarm(): Promise<void> {
    this.tools = await this.listTools();
    this.ready = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ready = false;
    this.cache.clear();
    this.lookups.clear();
    await this.options.closeHandler?.();
  }

  runtimeStatus(): RiskMcpRuntimeStatus {
    return this.closed || !this.ready ? { ready: false } : {
      ready: true,
      endpoint: this.options.endpointLabel ?? (this.options.url ? safeEndpoint(this.options.url) : 'local-stdio'),
    };
  }

  clearLookupCache(): void {
    this.cache.clear();
    this.lookups.clear();
  }

  private async lookup(tool: string, args: JsonObject, ttlMs: number): Promise<JsonObject> {
    const key = JSON.stringify([tool, args]);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.options.onCall?.({ method: tool, durationMs: 0, outcome: 'cache' });
      return structuredClone(cached.value);
    }
    const joined = this.lookups.get(key);
    if (joined) {
      this.options.onCall?.({ method: tool, durationMs: 0, outcome: 'joined' });
      return structuredClone(await joined);
    }
    const pending = this.callTool(tool, args);
    this.lookups.set(key, pending);
    try {
      const value = await pending;
      if (ttlMs > 0) this.cache.set(key, { expiresAt: Date.now() + ttlMs, value: structuredClone(value) });
      return structuredClone(value);
    } finally {
      if (this.lookups.get(key) === pending) this.lookups.delete(key);
    }
  }

  private async listTools(): Promise<Set<string>> {
    const result = await this.request('tools/list', {});
    return new Set((Array.isArray(result.tools) ? result.tools : [])
      .map(item => text(object(item)?.name)).filter(Boolean));
  }

  private async callTool(name: string, args: JsonObject): Promise<JsonObject> {
    const startedAt = Date.now();
    try {
      if (this.tools && !this.tools.has(name)) {
        throw new RiskServiceError(`Connect MCP 未发布所需工具：${name}`, 'mcp-tool-unavailable');
      }
      const result = await this.request('tools/call', { name, arguments: args });
      if (result.isError === true) throw new RiskServiceError(contentText(result) || `MCP 工具 ${name} 调用失败`, 'mcp-tool');
      const value = object(result.structuredContent) ?? parseContent(result);
      if (!value) throw new RiskServiceError(`MCP 工具 ${name} 返回格式无效`, 'mcp-protocol');
      this.ready = true;
      this.options.onCall?.({ method: name, durationMs: Date.now() - startedAt, outcome: 'success' });
      return value;
    } catch (error) {
      this.options.onCall?.({ method: name, durationMs: Date.now() - startedAt, outcome: 'error' });
      throw error;
    }
  }

  private async request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.closed) throw new RiskServiceError('risk-service MCP 已关闭', 'mcp-closed');
    if (this.options.requestHandler) return await this.options.requestHandler(method, params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.options.url!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.options.authorization ? { authorization: this.options.authorization } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new RiskServiceError(`risk-service MCP HTTP ${response.status}`, 'mcp-http');
      const payload = await response.json() as JsonObject;
      const rpcError = object(payload.error);
      if (rpcError) throw new RiskServiceError(text(rpcError.message) || 'risk-service MCP 请求失败', 'mcp-rpc');
      const result = object(payload.result);
      if (!result) throw new RiskServiceError('risk-service MCP 响应格式无效', 'mcp-protocol');
      return result;
    } catch (error) {
      if (error instanceof RiskServiceError) throw error;
      if (controller.signal.aborted) throw new RiskServiceError('risk-service MCP 调用超时', 'mcp-timeout');
      throw new RiskServiceError('risk-service MCP 暂时不可用', 'mcp-network');
    } finally {
      clearTimeout(timer);
    }
  }
}

const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
function suggestion(value: unknown): RiskSecuritySuggestion | undefined {
  const item = object(value); if (!item) return undefined;
  const name = text(item.security_name) || text(item.name), code = text(item.security_code) || text(item.code);
  return name && code ? { name, code, label: text(item.label) || `${name}（${code}）` } : undefined;
}
function parseContent(result: JsonObject): JsonObject | undefined {
  for (const item of Array.isArray(result.content) ? result.content : []) {
    const part = object(item), raw = part?.type === 'text' ? text(part.text) : '';
    if (!raw) continue;
    try { const parsed = JSON.parse(raw); const value = object(parsed); if (value) return value; } catch { /* try next */ }
  }
  return undefined;
}
function contentText(result: JsonObject): string {
  return (Array.isArray(result.content) ? result.content : []).map(item => text(object(item)?.text)).filter(Boolean).join('\n');
}
function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch { return 'configured'; }
}
const delay = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
