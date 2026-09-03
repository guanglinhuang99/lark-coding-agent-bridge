import type { RiskSecuritySuggestion, RiskService } from './client';
import { detectMarket, findAction, matchProductCandidates, type RiskActionType } from './parser';
import type { RiskSelectionRequest } from './router';

export interface RiskAiDraft {
  accountQuery: string;
  action: RiskActionType;
  securityQuery?: string;
  amountText: string;
  days?: number;
  market: 'primary' | 'secondary';
}

export type RiskIntentState =
  | { stage: 'account'; originalText: string; draft: RiskAiDraft; products: string[] }
  | { stage: 'security'; originalText: string; draft: RiskAiDraft; product: string; securities: RiskSecuritySuggestion[] }
  | { stage: 'confirm'; originalText: string; draft: RiskAiDraft; product: string; security?: RiskSecuritySuggestion }
  | { stage: 'freeform'; originalText: string; draft: RiskAiDraft; field: 'account' | 'security' | 'amount' | 'market' | 'other'; product?: string; security?: RiskSecuritySuggestion };

export function isPretradeIntentCandidate(text: string): boolean {
  if (/能不能买|是否能买|可以买吗|可不可以买|禁投|关联方证券/.test(text)) return false;
  if (!findAction(text)) return false;
  return (
    /(?:安联|产品|资产管理|资管|账户|证券|债券|股票|国债|基金|回购|一级|二级)/.test(text) ||
    /(?:金额|数量|\d+(?:\.\d+)?\s*(?:亿|万|元|块|股|手|张|份))/.test(text)
  );
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
    'amount_text 保留原始金额/数量及单位。buy/sell 必须提取 security_query。',
    '不要输出 market；程序按用户原话确定：明确出现“一级”才是一级，否则一律二级。',
    ...(previous ? [`上次结果：${JSON.stringify(previous)}`] : []),
    ...(correction ? [`用户修正：${JSON.stringify(correction)}`] : []),
    `用户原话：${JSON.stringify(userText)}`,
  ].join('\n');
}

export function parseRiskIntentOutput(raw: string, originalText: string): RiskAiDraft {
  const value = jsonObject(raw);
  const accountQuery = str(value.account_query);
  const action = actionValue(value.action);
  const securityQuery = str(value.security_query);
  const amountText = str(value.amount_text);
  const days = num(value.days);
  const market = detectMarket(originalText);
  const needsSecurity =
    action === 'buy' || action === 'sell' || (market === 'primary' && action === 'subscription');
  const missing = [
    ...(!accountQuery ? ['账户'] : []),
    ...(!action ? ['交易动作'] : []),
    ...(!amountText ? ['金额/数量'] : []),
    ...(needsSecurity && !securityQuery ? ['交易标的'] : []),
  ];
  if (missing.length) throw new RiskIntentClarificationError(missing);
  if (!action) throw new RiskIntentClarificationError(['交易动作']);
  return {
    accountQuery,
    action,
    ...(securityQuery ? { securityQuery } : {}),
    amountText,
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
  const matched = matchProductCandidates(draft.accountQuery, products).products;
  if (matched.length !== 1) return { stage: 'account', originalText, draft, products: matched.slice(0, 9) };
  return normalizeSecurity(originalText, draft, matched[0]!, service);
}

export async function normalizeSecurity(originalText: string, draft: RiskAiDraft, product: string, service: RiskService): Promise<RiskIntentState> {
  const needsSecurity =
    draft.action === 'buy' ||
    draft.action === 'sell' ||
    (draft.market === 'primary' && draft.action === 'subscription');
  if (!needsSecurity) return { stage: 'confirm', originalText, draft, product };
  const securities = await service.searchSecurities(draft.securityQuery ?? '');
  const exact = exactSecurity(draft.securityQuery ?? '', securities);
  if (exact) return { stage: 'confirm', originalText, draft, product, security: exact };
  if (securities.length === 1) return { stage: 'confirm', originalText, draft, product, security: securities[0] };
  return { stage: 'security', originalText, draft, product, securities: securities.slice(0, 9) };
}

export function buildIntentSelection(state: RiskIntentState, expiresAt: number): RiskSelectionRequest {
  if (state.stage === 'account') {
    const noCandidates = state.products.length === 0;
    return {
      kind: 'intent-account',
      title: '请选择准确账户',
      subTitle: noCandidates
        ? `risk-service 未找到账户候选；AI 识别关键词：${state.draft.accountQuery}`
        : `AI 识别关键词：${state.draft.accountQuery}`,
      replyHint: noCandidates
        ? '未找到候选，请选择“其他”并输入准确账户名称或关键词'
        : '请选择 risk-service 返回的账户；若都不是请选择“其他”后自行输入',
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
        ? `risk-service 未找到证券候选；AI 识别关键词：${state.draft.securityQuery ?? ''}`
        : `AI 识别关键词：${state.draft.securityQuery ?? ''}`,
      replyHint: noCandidates
        ? '未找到候选，请选择“其他”并输入准确证券名称或代码'
        : '请选择 risk-service 返回的证券；若都不是请选择“其他”后自行输入',
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
  return options.find((x) => x.code.toUpperCase() === q || x.name.trim() === query.trim());
}
function actionLabel(action: RiskActionType): string {
  return ({ subscription: '申购', redemption: '赎回', buy: '买入', sell: '卖出', repo: '正回购', reverse_repo: '逆回购' } as const)[action];
}
function jsonObject(raw: string): Record<string, unknown> {
  const t = raw.trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('AI 未返回 JSON');
  const v = JSON.parse(t.slice(s, e + 1));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('AI JSON 格式错误');
  return v as Record<string, unknown>;
}
function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }
function actionValue(v: unknown): RiskActionType | undefined {
  return v === 'subscription' || v === 'redemption' || v === 'buy' || v === 'sell' || v === 'repo' || v === 'reverse_repo' ? v : undefined;
}
