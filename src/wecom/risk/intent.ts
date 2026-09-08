import type { RiskSecuritySuggestion, RiskService } from './client';
import {
  detectMarket,
  extractAmount,
  extractDays,
  findAction,
  matchProductCandidates,
  parseRiskMessage,
  type RiskActionType,
} from './parser';
import type { RiskSelectionRequest } from './router';

export interface RiskTransactionDraft {
  action?: RiskActionType;
  securityQuery?: string;
  amountText?: string;
  days?: number;
  market: 'primary' | 'secondary';
  tenorText?: string;
  yieldText?: string;
  sourceText?: string;
  /** Only populated after master-data lookup or a validated user selection. */
  resolvedSecurity?: RiskSecuritySuggestion;
}

export interface RiskAiDraft extends RiskTransactionDraft {
  accountQuery: string;
  tradeDateText?: string;
  transactions?: RiskTransactionDraft[];
}

type CompleteRiskAiDraft = RiskAiDraft & {
  action: RiskActionType;
  amountText: string;
};

export type RiskIntentState = { transactionIndex?: number } & (
  | { stage: 'account'; originalText: string; draft: RiskAiDraft; products: string[] }
  | { stage: 'security'; originalText: string; draft: RiskAiDraft; product: string; securities: RiskSecuritySuggestion[] }
  | { stage: 'confirm'; originalText: string; draft: CompleteRiskAiDraft; product: string; security?: RiskSecuritySuggestion }
  | { stage: 'freeform'; originalText: string; draft: RiskAiDraft; field: 'account' | 'security' | 'amount' | 'market' | 'other'; product?: string; security?: RiskSecuritySuggestion });


/** Strict command grammar: free prose, multiple actions and omitted fields use AI. */
export function parseDirectRiskDraft(text: string, products: readonly string[]): RiskAiDraft | undefined {
  const match = /^(.+?)\s+(?:(一级(?:市场)?|二级(?:市场)?)\s+)?(买入|买|卖出|卖|申购|认购|赎回|正回购|回购|逆回购)\s+(\d+(?:\.\d+)?(?:亿元|万元|亿|万|元|块|股|手|张|份)?)(?:\s+(\S+))?(?:\s+(\d+)天)?$/.exec(text.trim());
  if (!match) return undefined;
  const [, account, market, verb, amountText, tail, extraDays] = match;
  const product = matchProductCandidates(account!, products);
  if (product.fuzzy || product.products.length !== 1) return undefined;
  const selected = product.products[0]!;
  const normalized = (value: string) => value.normalize('NFKC').replace(/\s/g, '').toLowerCase();
  const aliases = [selected, selected.replace(/资产管理产品$/, ''), selected.replace(/^安联/, '').replace(/资产管理产品$/, '')];
  if (!aliases.some(alias => normalized(alias) === normalized(account!))) return undefined;
  const action = findAction(verb!);
  const amount = extractAmount(amountText!);
  if (!action || !amount || (amount.amount ?? amount.quantity ?? 0) <= 0) return undefined;
  const primary = market?.startsWith('一级') ?? false;
  const securityNeeded = action === 'buy' || action === 'sell' || (primary && action === 'subscription');
  let securityQuery: string | undefined;
  let days: number | undefined;
  if (securityNeeded) {
    // Codes are unambiguous syntax, but still resolve through master data.
    if (!tail || !/^[0-9]{6,12}\.(?:SH|SZ|IB)$/i.test(tail) || extraDays) return undefined;
    securityQuery = tail.toUpperCase();
  } else if (action === 'repo' || action === 'reverse_repo') {
    if (amount.quantity !== undefined || extraDays || (tail && !/^[1-9]\d*天$/.test(tail))) return undefined;
    days = tail ? Number(tail.slice(0, -1)) : undefined;
  } else if (tail || extraDays) return undefined;
  return {
    accountQuery: product.products[0]!, action, amountText: amountText!,
    market: primary ? 'primary' : 'secondary',
    ...(securityQuery ? { securityQuery } : {}),
    ...(days !== undefined ? { days } : {}),
  };
}

/** Shared by the real message entry and the benchmark; always returns a confirmation state. */
export async function resolveInitialRiskIntent(
  text: string,
  service: RiskService,
  analyze: () => Promise<RiskAiDraft>,
): Promise<RiskIntentState> {
  // Product lookup is shared with normalization and other queries by the client.
  const products = await service.listProducts();
  const direct = parseDirectRiskDraft(text, products);
  const draft = direct ?? await analyze();
  assertInitialTransactionCoverage(text, draft);
  return normalizeRiskDraft(text, draft, service, products);
}

/** Only a fully matched, single-field edit may bypass AI and master-data lookup. */
export function applySimpleRiskCorrection(
  state: Extract<RiskIntentState, { stage: 'confirm' }>,
  text: string,
): RiskIntentState | undefined {
  const value = text.trim();
  if (state.draft.transactions) {
    const target = transactionCorrection(value, state.draft.transactions.length);
    if (!target) return undefined;
    const transaction = state.draft.transactions[target.index]!;
    if (!transaction.action || !transaction.amountText) return undefined;
    const updated = applySimpleRiskCorrection({
      ...state, draft: { ...transaction, accountQuery: state.draft.accountQuery,
        action: transaction.action, amountText: transaction.amountText },
      security: transaction.resolvedSecurity,
    }, target.text);
    if (!updated || updated.stage !== 'confirm') return undefined;
    return { ...state, draft: { ...state.draft, transactions: state.draft.transactions.map(
      (item, i) => i === target.index ? { ...item, amountText: updated.draft.amountText, days: updated.draft.days } : item,
    ) } };
  }
  const amountMatch = /^(?:金额|规模|数量)\s*(?:改成|改为|调整为|设为)\s*(\d+(?:\.\d+)?(?:亿元|万元|亿|万|元|块|股|手|张|份|w|W)?)\s*[。！!]?$/u.exec(value);
  if (amountMatch) {
    const amount = confirmedRiskAmount(amountMatch[1]!);
    if (!amount || (amount.amount ?? amount.quantity ?? 0) <= 0) return undefined;
    if ((state.draft.action === 'repo' || state.draft.action === 'reverse_repo') && amount.quantity !== undefined) return undefined;
    return { ...state, draft: { ...state.draft, amountText: amountMatch[1]! } };
  }
  const daysMatch = /^(?:期限|天数)\s*(?:改成|改为|调整为|设为)\s*([1-9]\d*)天\s*[。！!]?$/u.exec(value);
  if (daysMatch && (state.draft.action === 'repo' || state.draft.action === 'reverse_repo')) {
    return { ...state, draft: { ...state.draft, days: Number(daysMatch[1]) } };
  }
  return undefined;
}

export function isPretradeIntentCandidate(text: string): boolean {
  if (/能不能买|是否能买|可以买吗|可不可以买|禁投|关联方证券/.test(text)) return false;
  if (!findAction(text) && !/拟投资/.test(text)) return false;
  return (
    /(?:安联|产品|资产管理|资管|账户|证券|债券|股票|国债|基金|回购|一级|二级)/.test(text) ||
    /(?:金额|数量|\d+(?:\.\d+)?\s*(?:亿|万|元|块|股|手|张|份))/.test(text) ||
    extractAmount(text) !== undefined
  );
}

/** A pending confirmation must treat explicit edit language as a revision. */
export function isRiskIntentCorrection(text: string): boolean {
  return /(?:改成|改为|修改|调整|换成|替换|设为|改回|变更为)/.test(text.trim());
}

export class RiskIntentStateRegistry {
  private readonly states = new Map<string, RiskIntentState>();
  private readonly stateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly taskStates = new Map<
    string,
    { conversationKey: string; state: RiskIntentState }
  >();
  private readonly taskTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  get(conversationKey: string): RiskIntentState | undefined {
    return this.states.get(conversationKey);
  }

  has(conversationKey: string): boolean {
    return this.states.has(conversationKey);
  }

  set(conversationKey: string, state: RiskIntentState): void {
    this.delete(conversationKey);
    this.states.set(conversationKey, state);
    const timer = setTimeout(() => {
      if (this.states.get(conversationKey) === state) this.delete(conversationKey);
    }, this.ttlMs);
    timer.unref?.();
    this.stateTimers.set(conversationKey, timer);
  }

  delete(conversationKey: string): void {
    const timer = this.stateTimers.get(conversationKey);
    if (timer) clearTimeout(timer);
    this.stateTimers.delete(conversationKey);
    this.states.delete(conversationKey);
  }

  registerTask(
    taskId: string,
    conversationKey: string,
    state: RiskIntentState,
    expiresAt: number,
  ): void {
    this.deleteTask(taskId);
    this.clearTasksForConversation(conversationKey);
    this.taskStates.set(taskId, { conversationKey, state });
    const timer = setTimeout(() => this.deleteTask(taskId), Math.max(0, expiresAt - this.now()));
    timer.unref?.();
    this.taskTimers.set(taskId, timer);
  }

  getTask(taskId: string): RiskIntentState | undefined {
    return this.taskStates.get(taskId)?.state;
  }

  deleteTask(taskId: string): void {
    const timer = this.taskTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.taskTimers.delete(taskId);
    this.taskStates.delete(taskId);
  }

  clearTasksForConversation(conversationKey: string): void {
    for (const [taskId, task] of this.taskStates) {
      if (task.conversationKey === conversationKey) this.deleteTask(taskId);
    }
  }

  clearConversation(conversationKey: string): void {
    this.delete(conversationKey);
    this.clearTasksForConversation(conversationKey);
  }
}

export function buildRiskIntentPrompt(userText: string, previous?: RiskAiDraft, correction?: string): string {
  return [
    '你是保险资管交易意图解析器。只抽取关键词，不调用工具、不判断限额、不猜标准账户名或证券代码。',
    '只输出 JSON，不要 Markdown。',
    '单笔字段：account_query, action, security_query, amount_text, days, trade_date_text, tenor_text, yield_text。',
    '同一账户多笔交易必须输出 {account_query, trade_date_text, transactions:[{action,security_query,amount_text,days,tenor_text,yield_text,source_text},...]}，按原文顺序完整列出每一笔，不得只取第一笔或合并金额。',
    '列表中“拟投资以下信用债”表示逐笔买入。账户只抽取例如“ESG1号”，去除Markdown和括号；同一账户共享给全部交易。证券有代码时优先原样提取代码。',
    '1000w/1000W 表示1000万元；amount_text仍保留原文。期限3.93Y、3.69Y+5Y(休1)放tenor_text，收益率1.76、1.7125行权放yield_text，均不得当成价格、金额或回购days。',
    'trade_date_text保留拟交易日期原文，如“明天（9.9）”，不得猜测年份。信评已发起和请同事确认是备注，不是审批通过或执行确认。',
    '修改多笔草稿时保留未修改的交易和顺序；必须有明确第几笔才能修改该笔字段，不得把一笔金额覆盖全部交易。',
    'action 只能是 subscription/redemption/buy/sell/repo/reverse_repo。',
    'account_query 保留用户描述投资账户/资管产品的关键词；security_query 保留用户描述交易标的的关键词。',
    'security_query 不得包含 account_query 中的账户或资管产品名称。',
    'amount_text 保留原始金额/数量及单位。buy/sell 必须提取 security_query。',
    '不要输出 market；多笔的source_text必须逐字复制对应交易行，不得把共享标题补写进交易行（保留该行自身的一级/二级说明），程序据此和列表前的共享市场说明确定市场。明确出现“一级”才是一级，否则默认二级；“二级资本债”是债券类型，不代表市场。',
    '一级申购/认购债券仍须提取每只证券，不能当成账户资金申购。一级买入使用buy，一级申购使用subscription。',
    ...(previous ? [`上次结果：${JSON.stringify(previous)}`] : []),
    ...(correction ? [`用户修正：${JSON.stringify(correction)}`] : []),
    `用户原话：${JSON.stringify(userText)}`,
  ].join('\n');
}

export function parseRiskIntentOutput(raw: string, originalText: string): CompleteRiskAiDraft {
  const draft = parseRiskIntentOutputPartial(raw, originalText);
  if (draft.transactions) {
    const missing = draft.transactions.flatMap((item, i) => [
      ...(!item.action ? [`第${i + 1}笔交易动作`] : []),
      ...(!item.amountText ? [`第${i + 1}笔金额/数量`] : []),
      ...(needsSecurity(item) && !item.securityQuery ? [`第${i + 1}笔交易标的`] : []),
    ]);
    if (!draft.accountQuery) missing.unshift('账户');
    if (missing.length) throw new RiskIntentClarificationError(missing);
    return draft as CompleteRiskAiDraft;
  }
  const missing = [
    ...(!draft.accountQuery ? ['账户'] : []),
    ...(!draft.action ? ['交易动作'] : []),
    ...(!draft.amountText ? ['金额/数量'] : []),
    ...(needsSecurity(draft) && !draft.securityQuery ? ['交易标的'] : []),
  ];
  if (missing.length) throw new RiskIntentClarificationError(missing);
  return draft as CompleteRiskAiDraft;
}

export function parseRiskIntentOutputPartial(raw: string, originalText: string): RiskAiDraft {
  const value = jsonObject(raw);
  const accountQuery = str(value.account_query) || inferAccountQuery(originalText);
  if ('transactions' in value) {
    if (!Array.isArray(value.transactions) || !value.transactions.length) {
      throw new RiskIntentClarificationError(['交易列表不能为空']);
    }
    const transactions = value.transactions.map((item): RiskTransactionDraft => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('交易列表格式错误');
      const row = item as Record<string, unknown>;
      const securityQuery = securityQueryValue(row.security_query);
      const sourceText = transactionSource(originalText, str(row.source_text), securityQuery);
      return {
        action: actionValue(row.action), securityQuery: securityQuery || undefined,
        amountText: str(row.amount_text) || undefined, days: num(row.days),
        market: transactionMarket(originalText, sourceText, securityQuery),
        sourceText: sourceText || undefined,
        tenorText: str(row.tenor_text) || undefined, yieldText: str(row.yield_text) || undefined,
      };
    });
    return { ...transactions[0]!, accountQuery, transactions, tradeDateText: str(value.trade_date_text) || undefined };
  }
  const action = findAction(originalText) ?? actionValue(value.action);
  const securityQuery = securityQueryValue(value.security_query);
  const amountText = str(value.amount_text) || extractAmount(originalText)?.source;
  const days = extractDays(originalText) ?? num(value.days);
  const market = detectMarket(originalText);
  return {
    accountQuery,
    ...(str(value.trade_date_text) ? { tradeDateText: str(value.trade_date_text) } : {}),
    ...(str(value.tenor_text) ? { tenorText: str(value.tenor_text) } : {}),
    ...(str(value.yield_text) ? { yieldText: str(value.yield_text) } : {}),
    ...(action ? { action } : {}),
    ...(securityQuery ? { securityQuery } : {}),
    ...(amountText ? { amountText } : {}),
    ...(days !== undefined ? { days } : {}),
    market,
  };
}

export class RiskIntentClarificationError extends Error {
  constructor(readonly missing: string[]) {
    super(`缺少：${missing.join('、')}`);
    this.name = 'RiskIntentClarificationError';
  }
}

export async function normalizeRiskDraft(originalText: string, draft: RiskAiDraft, service: RiskService, knownProducts?: string[]): Promise<RiskIntentState> {
  const products = knownProducts ?? await service.listProducts();
  const productMatch = matchProductCandidates(draft.accountQuery, products);
  const matched = productMatch.products;
  if (productMatch.fuzzy || matched.length !== 1) {
    return { stage: 'account', originalText, draft, products: matched.slice(0, 9) };
  }
  const product = matched[0]!;
  return normalizeSecurity(
    originalText,
    removeProductFromSecurityQuery(originalText, draft, products, product),
    product,
    service,
  );
}

export async function normalizeSecurity(originalText: string, draft: RiskAiDraft, product: string, service: RiskService): Promise<RiskIntentState> {
  if (draft.transactions) {
    if (!draft.transactions.length) throw new Error('交易列表不能为空');
    const transactions = draft.transactions.map(item => ({ ...item }));
    for (let index = 0; index < transactions.length; index++) {
      const item = transactions[index]!;
      const leaf = { ...item, accountQuery: draft.accountQuery };
      const state = item.resolvedSecurity
        ? completeOrMissing(originalText, leaf, product, item.resolvedSecurity)
        : await normalizeSecurity(originalText, leaf, product, service);
      if (state.stage !== 'confirm') return { ...state, draft: { ...draft, transactions }, transactionIndex: index };
      if (!confirmedRiskAmount(item.amountText ?? '')) return {
        stage: 'freeform', field: 'amount', originalText, product,
        draft: { ...draft, transactions }, transactionIndex: index,
      };
      transactions[index] = { ...item, resolvedSecurity: state.security };
    }
    const first = transactions[0]!;
    return { stage: 'confirm', originalText, product,
      draft: { ...draft, action: first.action!, amountText: first.amountText!, transactions } };
  }
  if (!needsSecurity(draft)) return completeOrMissing(originalText, draft, product);
  if (!draft.securityQuery?.trim()) {
    return { stage: 'security', originalText, draft, product, securities: [] };
  }
  const securities = await service.searchSecurities(draft.securityQuery);
  const exact = exactSecurity(draft.securityQuery ?? '', securities);
  if (exact) return completeOrMissing(originalText, draft, product, exact);
  // A single master-data result is unambiguous even when the user searched by
  // name.  Ambiguous name searches stay on the selection path below.
  if (securities.length === 1) {
    return completeOrMissing(originalText, draft, product, securities[0]);
  }
  // Keep the selection path bounded. A large result set must never turn into
  // a freeform guess, while the first nine still give the user an actionable
  // card (including duplicate names with different codes).
  return {
    stage: 'security',
    originalText,
    draft,
    product,
    securities: prioritizeDuplicateSecurityNames(securities).slice(0, 9),
  };
}

export async function applyDirectRiskIntentInput(
  state: RiskIntentState,
  text: string,
  service: RiskService,
): Promise<RiskIntentState | undefined> {
  const value = text.trim();
  if (!value) return undefined;

  if (state.draft.transactions && state.transactionIndex !== undefined && 'product' in state && state.product) {
    const index = state.transactionIndex;
    const transactions = state.draft.transactions.map(item => ({ ...item }));
    const item = transactions[index];
    if (!item) return undefined;
    if (state.stage === 'security' || (state.stage === 'freeform' && state.field === 'security')) {
      if (item.securityQuery !== value) {
        delete item.tenorText;
        delete item.yieldText;
        delete item.sourceText;
      }
      item.securityQuery = value;
      delete item.resolvedSecurity;
    } else if (state.stage === 'freeform' && state.field === 'amount') {
      if (!confirmedRiskAmount(value)) return undefined;
      item.amountText = value;
    } else return undefined;
    return normalizeSecurity(state.originalText, { ...state.draft, transactions }, state.product, service);
  }

  if (state.stage === 'account' || (state.stage === 'freeform' && state.field === 'account')) {
    return normalizeRiskDraft(
      state.originalText,
      { ...state.draft, accountQuery: value },
      service,
    );
  }

  if (state.stage === 'security' || (state.stage === 'freeform' && state.field === 'security')) {
    if (!state.product) return undefined;
    return normalizeSecurity(
      state.originalText,
      { ...state.draft, securityQuery: value },
      state.product,
      service,
    );
  }

  if (state.stage === 'freeform' && state.field === 'amount') {
    if (!extractAmount(value) || !state.product) return undefined;
    return completeOrMissing(
      state.originalText,
      { ...state.draft, amountText: value },
      state.product,
      state.security,
    );
  }

  return undefined;
}

/** Merge a confirmation-stage correction without discarding untouched fields. */
export function mergeRiskIntentDraft(
  previous: RiskAiDraft,
  revised: RiskAiDraft,
  correction: string,
): RiskAiDraft {
  if (previous.transactions) {
    const account = correctionField(correction, /(?:产品|账户)(?:名称)?\s*(?:改成|改为|修改成|修改为|换成|替换为|调整成|调整为|设为|为)\s*([^\s，,。；;]+)/);
    if (account && !transactionCorrection(correction, previous.transactions.length)) {
      if (/(?:金额|规模|数量|证券|标的|一级|二级|买入|卖出)/.test(correction)) {
        throw new RiskIntentClarificationError(['请逐项修改账户或指定第几笔交易']);
      }
      return { ...previous, accountQuery: account };
    }
    const target = transactionCorrection(correction, previous.transactions.length);
    if (!target) throw new RiskIntentClarificationError(['请指定第几笔，例如“第2笔金额改为3000万”']);
    const old = previous.transactions[target.index]!;
    const replacement = revised.transactions?.[target.index] ?? revised;
    const merged = mergeRiskIntentDraft(
      { ...old, accountQuery: previous.accountQuery },
      { ...replacement, accountQuery: previous.accountQuery }, target.text,
    );
    const amountRevision = /(?:金额|规模|数量)\s*(?:改成|改为|修改成|修改为|调整为|设为)\s*([^，,；;]+)/u.exec(target.text);
    if (amountRevision) merged.amountText = amountRevision[1]!.trim();
    if (merged.accountQuery !== previous.accountQuery) throw new RiskIntentClarificationError(['请单独修改共享账户']);
    return { ...previous, transactions: previous.transactions.map((item, index) => index === target.index
      ? { ...item, ...merged, ...(merged.securityQuery === item.securityQuery
          ? { resolvedSecurity: item.resolvedSecurity }
          : { resolvedSecurity: undefined, tenorText: undefined, yieldText: undefined, sourceText: undefined }) }
      : item) };
  }
  const explicitAmount = extractAmount(correction);
  const explicitAction = findAction(correction);
  const explicitDays = extractDays(correction);
  const explicitMarket = /一级/.test(correction)
    ? 'primary'
    : /二级/.test(correction)
      ? 'secondary'
      : undefined;
  const explicitAccount = correctionField(correction, /(?:产品|账户)(?:名称)?\s*(?:改成|改为|修改成|修改为|换成|替换为|调整成|调整为|设为|为)\s*([^\s，,。；;]+)/);
  const explicitSecurity = correctionField(correction, /(?:证券|标的)(?:名称)?\s*(?:改成|改为|修改成|修改为|换成|替换为|调整成|调整为|设为|为)\s*([^\s，,。；;]+)/);

  return {
    accountQuery: explicitAccount || previous.accountQuery || revised.accountQuery,
    ...(explicitAction || previous.action || revised.action
      ? { action: explicitAction ?? previous.action ?? revised.action }
      : {}),
    ...(explicitSecurity || previous.securityQuery || revised.securityQuery
      ? { securityQuery: explicitSecurity ?? previous.securityQuery ?? revised.securityQuery }
      : {}),
    ...(explicitAmount?.source || previous.amountText || revised.amountText
      ? { amountText: explicitAmount?.source ?? previous.amountText ?? revised.amountText }
      : {}),
    ...(explicitDays !== undefined || previous.days !== undefined || revised.days !== undefined
      ? { days: explicitDays ?? previous.days ?? revised.days }
      : {}),
    market: explicitMarket ?? previous.market ?? revised.market,
  };
}

export function buildIntentSelection(state: RiskIntentState, expiresAt: number): RiskSelectionRequest {
  if (state.stage === 'account') {
    const noCandidates = state.products.length === 0;
    return {
      kind: 'intent-account',
      title: '请选择准确账户',
      subTitle: noCandidates
        ? '未找到匹配的产品，请直接输入准确的产品名称或关键词。'
        : '请选择匹配的产品。',
      replyHint: noCandidates
        ? '也可以选择“其他”后再输入。'
        : '可以直接输入准确的产品名称或关键词。',
      options: [...state.products.map((label, i) => ({ key: `p${i + 1}`, label, value: label })), { key: 'other', label: '其他', value: '__other_account__' }],
      expiresAt,
    };
  }
  if (state.stage === 'security') {
    const noCandidates = state.securities.length === 0;
    return {
      kind: 'intent-security',
      title: state.transactionIndex === undefined ? '请选择准确证券' : `请选择第${state.transactionIndex + 1}笔证券`,
      subTitle: noCandidates
        ? '未找到匹配的证券，请直接输入证券名称或代码。'
        : `请选择匹配的证券${state.draft.transactions ? `（${state.draft.transactions[state.transactionIndex ?? 0]?.securityQuery ?? ''}）` : ''}。`,
      replyHint: noCandidates
        ? '也可以选择“其他”后再输入。'
        : '可以直接输入准确的证券名称或代码。',
      options: [...state.securities.map((item, i) => ({ key: `s${i + 1}`, label: item.label, value: JSON.stringify(item) })), { key: 'other', label: '其他', value: '__other_security__' }],
      expiresAt,
    };
  }
  if (state.stage !== 'confirm') throw new Error('freeform state cannot render directly');
  return {
    kind: 'intent-confirm',
    title: '请确认交易意图',
    subTitle: confirmationSummary(state),
    replyHint: '确认后才会执行投资限额测算；也可以选择修改项或“其他”',
    options: state.draft.transactions ? [
      { key: 'confirm', label: '按全部交易合并测算', value: '__confirm__' },
      { key: 'account', label: '修改账户', value: '__edit_account__' },
      { key: 'other', label: '修改指定交易', value: '__other__' },
    ] : [
      { key: 'confirm', label: '按以上理解执行', value: '__confirm__' },
      { key: 'account', label: '修改账户', value: '__edit_account__' },
      ...(state.security ? [{ key: 'security', label: '修改标的', value: '__edit_security__' }] : []),
      { key: 'amount', label: '修改金额/数量', value: '__edit_amount__' },
      { key: 'market', label: '修改一级/二级', value: '__edit_market__' },
      { key: 'other', label: '其他', value: '__other__' },
    ],
    expiresAt,
  };
}

export function confirmationSummary(state: Extract<RiskIntentState, { stage: 'confirm' }>): string {
  if (state.draft.transactions) {
    const items = state.draft.transactions;
    const amounts = items.map(item => confirmedRiskAmount(item.amountText ?? '')?.amount);
    return [
      `账户：${state.product}；共${items.length}笔交易，合并测算`,
      ...(state.draft.tradeDateText ? [`拟交易日期（原文）：${state.draft.tradeDateText}；测算基准日以服务返回为准`] : []),
      ...items.map((item, index) => `第${index + 1}笔：${confirmationSummary({
        ...state, draft: { ...item, accountQuery: state.draft.accountQuery, action: item.action!, amountText: item.amountText! },
        security: item.resolvedSecurity,
      }).replace(`账户：${state.product}；`, '')}`),
      ...(amounts.every((amount): amount is number => amount !== undefined) && new Set(items.map(item => item.action)).size === 1
        ? [`合计规模：${Number(amounts.reduce((sum, amount) => sum + amount, 0).toFixed(8))}亿元`] : []),
    ].join('\n');
  }
  return [
    `账户：${state.product}`,
    `市场：${state.draft.market === 'primary' ? '一级市场' : '二级市场'}`,
    `操作：${actionLabel(state.draft.action)}`,
    ...(state.security ? [`标的：${state.security.name}${state.security.code ? `（${state.security.code}）` : ''}`] : []),
    `规模：${state.draft.amountText}`,
    ...(state.draft.days !== undefined ? [`期限：${state.draft.days}天`] : []),
    ...(state.draft.tenorText ? [`债券期限（原文）：${state.draft.tenorText}`] : []),
    ...(state.draft.yieldText ? [`收益率（原文）：${state.draft.yieldText}`] : []),
  ].join('；');
}

export function canonicalCommand(state: Extract<RiskIntentState, { stage: 'confirm' }>): string {
  if (state.draft.transactions) throw new Error('多笔交易必须使用 executeConfirmed 合并测算');
  return [
    state.product,
    state.draft.market === 'primary' ? '一级市场' : '二级市场',
    actionLabel(state.draft.action),
    state.draft.amountText,
    ...(state.security ? [state.security.code || state.security.name] : []),
    ...(state.draft.days !== undefined ? [`${state.draft.days}天`] : []),
  ].join(' ');
}

function exactSecurity(query: string, options: RiskSecuritySuggestion[]): RiskSecuritySuggestion | undefined {
  const q = query.trim().toUpperCase();
  return options.find((x) => x.code.trim().toUpperCase() === q);
}

function prioritizeDuplicateSecurityNames(
  options: readonly RiskSecuritySuggestion[],
): RiskSecuritySuggestion[] {
  const counts = new Map<string, number>();
  for (const option of options) {
    const name = option.name.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [
    ...options.filter((option) => (counts.get(option.name.trim()) ?? 0) > 1),
    ...options.filter((option) => (counts.get(option.name.trim()) ?? 0) <= 1),
  ];
}

function needsSecurity(draft: RiskTransactionDraft): boolean {
  return (
    draft.action === 'buy' ||
    draft.action === 'sell' ||
    (draft.market === 'primary' && draft.action === 'subscription')
  );
}

function completeOrMissing(
  originalText: string,
  draft: RiskAiDraft,
  product: string,
  security?: RiskSecuritySuggestion,
): RiskIntentState {
  if (!draft.action) {
    return {
      stage: 'freeform',
      originalText,
      draft,
      field: 'other',
      product,
      ...(security ? { security } : {}),
    };
  }
  if (!draft.amountText) {
    return {
      stage: 'freeform',
      originalText,
      draft,
      field: 'amount',
      product,
      ...(security ? { security } : {}),
    };
  }
  return {
    stage: 'confirm',
    originalText,
    draft: draft as CompleteRiskAiDraft,
    product,
    ...(security ? { security } : {}),
  };
}

function removeProductFromSecurityQuery(
  originalText: string,
  draft: RiskAiDraft,
  products: readonly string[],
  product: string,
): RiskAiDraft {
  if (!draft.securityQuery) return draft;
  const containsProduct =
    matchProductCandidates(draft.securityQuery, [product]).products.length === 1;
  if (!containsProduct) return draft;
  const parsed = parseRiskMessage(originalText, products);
  if (
    parsed.kind !== 'pretrade_calc' ||
    parsed.action !== draft.action ||
    !parsed.securityQuery
  ) {
    return draft;
  }
  return { ...draft, securityQuery: parsed.securityQuery };
}

function correctionField(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match?.[1]?.replace(/[。；;，,]+$/, '').trim() || undefined;
}

function actionLabel(action: RiskActionType): string {
  return ({ subscription: '申购', redemption: '赎回', buy: '买入', sell: '卖出', repo: '正回购', reverse_repo: '逆回购' } as const)[action];
}

function inferAccountQuery(text: string): string {
  const bracketed = [...text.matchAll(/【([^】]+)】/g)]
    .map((match) => match[1]?.replace(/\*\*/g, '').trim() ?? '')
    .filter((value) => /产品$|[0-9一二三四五六七八九十]+号/.test(value));
  if (bracketed.length === 1) return bracketed[0]!;
  const action = /逆回购|回购|申购|认购|赎回|拟投资|买入|卖出|买|卖/.exec(text);
  if (!action) return '';
  return text
    .slice(0, action.index)
    .replace(/一级市场|二级市场|一级|二级/g, '')
    .trim();
}

function jsonObject(raw: string): Record<string, unknown> {
  const t = raw.trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('交易信息格式错误');
  const v = JSON.parse(t.slice(s, e + 1));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('交易信息格式错误');
  return v as Record<string, unknown>;
}
function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }
function actionValue(v: unknown): RiskActionType | undefined {
  return v === 'subscription' || v === 'redemption' || v === 'buy' || v === 'sell' || v === 'repo' || v === 'reverse_repo' ? v : undefined;
}

/** Validate the entire field; never interpret a yield, negative sign or range as an amount. */
export function confirmedRiskAmount(text: string) {
  const normalized = text.trim().replace(/^(\d+(?:\.\d+)?)\s*[wW]$/, '$1万元');
  if (!/^\d+(?:\.\d+)?\s*(?:亿元|万元|亿|万|元|块|股|手|张|份)?$/.test(normalized)) return undefined;
  const amount = extractAmount(normalized);
  return amount && (amount.amount ?? amount.quantity ?? 0) > 0 ? amount : undefined;
}

function transactionCorrection(text: string, count: number): { index: number; text: string } | undefined {
  const match = /^第([1-9]\d*|[一二三四五六七八九十])笔\s*[:：]?\s*(.+)$/u.exec(text.trim());
  if (!match) return undefined;
  const number = Number(match[1]) || '一二三四五六七八九十'.indexOf(match[1]!) + 1;
  if (number < 1 || number > count) throw new RiskIntentClarificationError(['指定的交易序号不存在']);
  return { index: number - 1, text: match[2]! };
}

/** Advance either a single security selection or the selected leg of a batch. */
export async function selectRiskIntentSecurity(
  state: Extract<RiskIntentState, { stage: 'security' }>,
  security: RiskSecuritySuggestion,
  service: RiskService,
): Promise<RiskIntentState> {
  if (!state.draft.transactions) return completeOrMissing(state.originalText, state.draft, state.product, security);
  const index = state.transactionIndex;
  if (index === undefined || !state.draft.transactions[index]) throw new Error('交易序号无效');
  const transactions = state.draft.transactions.map((item, i) => i === index ? { ...item, resolvedSecurity: security } : item);
  return normalizeSecurity(state.originalText, { ...state.draft, transactions }, state.product, service);
}

function transactionSource(original: string, source: string, security: string): string {
  const query = security.toUpperCase();
  const matches = original.split(/\r?\n/).filter(line => query && line.toUpperCase().includes(query));
  const literal = source && original.includes(source);
  if (literal && (!query || source.toUpperCase().includes(query) || !matches.length)) return source;
  // Never use model-added market wording; a unique original row is authoritative.
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1 || (source && !literal)) {
    throw new RiskIntentClarificationError(['无法唯一定位交易原文，请逐笔明确证券和市场']);
  }
  return '';
}

function transactionMarket(original: string, source: string, security: string): 'primary' | 'secondary' {
  const row = transactionSource(original, source, security);
  const explicitSecondary = /二级市场|二级(?=\s|买入|卖出|申购|认购|交易|投资|[：:]|$)/u;
  if (/一级/.test(row) && explicitSecondary.test(row)) {
    throw new RiskIntentClarificationError(['同一笔含多个市场，请明确各笔市场']);
  }
  if (/一级/.test(row)) return 'primary';
  if (explicitSecondary.test(row)) return 'secondary';
  // Only the heading is shared. A market marker on another list item is local.
  const firstItem = /^\s*\d+[、.)）]\s*/m.exec(original);
  const firstCodeLine = original.split(/\r?\n/).find(line => /\b\d{6,12}\.(?:IB|SH|SZ)\b/i.test(line));
  const headingEnd = firstItem?.index ?? (firstCodeLine ? original.indexOf(firstCodeLine) : source ? original.indexOf(source) : original.length);
  const heading = original.slice(0, headingEnd);
  if (/一级/.test(heading) && explicitSecondary.test(heading)) throw new RiskIntentClarificationError(['请逐笔明确一级或二级市场']);
  return detectMarket(heading);
}

function assertInitialTransactionCoverage(text: string, draft: RiskAiDraft): void {
  const codes = [...new Set(text.match(/\b\d{6,12}\.(?:IB|SH|SZ)\b/gi)?.map(code => code.toUpperCase()))];
  const items = draft.transactions ?? [draft];
  const codedLines = text.split(/\r?\n/).filter(line => /^\s*\d+[、.)）]/.test(line) && /\b\d{6,12}\.(?:IB|SH|SZ)\b/i.test(line));
  if (codes.length > items.length || codedLines.length > items.length || codes.some(code => !items.some(item => item.securityQuery?.toUpperCase().includes(code)))) {
    throw new RiskIntentClarificationError(['证券清单未完整识别，请逐笔补充证券和金额']);
  }
}

// Models may return a code together with its display name. Master data uses the code.
function securityQueryValue(value: unknown): string {
  const query = str(value);
  const codes = [...new Set(query.match(/\b\d{6,12}\.(?:IB|SH|SZ)\b/gi)?.map(code => code.toUpperCase()))];
  if (codes.length > 1) throw new RiskIntentClarificationError(['单笔含多个证券代码，请拆分交易']);
  return codes[0] ?? query;
}
