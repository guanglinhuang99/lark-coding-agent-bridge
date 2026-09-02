import type { RiskPretradeAction, RiskSecuritySuggestion, RiskService } from './client';
import { RiskServiceError } from './client';
import {
  extractAmount,
  findAction,
  isRiskCandidate,
  matchProducts,
  parseRiskMessage,
  type RiskIntent,
} from './parser';
import {
  formatCalculation,
  formatCounterpartyCheck,
  formatCredit,
  formatHoldings,
  formatRestrictions,
  formatSecurityCheck,
} from './formatter';

export type RiskRouteResult =
  | { handled: false }
  | { handled: true; markdown: string; intent: string };

export interface WeComRiskRouterOptions {
  productCacheTtlMs?: number;
  pendingTtlMs?: number;
  now?: () => number;
}

type PendingState =
  | { kind: 'product'; intent: RiskIntent; options: string[]; expiresAt: number }
  | {
      kind: 'security';
      intent: Extract<RiskIntent, { kind: 'pretrade_calc' | 'check_security' }>;
      options: RiskSecuritySuggestion[];
      expiresAt: number;
    }
  | { kind: 'missing'; intent: RiskIntent; expiresAt: number };

export class WeComRiskRouter {
  private readonly productCacheTtlMs: number;
  private readonly pendingTtlMs: number;
  private readonly now: () => number;
  private products: string[] = [];
  private productsLoadedAt = 0;
  private readonly pending = new Map<string, PendingState>();

  constructor(
    private readonly service: RiskService,
    options: WeComRiskRouterOptions = {},
  ) {
    this.productCacheTtlMs = options.productCacheTtlMs ?? 60 * 60_000;
    this.pendingTtlMs = options.pendingTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  shouldHandle(conversationKey: string, text: string, hasAttachments: boolean): boolean {
    if (hasAttachments) return false;
    return this.pending.has(conversationKey) || isRiskCandidate(text);
  }

  async handle(
    conversationKey: string,
    text: string,
    onProgress?: (progress: string) => void,
  ): Promise<RiskRouteResult> {
    try {
      const pending = this.pending.get(conversationKey);
      if (pending?.expiresAt !== undefined && pending.expiresAt <= this.now()) {
        this.pending.delete(conversationKey);
        if (!isRiskCandidate(text)) {
          return handled(
            pending.intent.kind,
            '之前的选择已过期，请重新发送完整交易或查询。该消息未调用 AI。',
          );
        }
      } else if (pending) {
        return await this.handlePending(conversationKey, pending, text, onProgress);
      }
      const products = await this.loadProducts();
      const intent = parseRiskMessage(text, products);
      if (intent.kind === 'unknown') {
        return {
          handled: true,
          intent: 'unknown-risk',
          markdown: riskHelp('我识别到这是风险查询，但缺少可执行参数。'),
        };
      }
      return await this.execute(conversationKey, intent, onProgress);
    } catch (error) {
      return {
        handled: true,
        intent: 'risk-error',
        markdown: formatRiskError(error),
      };
    }
  }

  clear(conversationKey: string): void {
    this.pending.delete(conversationKey);
  }

  private async loadProducts(): Promise<string[]> {
    const fresh = this.products.length > 0 && this.now() - this.productsLoadedAt < this.productCacheTtlMs;
    if (fresh) return this.products;
    try {
      const loaded = await this.service.listProducts();
      if (loaded.length > 0) {
        this.products = [...new Set(loaded)];
        this.productsLoadedAt = this.now();
      }
    } catch (error) {
      if (this.products.length === 0) throw error;
    }
    if (this.products.length === 0) {
      throw new RiskServiceError('暂时无法获取存续产品列表，请稍后重试', 'products-unavailable');
    }
    return this.products;
  }

  private async execute(
    conversationKey: string,
    intent: RiskIntent,
    onProgress?: (progress: string) => void,
  ): Promise<RiskRouteResult> {
    if (intent.kind === 'list_products') {
      return {
        handled: true,
        intent: intent.kind,
        markdown: `**可用产品（共 ${this.products.length} 个）**\n\n${this.products.slice(0, 50).map((item) => `- ${item}`).join('\n')}${this.products.length > 50 ? '\n- …' : ''}`,
      };
    }

    if (intent.kind === 'search_securities') {
      if (!intent.query) return handled(intent.kind, '请告诉我要搜索的证券名称或代码。');
      const options = await this.service.searchSecurities(intent.query);
      if (options.length === 0) return handled(intent.kind, `没有找到与「${intent.query}」相关的证券。`);
      return handled(
        intent.kind,
        `**「${intent.query}」匹配到以下证券**\n\n${options.slice(0, 10).map((item) => `- ${item.label}`).join('\n')}`,
      );
    }

    if ('productCandidates' in intent) {
      if (intent.productCandidates.length > 1 && !intent.product) {
        this.pending.set(conversationKey, {
          kind: 'product',
          intent,
          options: intent.productCandidates,
          expiresAt: this.now() + this.pendingTtlMs,
        });
        return handled(intent.kind, selectionPrompt('产品', intent.productCandidates));
      }
      if (!intent.product) {
        this.pending.set(conversationKey, {
          kind: 'missing',
          intent,
          expiresAt: this.now() + this.pendingTtlMs,
        });
        return handled(intent.kind, '还差产品名。请回复存续产品的完整名称，或发送“有哪些产品”。');
      }
    }

    if (intent.kind === 'check_security') {
      if (!intent.securityQuery) {
        this.pending.set(conversationKey, {
          kind: 'missing',
          intent,
          expiresAt: this.now() + this.pendingTtlMs,
        });
        return handled(intent.kind, '还差证券名称或代码，请直接回复证券名称或代码。');
      }
      const options = await this.service.searchSecurities(intent.securityQuery);
      if (options.length === 0) {
        return handled(intent.kind, `没有找到与「${intent.securityQuery}」相关的证券，请提供更精确的名称或代码。`);
      }
      const exact = exactSecurityMatch(intent.securityQuery, options);
      if (exact) {
        const data = await this.service.checkSecurity(intent.product ?? '', exact.code || exact.name);
        return handled(intent.kind, formatSecurityCheck(data));
      }
      this.pending.set(conversationKey, {
        kind: 'security',
        intent,
        options: options.slice(0, 10),
        expiresAt: this.now() + this.pendingTtlMs,
      });
      if (options.length === 1) {
        return handled(
          intent.kind,
          `请确认证券：**${options[0]?.label}**\n\n回复“确认”或“1”开始检查；若不是，请直接发正确名称或代码。`,
        );
      }
      return handled(intent.kind, selectionPrompt('证券', options.slice(0, 10).map((item) => item.label)));
    }

    if (intent.kind === 'check_counterparty') {
      if (!intent.counterparty) return handled(intent.kind, '还差交易对手名称，请直接回复完整名称。');
      if (!intent.product) return handled(intent.kind, '还差产品名，请回复存续产品的完整名称。');
      const data = await this.service.checkCounterparty(intent.product, intent.counterparty);
      return handled(intent.kind, formatCounterpartyCheck(data));
    }

    if (intent.kind === 'query_holdings') {
      if (!intent.product) return handled(intent.kind, '还差产品名，请回复存续产品的完整名称。');
      return handled(intent.kind, formatHoldings(await this.service.getHoldings(intent.product)));
    }

    if (intent.kind === 'query_restrictions') {
      if (!intent.product) return handled(intent.kind, '还差产品名，请回复存续产品的完整名称。');
      return handled(intent.kind, formatRestrictions(await this.service.getRestrictions(intent.product)));
    }

    if (intent.kind === 'query_credit') {
      if (!intent.entity) return handled(intent.kind, '还差主体名称，例如“赣锋锂业 授信额度”。');
      return handled(intent.kind, formatCredit(await this.service.getCredit(intent.entity)));
    }

    if (intent.kind === 'pretrade_calc') {
      if (intent.missing.length > 0) {
        this.pending.set(conversationKey, {
          kind: 'missing',
          intent,
          expiresAt: this.now() + this.pendingTtlMs,
        });
        return handled(
          intent.kind,
          `还差：${intent.missing.join('、')}。请直接回复缺少的信息；也可以重新发送完整交易，例如“安联ESG纯债1号 申购 0.1”。`,
        );
      }
      if (!intent.action || !intent.product) return handled(intent.kind, riskHelp('交易参数不完整。'));
      if (intent.action === 'buy' || intent.action === 'sell') {
        if (!intent.securityQuery) return handled(intent.kind, '买入/卖出还需要证券名称或代码。');
        const options = await this.service.searchSecurities(intent.securityQuery);
        if (options.length === 0) {
          return handled(intent.kind, `没有找到与「${intent.securityQuery}」相关的证券，请提供更精确的名称或代码。`);
        }
        const exact = exactSecurityMatch(intent.securityQuery, options);
        if (options.length > 1 && !exact) {
          this.pending.set(conversationKey, {
            kind: 'security',
            intent,
            options: options.slice(0, 10),
            expiresAt: this.now() + this.pendingTtlMs,
          });
          return handled(intent.kind, selectionPrompt('证券', options.slice(0, 10).map((item) => item.label)));
        }
        return await this.runCalculation(intent, exact ?? options[0], onProgress);
      }
      return await this.runCalculation(intent, undefined, onProgress);
    }

    return { handled: false };
  }

  private async handlePending(
    conversationKey: string,
    pending: PendingState,
    text: string,
    onProgress?: (progress: string) => void,
  ): Promise<RiskRouteResult> {
    if (pending.kind === 'product') {
      const index = selectionIndex(text, pending.options.length);
      const direct = matchProducts(text, pending.options);
      const selected = index === undefined ? (direct.length === 1 ? direct[0] : undefined) : pending.options[index];
      if (!selected) return handled(pending.intent.kind, selectionPrompt('产品', pending.options));
      this.pending.delete(conversationKey);
      const intent = { ...pending.intent, product: selected, productCandidates: [selected] } as RiskIntent;
      return this.execute(conversationKey, intent, onProgress);
    }

    if (pending.kind === 'security') {
      const index = isConfirm(text) && pending.options.length === 1 ? 0 : selectionIndex(text, pending.options.length);
      if (index === undefined) {
        this.pending.delete(conversationKey);
        const products = await this.loadProducts();
        const reparsed = parseRiskMessage(text, products);
        if (reparsed.kind !== 'unknown') return this.execute(conversationKey, reparsed, onProgress);
        return handled(pending.intent.kind, selectionPrompt('证券', pending.options.map((item) => item.label)));
      }
      const selected = pending.options[index];
      if (!selected) return handled(pending.intent.kind, '证券序号超出范围，请重新选择。');
      this.pending.delete(conversationKey);
      if (pending.intent.kind === 'check_security') {
        const data = await this.service.checkSecurity(
          pending.intent.product ?? '',
          selected.code || selected.name,
        );
        return handled(pending.intent.kind, formatSecurityCheck(data));
      }
      return this.runCalculation(pending.intent, selected, onProgress);
    }

    const products = await this.loadProducts();
    const productMatches = matchProducts(text, products);
    const reparsed = parseRiskMessage(text, products);
    let merged = pending.intent;
    if ('productCandidates' in merged && productMatches.length === 1) {
      merged = { ...merged, product: productMatches[0], productCandidates: productMatches } as RiskIntent;
    }
    if (merged.kind === 'pretrade_calc') {
      const amount = extractAmount(text);
      const action = findAction(text);
      merged = {
        ...merged,
        ...(action ? { action } : {}),
        ...(amount
          ? { amount: amount.amount, quantity: amount.quantity, amountNote: amount.note }
          : {}),
      };
      if (reparsed.kind === 'pretrade_calc') {
        merged = {
          ...merged,
          ...(reparsed.product ? { product: reparsed.product, productCandidates: reparsed.productCandidates } : {}),
          ...(reparsed.securityQuery ? { securityQuery: reparsed.securityQuery } : {}),
        };
      }
      if (
        (merged.action === 'buy' || merged.action === 'sell') &&
        !merged.securityQuery &&
        reparsed.kind === 'unknown' &&
        !amount &&
        !action &&
        productMatches.length === 0
      ) {
        merged = { ...merged, securityQuery: text.trim() };
      }
      merged = { ...merged, missing: pretradeMissing(merged) };
    } else if (
      merged.kind === 'check_security' &&
      !merged.securityQuery &&
      reparsed.kind === 'unknown' &&
      productMatches.length === 0
    ) {
      merged = { ...merged, securityQuery: text.trim() };
    } else if (
      merged.kind === 'check_counterparty' &&
      !merged.counterparty &&
      reparsed.kind === 'unknown' &&
      productMatches.length === 0
    ) {
      merged = { ...merged, counterparty: text.trim() };
    } else if (merged.kind === 'query_credit' && !merged.entity && reparsed.kind === 'unknown') {
      merged = { ...merged, entity: text.trim() };
    } else if (reparsed.kind === merged.kind) {
      merged = reparsed;
    }
    this.pending.delete(conversationKey);
    return this.execute(conversationKey, merged, onProgress);
  }

  private async runCalculation(
    intent: Extract<RiskIntent, { kind: 'pretrade_calc' }>,
    security: RiskSecuritySuggestion | undefined,
    onProgress?: (progress: string) => void,
  ): Promise<RiskRouteResult> {
    if (!intent.product || !intent.action) return handled(intent.kind, riskHelp('交易参数不完整。'));
    const action: RiskPretradeAction = { type: intent.action };
    if (intent.action === 'buy' || intent.action === 'sell') {
      if (intent.quantity !== undefined) action.quantity = intent.quantity;
      else action.amount = intent.amount;
      action.security_name = security?.code || security?.name || intent.securityQuery;
    } else if (intent.action === 'repo' || intent.action === 'reverse_repo') {
      action.amount = intent.amount;
      if (intent.days !== undefined) action.days = intent.days;
    } else if (intent.quantity !== undefined) {
      action.shares = intent.quantity;
    } else {
      action.amount = intent.amount;
    }
    const result = await this.service.calculatePretrade(intent.product, action, onProgress);
    return handled(intent.kind, formatCalculation(result, intent.amountNote));
  }

}

function handled(intent: string, markdown: string): RiskRouteResult {
  return { handled: true, intent, markdown };
}

function selectionPrompt(label: string, options: readonly string[]): string {
  if (options.length === 0) return `没有可选择的${label}候选。`;
  return `**请选择${label}**\n\n${options.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\n回复数字序号。`;
}

function selectionIndex(text: string, length: number): number | undefined {
  const match = /^\s*(\d+)\s*[。.]?\s*$/.exec(text);
  if (!match) return undefined;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 && index < length ? index : undefined;
}

function isConfirm(text: string): boolean {
  return /^(?:确认|是|是的|对|对的|好|好的|可以|行|ok|yes|y)$/i.test(text.trim());
}

function exactSecurityMatch(
  query: string,
  options: readonly RiskSecuritySuggestion[],
): RiskSecuritySuggestion | undefined {
  const normalized = query.trim().toUpperCase();
  if (!normalized) return undefined;
  return options.find((item) => item.code.trim().toUpperCase() === normalized);
}

function pretradeMissing(intent: Extract<RiskIntent, { kind: 'pretrade_calc' }>): string[] {
  const missing: string[] = [];
  if (!intent.product) missing.push('产品名');
  if (!intent.action) missing.push('动作（申购/赎回/买入/卖出/回购）');
  if (intent.amount === undefined && intent.quantity === undefined) missing.push('金额或数量');
  if ((intent.action === 'buy' || intent.action === 'sell') && !intent.securityQuery) {
    missing.push('证券名称或代码');
  }
  return missing;
}

function riskHelp(prefix: string): string {
  return `${prefix}\n\n可以这样问：\n- 安联ESG纯债1号 申购 0.1\n- 安联ESG纯债1号 买 1000万 国债0115\n- 安联ESG纯债1号 能不能买 国债0115\n- 有哪些产品`;
}

function formatRiskError(error: unknown): string {
  if (error instanceof RiskServiceError) return `⚠️ **风险查询失败**：${error.message}`;
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout/i.test(message)) return '⚠️ **风险查询超时**：riskservice 暂未在规定时间内响应。';
  return `⚠️ **风险查询失败**：${message}`;
}
