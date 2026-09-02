export type RiskActionType =
  | 'subscription'
  | 'redemption'
  | 'buy'
  | 'sell'
  | 'repo'
  | 'reverse_repo';

export interface ParsedAmount {
  amount?: number;
  quantity?: number;
  note: string;
  source: string;
}

export type RiskIntent =
  | { kind: 'list_products' }
  | { kind: 'search_securities'; query: string }
  | { kind: 'check_security'; product?: string; productCandidates: string[]; securityQuery: string }
  | {
      kind: 'check_counterparty';
      product?: string;
      productCandidates: string[];
      counterparty: string;
    }
  | { kind: 'query_holdings'; product?: string; productCandidates: string[] }
  | { kind: 'query_restrictions'; product?: string; productCandidates: string[] }
  | { kind: 'query_credit'; entity: string }
  | {
      kind: 'pretrade_calc';
      product?: string;
      productCandidates: string[];
      action?: RiskActionType;
      amount?: number;
      quantity?: number;
      amountNote?: string;
      securityQuery?: string;
      days?: number;
      missing: string[];
    }
  | { kind: 'unknown' };

const ACTION_PATTERNS: ReadonlyArray<[RegExp, RiskActionType]> = [
  [/逆回购/, 'reverse_repo'],
  [/回购/, 'repo'],
  [/申购|认购/, 'subscription'],
  [/赎回/, 'redemption'],
  [/买入|买(?!卖)/, 'buy'],
  [/卖出|卖(?!出)/, 'sell'],
];

const EXPLICIT_AMOUNT_RE = /(\d+(?:\.\d+)?)\s*(亿|万|元|块|股|手|张|份)/;
const UNITLESS_AFTER_ACTION_RE =
  /(?:逆回购|回购|申购|认购|赎回|买入|卖出|买|卖)\s*(\d+(?:\.\d+)?)(?![0-9A-Za-z.-])(?!\s*(?:亿|万|元|块|股|手|张|份|天|年|月|日|号|%))/;
const UNITLESS_TRAILING_RE = /(?:^|\s)(\d+(?:\.\d+)?)\s*$/;

export function isRiskCandidate(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/有哪些?(?:产品|组合)|产品列表|列出.*产品/.test(value)) return true;
  if (/搜.*(?:证券|债券|股票)|(?:证券|债券|股票).*搜/.test(value)) return true;
  if (/禁投|超限|限额|关联方|交易对手|对手方|授信|信用额度/.test(value)) return true;
  if (/持仓|仓位|投资限制|投资范围|比例限制|限制规则/.test(value)) return true;
  if (findAction(value) && (/(?:安联|产品|资产管理)/.test(value) || extractAmount(value))) {
    return true;
  }
  return false;
}

export function parseRiskMessage(text: string, products: readonly string[]): RiskIntent {
  const value = text.trim();
  const productCandidates = matchProducts(value, products);
  const product = productCandidates.length === 1 ? productCandidates[0] : undefined;

  if (/有哪些?(?:产品|组合)|产品列表|列出.*产品/.test(value)) {
    return { kind: 'list_products' };
  }

  if (/搜.*(?:证券|债券|股票)|(?:证券|债券|股票).*搜/.test(value)) {
    return { kind: 'search_securities', query: extractSearchQuery(value) };
  }

  if (/交易对手|对手方|关联方/.test(value) && !findAction(value)) {
    return {
      kind: 'check_counterparty',
      product,
      productCandidates,
      counterparty: extractCounterparty(value, productCandidates),
    };
  }

  if (/持仓|仓位|持有/.test(value) && !findAction(value)) {
    return { kind: 'query_holdings', product, productCandidates };
  }

  if (/投资限制|投资范围|投资比例|比例限制|限制规则/.test(value) && !findAction(value)) {
    return { kind: 'query_restrictions', product, productCandidates };
  }

  if (/授信|信用额度/.test(value) && !findAction(value)) {
    return { kind: 'query_credit', entity: extractCreditEntity(value) };
  }

  if (/禁投|能不能买|是否能买|会不会禁|关联方证券/.test(value)) {
    return {
      kind: 'check_security',
      product,
      productCandidates,
      securityQuery: extractSecurityQuery(value, productCandidates),
    };
  }

  const action = findAction(value);
  const parsedAmount = extractAmount(value);
  if (action || (product && parsedAmount)) {
    const securityQuery =
      action === 'buy' || action === 'sell'
        ? extractTradeSecurity(value, productCandidates, parsedAmount?.source)
        : undefined;
    const missing: string[] = [];
    if (!product && productCandidates.length === 0) missing.push('产品名');
    if (!action) missing.push('动作（申购/赎回/买入/卖出/回购）');
    if (!parsedAmount) missing.push(action === 'repo' || action === 'reverse_repo' ? '金额' : '金额或数量');
    if ((action === 'buy' || action === 'sell') && !securityQuery) missing.push('证券名称或代码');
    return {
      kind: 'pretrade_calc',
      product,
      productCandidates,
      action,
      amount: parsedAmount?.amount,
      quantity: parsedAmount?.quantity,
      amountNote: parsedAmount?.note,
      securityQuery,
      days: extractDays(value),
      missing,
    };
  }

  if (/超限|限额|违规|会不会/.test(value)) {
    return {
      kind: 'check_security',
      product,
      productCandidates,
      securityQuery: extractSecurityQuery(value, productCandidates),
    };
  }

  return { kind: 'unknown' };
}

export function matchProducts(text: string, products: readonly string[]): string[] {
  const hits = new Map<string, number>();
  for (const product of products) {
    for (const alias of productAliases(product)) {
      if (alias.length >= 2 && text.includes(alias)) {
        hits.set(product, Math.max(hits.get(product) ?? 0, alias.length));
      }
    }
  }
  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  const bestScore = ranked[0]?.[1];
  if (bestScore === undefined) return [];
  return ranked.filter(([, score]) => score === bestScore).map(([name]) => name);
}

export function findAction(text: string): RiskActionType | undefined {
  for (const [pattern, action] of ACTION_PATTERNS) {
    if (pattern.test(text)) return action;
  }
  return undefined;
}

export function extractAmount(text: string): ParsedAmount | undefined {
  const explicit = EXPLICIT_AMOUNT_RE.exec(text);
  if (explicit) {
    const value = Number(explicit[1]);
    const unit = explicit[2];
    if (!Number.isFinite(value) || !unit) return undefined;
    if (unit === '亿') return { amount: value, note: `${value} 亿元`, source: explicit[0] };
    if (unit === '万') {
      return { amount: value / 10_000, note: `${value} 万元 ≈ ${value / 10_000} 亿元`, source: explicit[0] };
    }
    if (unit === '元' || unit === '块') {
      return { amount: value / 1e8, note: `${value} 元 ≈ ${value / 1e8} 亿元`, source: explicit[0] };
    }
    return { quantity: value, note: `${value} ${unit}`, source: explicit[0] };
  }

  const unitless = UNITLESS_AFTER_ACTION_RE.exec(text) ?? UNITLESS_TRAILING_RE.exec(text);
  if (!unitless) return undefined;
  const value = Number(unitless[1]);
  if (!Number.isFinite(value)) return undefined;
  return {
    amount: value,
    note: `${value} 亿元（未写单位，按亿元）`,
    source: unitless[1] ?? '',
  };
}

function productAliases(product: string): string[] {
  const aliases = new Set([product]);
  if (product.endsWith('资产管理产品')) aliases.add(product.slice(0, -'资产管理产品'.length));
  aliases.add(product.replace(/^安联/, '').replace(/资产管理产品$/, ''));
  return [...aliases].filter(Boolean);
}

function extractSearchQuery(text: string): string {
  return text
    .replace(/^(?:请)?(?:帮我)?(?:搜|查|找)\s*(?:一下)?\s*/, '')
    .replace(/^(?:证券|债券|股票|代码)\s*/, '')
    .trim();
}

function extractCounterparty(text: string, products: readonly string[]): string {
  return stripProducts(text, products)
    .replace(/交易对手|对手方|关联方|核查|检查|查询|查|会不会|是否|有没有|问题/g, '')
    .trim();
}

function extractCreditEntity(text: string): string {
  return text.replace(/授信额度|信用额度|授信|信用|查询|查|多少|还有|剩余|的/g, '').trim();
}

function extractSecurityQuery(text: string, products: readonly string[]): string {
  return stripProducts(text, products)
    .replace(/能不能买|是否能买|可以买吗|会不会禁投|是否禁投|禁投证券|关联方证券/g, '')
    .replace(/禁投|关联方|证券|债券|股票|检查|核查|查询|查|会不会|是否|违规|问题/g, '')
    .replace(/买入|买/g, '')
    .trim();
}

function extractTradeSecurity(
  text: string,
  products: readonly string[],
  amountSource: string | undefined,
): string {
  let value = stripProducts(text, products);
  if (amountSource) value = value.replace(amountSource, '');
  value = value
    .replace(/逆回购|回购|申购|认购|赎回|买入|卖出|买|卖/g, '')
    .replace(/会不会超限|是否超限|超限|限额|测算|帮我|请/g, '')
    .replace(/\d+\s*天/g, '')
    .trim();
  return value;
}

function stripProducts(text: string, products: readonly string[]): string {
  let value = text;
  for (const product of products) {
    for (const alias of productAliases(product).sort((a, b) => b.length - a.length)) {
      value = value.replace(alias, '');
    }
  }
  return value.trim();
}

function extractDays(text: string): number | undefined {
  const match = /(\d+)\s*天/.exec(text);
  if (!match) return undefined;
  const days = Number(match[1]);
  return Number.isFinite(days) && days > 0 ? days : undefined;
}
