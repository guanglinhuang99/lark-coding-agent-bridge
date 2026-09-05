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

export interface RiskAiDraft {
  accountQuery: string;
  action?: RiskActionType;
  securityQuery?: string;
  amountText?: string;
  days?: number;
  market: 'primary' | 'secondary';
}

type CompleteRiskAiDraft = RiskAiDraft & {
  action: RiskActionType;
  amountText: string;
};

export type RiskIntentState =
  | { stage: 'account'; originalText: string; draft: RiskAiDraft; products: string[] }
  | { stage: 'security'; originalText: string; draft: RiskAiDraft; product: string; securities: RiskSecuritySuggestion[] }
  | { stage: 'confirm'; originalText: string; draft: CompleteRiskAiDraft; product: string; security?: RiskSecuritySuggestion }
  | { stage: 'freeform'; originalText: string; draft: RiskAiDraft; field: 'account' | 'security' | 'amount' | 'market' | 'other'; product?: string; security?: RiskSecuritySuggestion };

export function isPretradeIntentCandidate(text: string): boolean {
  if (/能不能买|是否能买|可以买吗|可不可以买|禁投|关联方证券/.test(text)) return false;
  if (!findAction(text)) return false;
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
    '字段：account_query, action, security_query, amount_text, days。',
    'action 只能是 subscription/redemption/buy/sell/repo/reverse_repo。',
    'account_query 保留用户描述投资账户/资管产品的关键词；security_query 保留用户描述交易标的的关键词。',
    'security_query 不得包含 account_query 中的账户或资管产品名称。',
    'amount_text 保留原始金额/数量及单位。buy/sell 必须提取 security_query。',
    '不要输出 market；程序按用户原话确定：明确出现“一级”才是一级，否则一律二级。',
    ...(previous ? [`上次结果：${JSON.stringify(previous)}`] : []),
    ...(correction ? [`用户修正：${JSON.stringify(correction)}`] : []),
    `用户原话：${JSON.stringify(userText)}`,
  ].join('\n');
}

export function parseRiskIntentOutput(raw: string, originalText: string): CompleteRiskAiDraft {
  const draft = parseRiskIntentOutputPartial(raw, originalText);
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
  const action = findAction(originalText) ?? actionValue(value.action);
  const securityQuery = str(value.security_query);
  const amountText = str(value.amount_text) || extractAmount(originalText)?.source;
  const days = extractDays(originalText) ?? num(value.days);
  const market = detectMarket(originalText);
  return {
    accountQuery,
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

export async function normalizeRiskDraft(originalText: string, draft: RiskAiDraft, service: RiskService): Promise<RiskIntentState> {
  const products = await service.listProducts();
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
      title: '请选择准确证券',
      subTitle: noCandidates
        ? '未找到匹配的证券，请直接输入证券名称或代码。'
        : '请选择匹配的证券。',
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
    options: [
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
  return [
    `账户：${state.product}`,
    `市场：${state.draft.market === 'primary' ? '一级市场' : '二级市场'}`,
    `操作：${actionLabel(state.draft.action)}`,
    ...(state.security ? [`标的：${state.security.name}${state.security.code ? `（${state.security.code}）` : ''}`] : []),
    `规模：${state.draft.amountText}`,
    ...(state.draft.days !== undefined ? [`期限：${state.draft.days}天`] : []),
  ].join('；');
}

export function canonicalCommand(state: Extract<RiskIntentState, { stage: 'confirm' }>): string {
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

function needsSecurity(draft: RiskAiDraft): boolean {
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
  const action = /逆回购|回购|申购|认购|赎回|买入|卖出|买|卖/.exec(text);
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
