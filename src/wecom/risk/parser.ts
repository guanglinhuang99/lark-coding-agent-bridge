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
      market: 'primary' | 'secondary';
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
const PRODUCT_FUZZY_MATCH_THRESHOLD = 0.7;
const PRODUCT_BOUNDARY_RE =
  /逆回购|回购|申购|认购|赎回|买入|卖出|能不能买|是否能买|可以买|买|卖|交易对手|对手方|关联方|持仓|仓位|投资限制|投资范围|比例限制|限制规则|禁投|超限|限额|授信|信用额度/;
const PRODUCT_SEPARATOR_RE = /[\s\u3000,，.。·、_\-—:：;；()（）【】\[\]"'“”‘’]/g;
const CHINESE_NUMERAL_RE = /[零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟萬]+/g;

export function isRiskCandidate(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/有哪些?(?:产品|组合)|产品列表|列出.*产品/.test(value)) return true;
  if (/搜.*(?:证券|债券|股票)|(?:证券|债券|股票).*搜/.test(value)) return true;
  if (/(?:能不能买|是否能买|可以买吗|可不可以买|会不会禁投|是否禁投)/.test(value)) {
    return /(?:安联|产品|资产管理|资管|账户|证券|债券|股票|国债|基金)/.test(value);
  }
  if (/禁投|超限|限额|关联方|交易对手|对手方|授信|信用额度/.test(value)) return true;
  if (/持仓|仓位|投资限制|投资范围|比例限制|限制规则/.test(value)) return true;
  if (findAction(value) && (/(?:安联|产品|资产管理)/.test(value) || extractAmount(value))) {
    return true;
  }
  return false;
}

export function parseRiskMessage(text: string, products: readonly string[]): RiskIntent {
  const value = text.trim();
  const productMatch = matchProductCandidates(value, products);
  const productCandidates = productMatch.products;
  const product =
    productCandidates.length === 1 && !productMatch.fuzzy ? productCandidates[0] : undefined;

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
      market: detectMarket(value),
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
  return matchProductCandidates(text, products).products;
}

export function matchProductCandidates(
  text: string,
  products: readonly string[],
): { products: string[]; fuzzy: boolean } {
  const normalizedText = normalizeProductText(text);
  const fragments = productMatchFragments(text);
  const hits = new Map<string, number>();
  for (const product of products) {
    for (const alias of normalizedProductAliases(product)) {
      if (alias.length < 2) continue;
      if (normalizedText.includes(alias)) {
        hits.set(product, Math.max(hits.get(product) ?? 0, alias.length));
        continue;
      }
      for (const fragment of fragments) {
        if (fragment.length >= 3 && alias.includes(fragment)) {
          hits.set(product, Math.max(hits.get(product) ?? 0, fragment.length));
        }
      }
    }
  }
  if (hits.size > 0) {
    const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
    const bestScore = ranked[0]?.[1];
    return {
      products: ranked.filter(([, score]) => score === bestScore).map(([name]) => name),
      fuzzy: false,
    };
  }

  const fuzzyHits: Array<[string, number]> = [];
  for (const product of products) {
    let score = 0;
    for (const alias of normalizedProductAliases(product)) {
      for (const fragment of fragments) {
        if (fragment.length < 3) continue;
        score = Math.max(score, productSimilarity(fragment, alias));
      }
    }
    if (score >= PRODUCT_FUZZY_MATCH_THRESHOLD) fuzzyHits.push([product, score]);
  }
  return {
    products: fuzzyHits.sort((a, b) => b[1] - a[1]).map(([name]) => name),
    fuzzy: fuzzyHits.length > 0,
  };
}

export function detectMarket(text: string): 'primary' | 'secondary' {
  return /一级(?:市场)?/.test(text) ? 'primary' : 'secondary';
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

function normalizedProductAliases(product: string): string[] {
  return [...new Set(productAliases(product).map(normalizeProductText).filter(Boolean))];
}

function normalizeProductText(text: string): string {
  return normalizeChineseNumerals(
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(PRODUCT_SEPARATOR_RE, '')
      .replace(/^安联(?:资产管理|资管)?/, '')
      .replace(/资产管理产品$/, ''),
  );
}

function productMatchFragments(text: string): string[] {
  const values = [text];
  const boundary = PRODUCT_BOUNDARY_RE.exec(text);
  if (boundary?.index) values.push(text.slice(0, boundary.index));
  for (const part of text.split(/[，,。；;！？!?]/)) values.push(part);
  return [...new Set(values.map(normalizeProductText).filter(Boolean))];
}

function normalizeChineseNumerals(value: string): string {
  return value.replace(CHINESE_NUMERAL_RE, (token) => {
    const parsed = parseChineseNumeral(token);
    return parsed === undefined ? token : String(parsed);
  });
}

function parseChineseNumeral(token: string): number | undefined {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    壹: 1,
    二: 2,
    两: 2,
    贰: 2,
    三: 3,
    叁: 3,
    四: 4,
    肆: 4,
    五: 5,
    伍: 5,
    六: 6,
    陆: 6,
    七: 7,
    柒: 7,
    八: 8,
    捌: 8,
    九: 9,
    玖: 9,
  };
  const units: Record<string, number> = {
    十: 10,
    拾: 10,
    百: 100,
    佰: 100,
    千: 1_000,
    仟: 1_000,
    万: 10_000,
    萬: 10_000,
  };
  if (![...token].some((char) => units[char] !== undefined)) {
    const chars = [...token];
    if (chars.some((char) => digits[char] === undefined)) return undefined;
    return Number(chars.map((char) => digits[char]).join(''));
  }

  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of token) {
    if (digits[char] !== undefined) {
      digit = digits[char];
      continue;
    }
    const unit = units[char];
    if (!unit) return undefined;
    if (unit === 10_000) {
      total += (section + digit || 1) * unit;
      section = 0;
      digit = 0;
    } else {
      section += (digit || 1) * unit;
      digit = 0;
    }
  }
  return total + section + digit;
}

function productSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftChars = [...left];
  const rightChars = [...right];
  const previous = Array.from({ length: rightChars.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= leftChars.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= rightChars.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? rightIndex;
      const next = Math.min(
        above + 1,
        (previous[rightIndex - 1] ?? leftIndex) + 1,
        diagonal + (leftChars[leftIndex - 1] === rightChars[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
      previous[rightIndex] = next;
    }
  }
  return 1 - (previous[rightChars.length] ?? 0) / Math.max(leftChars.length, rightChars.length);
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
    .replace(/^(?:请)?(?:帮我)?(?:查|看|核查|检查|查询)\s*(?:一下)?\s*/, '')
    .replace(/能不能买|是否能买|可以买吗|会不会禁投|是否禁投|禁投证券|关联方证券/g, '')
    .replace(/禁投|关联方|证券|债券|股票|检查|核查|查询|查|会不会|是否|违规|问题/g, '')
    .replace(/买入|买/g, '')
    .replace(/[吗么]\s*[?？。！!]*$/, '')
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
    .replace(/一级市场|二级市场|一级|二级/g, '')
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
  const boundary = PRODUCT_BOUNDARY_RE.exec(value);
  if (boundary?.index && matchProducts(value.slice(0, boundary.index), products).length > 0) {
    value = value.slice(boundary.index);
  }
  return value.trim();
}

function extractDays(text: string): number | undefined {
  const match = /(\d+)\s*天/.exec(text);
  if (!match) return undefined;
  const days = Number(match[1]);
  return Number.isFinite(days) && days > 0 ? days : undefined;
}
