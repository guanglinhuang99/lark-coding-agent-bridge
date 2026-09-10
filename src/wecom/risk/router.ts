import type { RiskPretradeAction, RiskSecuritySuggestion, RiskService } from './client';
import { confirmedRiskAmount, type RiskIntentState } from './intent';
import { RiskServiceError } from './client';
import {
  matchProductCandidates,
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
import { WECOM_RISK_USAGE_LINES } from '../commands';

export interface RiskSelectionOption {
  key: string;
  label: string;
  value?: string;
}

export interface RiskSelectionRequest {
  kind: 'product' | 'security' | 'intent-account' | 'intent-security' | 'intent-confirm';
  title: string;
  subTitle: string;
  replyHint: string;
  options: RiskSelectionOption[];
  expiresAt: number;
}

type RiskQueryIntent = Exclude<RiskIntent, { kind: 'pretrade_calc' } | { kind: 'unknown' }>;

export type RiskQueryState =
  | { kind: 'product'; intent: RiskQueryIntent; options: string[] }
  | {
      kind: 'security';
      intent: Extract<RiskQueryIntent, { kind: 'check_security' }>;
      options: RiskSecuritySuggestion[];
    }
  | { kind: 'missing'; intent: RiskQueryIntent };

export type RiskRouteResult =
  | { handled: false }
  | {
      handled: true;
      markdown: string;
      intent: string;
      selection?: RiskSelectionRequest;
      continuation?: RiskQueryState;
    };

export interface WeComRiskRouterOptions {
  /** @deprecated Product caching is owned by RiskDirectClient. */
  productCacheTtlMs?: number;
  selectionTtlMs?: number;
  /** @deprecated Use selectionTtlMs. */
  pendingTtlMs?: number;
  now?: () => number;
}

/**
 * Stateless deterministic router for non-pretrade risk queries.
 *
 * Conversation/card continuation state is returned to the caller as
 * `RiskQueryState`; the router never stores it. Pretrade parsing/confirmation is
 * owned by the intent flow in `risk/intent.ts`.
 */
export class WeComRiskRouter {
  private readonly selectionTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly service: RiskService,
    options: WeComRiskRouterOptions = {},
  ) {
    this.selectionTtlMs = options.selectionTtlMs ?? options.pendingTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async handle(
    _conversationKey: string,
    text: string,
    onProgress?: (progress: string) => void,
  ): Promise<RiskRouteResult> {
    try {
      // Product-independent queries should not pay the product-ledger cold-start cost.
      // Parse once without products; only load master products if routing or matching needs them.
      const independent = parseRiskMessage(text, []);
      if (independent.kind === 'search_securities' || independent.kind === 'query_credit') {
        return await this.execute(independent, [], onProgress);
      }
      const products = await this.loadProducts();
      const intent = parseRiskMessage(text, products);
      if (intent.kind === 'pretrade_calc') return { handled: false };
      if (intent.kind === 'unknown') {
        return handled(
          'unknown-risk',
          riskHelp('这条信息还缺少完整的风险查询内容。'),
        );
      }
      return await this.execute(intent, products, onProgress);
    } catch (error) {
      return handled('risk-error', formatRiskError(error));
    }
  }

  async continue(
    state: RiskQueryState,
    text: string,
    onProgress?: (progress: string) => void,
  ): Promise<RiskRouteResult> {
    try {
      const products = await this.loadProducts();
      if (state.kind === 'product') {
        const index = productSelectionIndex(text, state.options.length);
        const direct = matchProducts(text, state.options);
        const selected = index === undefined
          ? direct.length === 1 ? direct[0] : undefined
          : state.options[index];
        if (!selected) {
          return handled(
            state.intent.kind,
            selectionPrompt('账户', state.options, 'letter'),
            productSelection(state.options, this.selectionExpiry()),
            state,
          );
        }
        await onProgress?.(`已确认：账户「${selected}」，正在继续风险查询…`);
        const intent = {
          ...state.intent,
          product: selected,
          productCandidates: [selected],
        } as RiskQueryIntent;
        return await this.execute(intent, products, onProgress);
      }

      if (state.kind === 'security') {
        const index = isConfirm(text) && state.options.length === 1
          ? 0
          : selectionIndex(text, state.options.length);
        if (index === undefined) {
          const reparsed = parseRiskMessage(text, products);
          if (reparsed.kind === 'pretrade_calc') return { handled: false };
          if (reparsed.kind !== 'unknown') {
            return await this.execute(reparsed, products, onProgress);
          }
          return handled(
            state.intent.kind,
            state.options.length === 1
              ? `请确认证券：**${state.options[0]?.label}**\n\n点击“确认选择”，或回复“确认”/“1”。`
              : selectionPrompt('证券', state.options.map((item) => item.label), 'number'),
            securitySelection(state.options, this.selectionExpiry(), state.options.length === 1),
            state,
          );
        }
        const selected = state.options[index];
        if (!selected) {
          return handled(
            state.intent.kind,
            '证券序号超出范围，请重新选择。',
            securitySelection(state.options, this.selectionExpiry(), state.options.length === 1),
            state,
          );
        }
        await onProgress?.(`已确认：证券「${securityDisplay(selected)}」，正在继续风险查询…`);
        const data = await this.service.checkSecurity(
          state.intent.product ?? '',
          selected.code || selected.name,
        );
        return handled(state.intent.kind, formatSecurityCheck(data));
      }

      const productMatch = matchProductCandidates(text, products);
      const productMatches = productMatch.products;
      const reparsed = parseRiskMessage(text, products);
      if (reparsed.kind === 'pretrade_calc') return { handled: false };
      let merged: RiskQueryIntent = state.intent;

      if (reparsed.kind !== 'unknown' && reparsed.kind !== merged.kind) {
        return await this.execute(reparsed, products, onProgress);
      }
      if ('productCandidates' in merged && productMatches.length > 0) {
        merged = {
          ...merged,
          product: productMatches.length === 1 && !productMatch.fuzzy ? productMatches[0] : undefined,
          productCandidates: productMatches,
        } as RiskQueryIntent;
      }
      if (
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
      } else if (
        merged.kind === 'query_credit' &&
        !merged.entity &&
        reparsed.kind === 'unknown'
      ) {
        merged = { ...merged, entity: text.trim() };
      } else if (reparsed.kind === merged.kind) {
        merged = reparsed;
      }
      return await this.execute(merged, products, onProgress);
    } catch (error) {
      return handled('risk-error', formatRiskError(error));
    }
  }

  /** Called only with server-side state consumed by a validated confirmation. */
  async executeConfirmed(
    state: Extract<RiskIntentState, { stage: 'confirm' }>,
    onProgress?: (progress: string) => void,
  ): Promise<RiskRouteResult> {
    try {
      const accounts = state.draft.accounts?.map(account => ({
        product: account.resolvedProduct ?? '',
        transactions: account.transactions,
      })) ?? [{
        product: state.product,
        transactions: state.draft.transactions ?? [{ ...state.draft, resolvedSecurity: state.security }],
      }];
      if (!accounts.length || accounts.some(account => !account.product || !account.transactions.length)) {
        throw new RiskServiceError('交易信息尚未核验', 'unresolved-transaction');
      }
      // Validate every account and leg before submitting anything.
      const prepared = accounts.map((account, accountIndex) => {
        const notes: string[] = [];
        const actions = account.transactions.map((draft, index) => {
          const amount = confirmedRiskAmount(draft.amountText ?? '');
          const prefix = state.draft.accounts ? `第${accountIndex + 1}个账户第${index + 1}笔` : `第${index + 1}笔`;
          if (!amount) throw new RiskServiceError(`${prefix}交易规模无效`, 'invalid-amount');
          if (draft.days !== undefined && (!Number.isSafeInteger(draft.days) || draft.days <= 0)) {
            throw new RiskServiceError('期限无效', 'invalid-days');
          }
          const type = draft.action;
          if (!type || !['buy', 'sell', 'subscription', 'redemption', 'repo', 'reverse_repo'].includes(type)) {
            throw new RiskServiceError('交易信息尚未核验', 'unresolved-transaction');
          }
          const needsSecurity =
            type === 'buy' || type === 'sell' || (type === 'subscription' && draft.market === 'primary');
          if (needsSecurity && !draft.resolvedSecurity?.code) {
            throw new RiskServiceError('交易信息尚未核验', 'unresolved-transaction');
          }
          const action: RiskPretradeAction = { type, market: draft.market };
          if (needsSecurity) action.security_name = draft.resolvedSecurity!.code;
          if (type === 'repo' || type === 'reverse_repo') {
            if (amount.quantity !== undefined) throw new RiskServiceError('回购需要金额', 'invalid-amount');
            action.amount = amount.amount;
            if (draft.days !== undefined) action.days = draft.days;
          } else if (amount.quantity !== undefined) {
            if (type === 'buy' || type === 'sell') action.quantity = amount.quantity;
            else action.shares = amount.quantity;
          } else {
            action.amount = amount.amount;
          }
          notes.push(`${account.transactions.length > 1 ? `第${index + 1}笔：` : ''}${amount.note}`);
          return action;
        });
        return { ...account, notes, actions };
      });
      await onProgress?.('正在提交投前测算…');
      if (!state.draft.accounts) {
        const item = prepared[0]!;
        const result = await this.service.calculatePretrade(
          item.product,
          state.draft.transactions ? item.actions : item.actions[0]!,
          onProgress,
        );
        return handled('pretrade_calc', formatCalculation(result, item.notes.join('；'), item.actions.length));
      }
      const sections: string[] = [];
      let failures = 0;
      for (let index = 0; index < prepared.length; index++) {
        const item = prepared[index]!;
        await onProgress?.(`正在测算第${index + 1}/${prepared.length}个账户：${item.product}…`);
        try {
          const result = await this.service.calculatePretrade(item.product, item.actions, onProgress);
          if (result.status === 'error') failures += 1;
          sections.push(`## 账户${index + 1}：${item.product}\n\n${formatCalculation(result, item.notes.join('；'), item.actions.length)}`);
        } catch (error) {
          failures += 1;
          sections.push(`## 账户${index + 1}：${item.product}\n\n${formatRiskError(error)}`);
        }
      }
      const summary = failures
        ? `多个账户测算已完成：${prepared.length - failures}个成功，${failures}个失败；失败账户未影响其他账户继续测算。`
        : `多个账户测算已完成：${prepared.length}个账户均已返回结果。`;
      return handled('pretrade_calc', `${summary}\n\n${sections.join('\n\n---\n\n')}`);
    } catch (error) {
      return handled('risk-error', formatRiskError(error));
    }
  }

  private async loadProducts(): Promise<string[]> {
    const loaded = [...new Set(await this.service.listProducts())];
    if (loaded.length === 0) {
      throw new RiskServiceError('暂时无法获取存续产品列表，请稍后重试', 'products-unavailable');
    }
    return loaded;
  }

  private async execute(
    intent: RiskQueryIntent,
    products: readonly string[],
    onProgress?: (progress: string) => void,
  ): Promise<RiskRouteResult> {
    if (intent.kind === 'list_products') {
      return handled(
        intent.kind,
        `**可用产品（共 ${products.length} 个）**\n\n${products.slice(0, 50).map((item) => `- ${item}`).join('\n')}${products.length > 50 ? '\n- …' : ''}`,
      );
    }

    if (intent.kind === 'search_securities') {
      if (!intent.query) return handled(intent.kind, '请告诉我要搜索的证券名称或代码。');
      await onProgress?.('正在查询证券候选…');
      const options = await this.service.searchSecurities(intent.query);
      if (options.length === 0) return handled(intent.kind, `没有找到与「${intent.query}」相关的证券。`);
      return handled(
        intent.kind,
        `**「${intent.query}」匹配到以下证券**\n\n${options.slice(0, 10).map((item) => `- ${item.label}`).join('\n')}`,
      );
    }

    if ('productCandidates' in intent) {
      if (intent.productCandidates.length > 0 && !intent.product) {
        if (intent.productCandidates.length > 10) {
          return handled(
            intent.kind,
            `账户匹配到 ${intent.productCandidates.length} 个候选，数量过多。请补充更完整的产品名称后重新发送。`,
          );
        }
        const continuation: RiskQueryState = {
          kind: 'product',
          intent,
          options: intent.productCandidates,
        };
        return handled(
          intent.kind,
          selectionPrompt('账户', intent.productCandidates, 'letter'),
          productSelection(intent.productCandidates, this.selectionExpiry()),
          continuation,
        );
      }
      if (!intent.product) {
        return handled(
          intent.kind,
          '还差产品名。请回复存续产品的完整名称，或发送“有哪些产品”。',
          undefined,
          { kind: 'missing', intent },
        );
      }
    }

    if (intent.kind === 'check_security') {
      if (!intent.securityQuery) {
        return handled(
          intent.kind,
          '还差证券名称或代码，请直接回复证券名称或代码。',
          undefined,
          { kind: 'missing', intent },
        );
      }
      await onProgress?.('正在查询证券候选…');
      const options = await this.service.searchSecurities(intent.securityQuery);
      if (options.length === 0) {
        return handled(intent.kind, `没有找到与「${intent.securityQuery}」相关的证券，请提供更精确的名称或代码。`);
      }
      if (options.length > 10) {
        return handled(intent.kind, tooManySecurities(intent.securityQuery, options.length));
      }
      const exact = exactSecurityMatch(intent.securityQuery, options);
      if (exact) {
        await onProgress?.('正在检查证券禁投和关联方…');
        const data = await this.service.checkSecurity(intent.product ?? '', exact.code || exact.name);
        return handled(intent.kind, formatSecurityCheck(data));
      }
      const continuation: RiskQueryState = { kind: 'security', intent, options };
      if (options.length === 1) {
        return handled(
          intent.kind,
          `请确认证券：**${options[0]?.label}**\n\n回复“确认”或“1”开始检查；若不是，请直接发正确名称或代码。`,
          securitySelection(options, this.selectionExpiry(), true),
          continuation,
        );
      }
      return handled(
        intent.kind,
        selectionPrompt('证券', options.map((item) => item.label), 'number'),
        securitySelection(options, this.selectionExpiry()),
        continuation,
      );
    }

    if (intent.kind === 'check_counterparty') {
      if (!intent.counterparty) {
        return handled(
          intent.kind,
          '还差交易对手名称，请直接回复完整名称。',
          undefined,
          { kind: 'missing', intent },
        );
      }
      await onProgress?.('正在检查交易对手关联方状态…');
      const data = await this.service.checkCounterparty(intent.product ?? '', intent.counterparty);
      return handled(intent.kind, formatCounterpartyCheck(data));
    }

    if (intent.kind === 'query_holdings') {
      await onProgress?.('正在查询产品持仓…');
      return handled(intent.kind, formatHoldings(await this.service.getHoldings(intent.product ?? '')));
    }

    if (intent.kind === 'query_restrictions') {
      await onProgress?.('正在查询产品投资限制…');
      return handled(intent.kind, formatRestrictions(await this.service.getRestrictions(intent.product ?? '')));
    }

    if (intent.kind === 'query_credit') {
      if (!intent.entity) {
        return handled(
          intent.kind,
          '还差主体名称，例如“赣锋锂业 授信额度”。',
          undefined,
          { kind: 'missing', intent },
        );
      }
      await onProgress?.('正在查询主体授信额度…');
      return handled(intent.kind, formatCredit(await this.service.getCredit(intent.entity)));
    }

    return { handled: false };
  }

  private selectionExpiry(): number {
    return this.now() + this.selectionTtlMs;
  }
}

function handled(
  intent: string,
  markdown: string,
  selection?: RiskSelectionRequest,
  continuation?: RiskQueryState,
): RiskRouteResult {
  return {
    handled: true,
    intent,
    markdown,
    ...(selection ? { selection } : {}),
    ...(continuation ? { continuation } : {}),
  };
}

function selectionPrompt(
  label: string,
  options: readonly string[],
  keyStyle: 'letter' | 'number',
): string {
  if (options.length === 0) return `没有可选择的${label}候选。`;
  const lines = options.map((item, index) => {
    const key = keyStyle === 'letter' ? String.fromCharCode(97 + index) : String(index + 1);
    return `${key}. ${item}`;
  });
  const hint = keyStyle === 'letter' ? '回复字母序号。' : '回复数字序号。';
  return `**请选择${label}**\n\n${lines.join('\n')}\n\n${hint}`;
}

function selectionIndex(text: string, length: number): number | undefined {
  const match = /^\s*(\d+)\s*[。.]?\s*$/.exec(text);
  if (!match) return undefined;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 && index < length ? index : undefined;
}

function productSelectionIndex(text: string, length: number): number | undefined {
  if (length === 1 && /^\s*(?:确认|是|对|没错)\s*[!！.。。]?\s*$/.test(text)) return 0;
  const letter = /^\s*([a-z])\s*[。.]?\s*$/i.exec(text);
  if (letter?.[1]) {
    const index = letter[1].toLowerCase().charCodeAt(0) - 97;
    return index >= 0 && index < length ? index : undefined;
  }
  return selectionIndex(text, length);
}

function productSelection(options: readonly string[], expiresAt: number): RiskSelectionRequest {
  return {
    kind: 'product',
    title: '请选择账户',
    subTitle: `账户匹配到 ${options.length} 个候选`,
    replyHint: options.length === 1 ? '点击确认，也可回复“确认”' : '点击选择，也可回复字母序号',
    options: options.map((label, index) => ({
      key: String.fromCharCode(97 + index),
      label,
    })),
    expiresAt,
  };
}

function securitySelection(
  options: readonly RiskSecuritySuggestion[],
  expiresAt: number,
  confirm = false,
): RiskSelectionRequest {
  return {
    kind: 'security',
    title: confirm ? '请确认证券' : '请选择证券',
    subTitle: confirm ? '请确认以下候选证券' : `匹配到 ${options.length} 个候选证券`,
    replyHint: confirm ? '点击确认，也可回复“确认”或“1”' : '点击选择，也可回复数字序号',
    options: options.map((item, index) => ({
      key: String(index + 1),
      label: item.label,
    })),
    expiresAt,
  };
}

function securityDisplay(security: RiskSecuritySuggestion): string {
  return security.code ? `${security.name}（${security.code}）` : security.name;
}

function tooManySecurities(query: string, count: number): string {
  return `「${query}」匹配到 ${count} 个候选，数量过多无法一一列出。\n\n请补充更精确的证券名称或完整代码后重新发送。`;
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

function riskHelp(prefix: string): string {
  return [prefix, '', ...WECOM_RISK_USAGE_LINES].join('\n');
}

function formatRiskError(error: unknown): string {
  if (error instanceof RiskServiceError) {
    if (error.code === 'invalid-amount') {
      return '⚠️ **交易规模无效**：请重新输入正确的金额或数量（含单位）；本次未执行测算。';
    }
    if (error.code === 'invalid-days') {
      return '⚠️ **期限无效**：请输入大于 0 的整数天数；本次未执行测算。';
    }
    if (error.code === 'unresolved-transaction') {
      return '⚠️ **交易信息尚未核验**：请重新确认账户、证券和交易信息；本次未执行测算。';
    }
    if (error.code === 'intranet-unavailable') {
      return '⚠️ **内网数据不可得**：当前无法连接公司内网，请先连接内网后重试；本次未查询 JYDB/PQ。';
    }
    return '⚠️ **风险查询失败**：暂时无法完成查询，请稍后重试。';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout/i.test(message)) return '⚠️ **风险查询超时**：请稍后重试。';
  return '⚠️ **风险查询失败**：暂时无法完成查询，请稍后重试。';
}
