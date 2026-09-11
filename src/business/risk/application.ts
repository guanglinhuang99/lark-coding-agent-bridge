import { parseBusinessCommand, RISK_USAGE_LINES, shouldUseRiskFastPath } from '../commands';
import type { RiskService } from './client';
import { executeCreditCommand } from './credit-command';
import {
  applyDirectRiskIntentInput, applySimpleRiskCorrection, buildIntentSelection,
  isPretradeIntentCandidate, isRiskIntentCorrection, mergeRiskIntentDraft,
  normalizeRiskDraft, normalizeSecurity, resolveInitialRiskIntent,
  RiskIntentClarificationError, selectRiskIntentSecurity,
  type RiskAiDraft, type RiskIntentState,
} from './intent';
import { isRiskCandidate } from './parser';
import { RiskRouter, type RiskRouteResult, type RiskQueryState } from './router';
import { businessConversationScope } from '../identity';
import { RiskStateRegistry, type RiskTerminalState } from './state';

export type RiskReply =
  | { handled: false }
  | { handled: true; kind: 'notice'; title: string; lines: string[]; level: 'info' | 'warning' | 'error' }
  | { handled: true; kind: 'intent'; state: RiskIntentState }
  | { handled: true; kind: 'result'; result: Extract<RiskRouteResult, { handled: true }>; confirmed: boolean }
  | { handled: true; kind: 'pages'; pages: string[] };

export interface RiskRequest {
  /** Server-derived, namespaced conversation AND actor identity; never supplied by a card. */
  key: string;
  text: string;
  authorized: boolean;
  hasAttachments?: boolean;
  /** Adapters that already stripped the command may retain its explicit intent. */
  explicitMeasurement?: boolean;
  maxMessageBytes?: number;
  onProgress?: (message: string) => void;
}
/** Opaque, single-use marker captured before asynchronous conversation resolution. */
export interface RiskArrival { readonly kind: 'risk-arrival' }

/** Server-owned receipt captured BEFORE transport acknowledgement or queue waits. */
export interface RiskIngress {
  readonly accepted: boolean;
  release(): void;
}
interface CapturedInput {
  key: string;
  text: string;
  explicit: boolean;
  expectedState?: RiskIntentState | RiskQueryState;
  terminal?: RiskTerminalState;
  continuation: boolean;
  controller: AbortController;
  used: boolean;
  released: boolean;
  full: boolean;
}

export interface RiskAnalyzerInput {
  key: string;
  originalText: string;
  previous?: RiskAiDraft;
  correction?: string;
  signal: AbortSignal;
}
export interface RiskApplicationOptions {
  service?: RiskService;
  router?: RiskRouter;
  states?: RiskStateRegistry;
  analyze?: (input: RiskAnalyzerInput) => Promise<RiskAiDraft>;
  invalidateSelections?: (key: string) => void;
  maxPending?: number;
}

/** Business decisions live here, never in an IM entrypoint or card renderer. */
export class RiskApplication {
  readonly states: RiskStateRegistry;
  readonly router?: RiskRouter;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly requests = new Map<string, Set<AbortController>>();
  private readonly receipts = new WeakMap<RiskIngress, CapturedInput>();
  private readonly arrivals = new WeakMap<RiskArrival, number>();
  private readonly ingress = new Map<string, Set<RiskIngress>>();
  private ingressCount = 0;
  private pendingCount = 0;
  private closed = false;

  constructor(private readonly options: RiskApplicationOptions) {
    this.states = options.states ?? new RiskStateRegistry();
    this.router = options.router ?? (options.service ? new RiskRouter(options.service) : undefined);
  }

  accepts(key: string, text: string, hasAttachments = false): boolean {
    const command = parseBusinessCommand(text);
    if (command.kind === 'credit-query') return true;
    if (isRiskIntentConfirmation(text) && this.states.terminalFor(key)) return true;
    if (command.kind === 'help' || (command.kind === 'other' && text.trim().startsWith('/'))) return false;
    return shouldUseRiskFastPath(command, this.states.hasPendingOrExpired(key) || this.pending.has(key) || this.ingress.has(key), hasAttachments,
      isPretradeIntentCandidate(text));
  }

  markArrival(): RiskArrival {
    const arrival: RiskArrival = Object.freeze({ kind: 'risk-arrival' });
    this.arrivals.set(arrival, this.states.revision());
    return arrival;
  }

  capture(request: RiskRequest, arrival?: RiskArrival): RiskIngress {
    const maxRevision = arrival ? this.arrivals.get(arrival) ?? -1 : this.states.revision();
    if (arrival) this.arrivals.delete(arrival);
    const command = parseBusinessCommand(request.text);
    const text = command.kind === 'risk-measurement' ? command.payload : request.text.trim();
    const accepted = Boolean(request.explicitMeasurement || this.accepts(request.key, request.text, request.hasAttachments));
    const fresh = command.kind === 'credit-query' || isPretradeIntentCandidate(text) ||
      ((request.explicitMeasurement || command.kind === 'risk-measurement') && !isRiskIntentConfirmation(text));
    const captured: CapturedInput = { key: request.key, text: request.text, explicit: Boolean(request.explicitMeasurement),
      expectedState: this.states.getConversation(request.key, maxRevision)?.state, continuation: !fresh,
      terminal: this.states.terminalFor(request.key, maxRevision),
      controller: new AbortController(), used: false, released: false,
      full: accepted && this.ingressCount >= (this.options.maxPending ?? 32) };
    const tracked = accepted && !captured.full;
    const receipt: RiskIngress = { accepted, release: () => {
      if (captured.released) return;
      captured.released = true;
      captured.controller.abort();
      if (tracked) {
        this.ingressCount--;
        const entries = this.ingress.get(request.key);
        entries?.delete(receipt);
        if (!entries?.size) this.ingress.delete(request.key);
      }
    } };
    this.receipts.set(receipt, captured);
    if (tracked) {
      const entries = this.ingress.get(request.key) ?? new Set<RiskIngress>();
      entries.add(receipt);
      this.ingress.set(request.key, entries);
      this.ingressCount++;
    }
    return receipt;
  }

  cancel(key: string): RiskReply {
    const hadWork = this.states.hasPendingOrExpired(key) || this.requests.has(key) || this.ingress.has(key);
    for (const receipt of this.ingress.get(key) ?? []) this.receipts.get(receipt)?.controller.abort();
    for (const request of this.requests.get(key) ?? []) request.abort();
    this.clear(key);
    if (!hadWork) return { handled: false };
    this.states.rememberTerminal(key, 'cancelled');
    return riskCancellationReply();
  }

  cancelScope(scope: string): RiskReply {
    const keys = new Set([...this.states.keys(), ...this.requests.keys(), ...this.ingress.keys()]);
    let cancelled = false;
    for (const key of keys) {
      if (businessConversationScope(key) === scope && this.cancel(key).handled) cancelled = true;
    }
    return cancelled ? riskCancellationReply() : { handled: false };
  }

  /** A new ordinary session relinquishes old risk ownership; stopping retains it. */
  reset(key: string): void {
    this.cancel(key);
    this.states.forgetTerminal(key);
  }

  resetScope(scope: string): void {
    const keys = new Set([...this.states.keys(), ...this.states.terminalKeys(),
      ...this.requests.keys(), ...this.ingress.keys()]);
    for (const key of keys) if (businessConversationScope(key) === scope) this.reset(key);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const key of new Set([...this.requests.keys(), ...this.ingress.keys()])) this.cancel(key);
    await Promise.allSettled(this.pending.values());
    for (const entries of this.ingress.values()) for (const receipt of entries) receipt.release();
    this.states.dispose();
  }

  handle(request: RiskRequest, receipt = this.capture(request)): Promise<RiskReply> {
    const captured = this.receipts.get(receipt);
    if (!captured || captured.used || captured.released || captured.key !== request.key ||
        captured.text !== request.text || captured.explicit !== Boolean(request.explicitMeasurement)) {
      return Promise.resolve(notice('请求已失效', ['请重新发送；本次未执行。']));
    }
    captured.used = true;
    if (!receipt.accepted) {
      // A genuinely new ordinary message hands control back to the generic Agent.
      // Compare the captured marker so a delayed generic message cannot erase a newer end.
      if (request.authorized && captured.terminal && !isRiskIntentConfirmation(request.text) &&
          !request.text.trim().startsWith('/')) this.states.forgetTerminal(request.key, captured.terminal);
      receipt.release();
      return Promise.resolve({ handled: false });
    }
    if (captured.full) { receipt.release(); return Promise.resolve(notice('当前任务较多', ['请稍后重试，本次未执行。'])); }
    return this.serial(request.key, async signal => {
      if (!request.authorized) return notice('无法使用风险查询', ['当前用户没有风险查询权限。'], 'error');
      if (captured.continuation && (!captured.expectedState ||
          this.states.getConversation(request.key)?.state !== captured.expectedState)) {
        const terminal = this.states.terminalFor(request.key) ?? captured.terminal;
        if (!this.states.has(request.key) && terminal && isRiskIntentConfirmation(request.text)) {
          return terminal.reason === 'cancelled'
            ? notice('该风险交互已取消', ['当前没有待确认草稿；本条确认不会启动测算。请重新发送 `/测算 <交易文本>`。'], 'info')
            : notice('该确认已处理', ['不会重复执行测算。请查看上次结果；失败或需要重新测算时，请重新发送 `/测算 <交易文本>`。'], 'info');
        }
        return notice('当前确认或选择已失效', ['请等待最新确认摘要，再回复；本次未执行。']);
      }
      const reply = await this.dispatch(request, signal);
      return reply.handled ? reply : notice('风险选择已结束', ['请重新发送完整的交易或风险查询。']);
    }, captured.controller.signal).finally(() => receipt.release());
  }

  /** A callback may reference ONLY a state and option already held on the server. */
  select(request: RiskRequest, state: RiskIntentState, optionKey: string): Promise<RiskReply> {
    return this.serial(request.key, async signal => {
      if (!request.authorized) return notice('无法使用风险查询', ['当前用户没有风险查询权限。'], 'error');
      if (this.states.getPretrade(request.key) !== state) {
        return notice('之前的风险选择已失效', ['请使用最新选择或重新发起测算。']);
      }
      const service = this.options.service;
      if (state.stage === 'freeform' || !this.router) return unavailable();
      const option = buildIntentSelection(state, Date.now() + 300_000).options.find(item => item.key === optionKey);
      if (!option) return notice('无效选择', ['请从当前候选项中选择。']);
      if (state.stage === 'confirm' && option.value === '__confirm__') {
        return this.confirm(request, state, signal);
      }
      if (!service) return unavailable();
      this.invalidate(request.key);
      const next = await resolveRiskIntentChoice(state, option.value ?? option.key, service);
      ensureActive(signal);
      return this.store(request.key, next);
    });
  }

  continueQuery(request: RiskRequest, state: RiskQueryState, input: string): Promise<RiskReply> {
    return this.serial(request.key, async signal => {
      if (!request.authorized) return notice('无法使用风险查询', ['当前用户没有风险查询权限。'], 'error');
      if (!this.router || this.states.getQuery(request.key) !== state) {
        return notice('之前的风险选择已失效', ['请重新发起查询。']);
      }
      this.invalidate(request.key);
      const result = await this.router.continue(state, input, request.onProgress);
      ensureActive(signal);
      return result.handled ? this.route(request.key, result)
        : notice('无法继续风险查询', ['请重新发送完整查询。']);
    });
  }

  private serial(key: string, execute: (signal: AbortSignal) => Promise<RiskReply>, parentSignal?: AbortSignal): Promise<RiskReply> {
    if (this.closed) return Promise.resolve(unavailable());
    if (!key.trim()) return Promise.resolve(notice('会话无效', ['请重新发起请求。'], 'error'));
    if (this.pendingCount >= (this.options.maxPending ?? 32)) {
      return Promise.resolve(notice('当前任务较多', ['请稍后重试，本次未执行。']));
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const requests = this.requests.get(key) ?? new Set<AbortController>();
    requests.add(controller);
    this.requests.set(key, requests);
    this.pendingCount++;
    const prior = this.pending.get(key) ?? Promise.resolve();
    const promise = prior.catch(() => {}).then(async (): Promise<RiskReply> => {
      try {
        ensureActive(controller.signal);
        return await execute(controller.signal);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'RiskIntentInterruptedError')) {
          return notice('风险交互已停止', ['不会自动重试；已提交的只读测算可能仍在完成。']);
        }
        if (error instanceof RiskIntentClarificationError) return notice('需要补充交易信息', error.missing);
        return notice('风险查询未完成', ['请核对输入或稍后重试；本次不会转入普通聊天，也不会将失败结果计为零。'], 'error');
      }
    }).finally(() => {
      parentSignal?.removeEventListener('abort', abort);
      this.pendingCount--;
      requests.delete(controller);
      if (!requests.size) this.requests.delete(key);
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  private async dispatch(request: RiskRequest, signal: AbortSignal): Promise<RiskReply> {
    const { key, onProgress } = request;
    const command = parseBusinessCommand(request.text);
    const explicit = request.explicitMeasurement || command.kind === 'risk-measurement';
    const text = command.kind === 'risk-measurement' ? command.payload : request.text.trim();
    if (command.kind === 'credit-query') {
      // A read-only credit lookup must not discard an unrelated pending trade.
      const pages: string[] = [];
      const service = this.options.service;
      const batch = service ? {
        getCredit: (entity: string) => service.getCredit(entity),
        getCredits: async (entities: string[]) => {
          if (!service.getCredits) throw new Error('Batch credit capability unavailable');
          return service.getCredits(entities);
        },
      } : undefined;
      await executeCreditCommand(command.payload, batch, request.maxMessageBytes ?? 3500,
        async page => { pages.push(page); }, async page => { pages.push(page); });
      ensureActive(signal);
      return { handled: true, kind: 'pages', pages };
    }
    if (explicit && !text) {
      this.clear(key);
      return notice('测算用法', [...RISK_USAGE_LINES], 'info');
    }
    const service = this.options.service;
    if (!service || !this.router) return unavailable();
    const trade = isPretradeIntentCandidate(text);
    if (this.states.consumeExpired(key) && !isRiskCandidate(text) && !trade && !explicit) {
      this.clear(key);
      return notice('之前的风险选择已过期', ['请重新发送完整交易或风险查询。']);
    }
    const query = this.states.getQuery(key);
    if (query && !explicit) {
      this.invalidate(key);
      const result = await this.router.continue(query, text, onProgress);
      ensureActive(signal);
      if (result.handled) return this.route(key, result);
      this.states.delete(key);
    } else if (query) this.clear(key);

    const pending = this.states.getPretrade(key);
    if (pending && (trade || explicit) && !isRiskIntentCorrection(text)) return this.prepare(request, text, signal);
    if (pending?.stage === 'confirm' && isRiskIntentConfirmation(text)) return this.confirm(request, pending, signal);
    if (pending) {
      if (pending.stage === 'freeform' && isRiskIntentConfirmation(text)) {
        return notice('请先补充或修正信息', ['当前没有可执行的确认稿，请补充后核对新的交易摘要。']);
      }
      this.invalidate(key);
      // A correction revokes the old approval BEFORE any async parsing or lookup.
      if (pending.stage === 'confirm') this.states.setPretrade(key, { ...pending, stage: 'freeform', field: 'other' });
      // Candidate tokens are generated by the same selection model as cards.
      const choice = pending.stage === 'freeform' ? undefined
        : buildIntentSelection(pending, Date.now() + 300_000).options.find(item => item.key === text);
      if (choice && choice.value !== '__confirm__') {
        const next = await resolveRiskIntentChoice(pending, choice.value ?? choice.key, service);
        ensureActive(signal);
        return this.store(key, next);
      }
      if (pending.stage === 'account' || pending.stage === 'security' ||
          (pending.stage === 'freeform' && ['account', 'security', 'amount'].includes(pending.field))) {
        const next = await applyDirectRiskIntentInput(pending, text, service);
        ensureActive(signal);
        return next ? this.store(key, next) : notice('需要修正输入', ['请输入有效的名称、代码或金额（含单位）。']);
      }
      if (pending.stage === 'freeform' && pending.field === 'market') {
        if (!/^(?:一级|二级)(?:市场)?$/.test(text)) return notice('需要选择交易市场', ['请输入“一级”或“二级”。']);
        const next = await normalizeRiskDraft(pending.originalText,
          { ...pending.draft, market: text.startsWith('一级') ? 'primary' : 'secondary' }, service);
        ensureActive(signal);
        return this.store(key, next);
      }
      const direct = pending.stage === 'confirm' ? applySimpleRiskCorrection(pending, text) : undefined;
      if (direct) return this.store(key, direct);
      onProgress?.('正在保留未修改字段并重新核对交易信息。');
      const revised = await this.analyze(key, pending.originalText, signal, pending.draft, text);
      const merged = mergeRiskIntentDraft(pending.draft, revised, text);
      const next = await normalizeRiskDraft(`${pending.originalText} ${text}`, merged, service);
      ensureActive(signal);
      return this.store(key, next);
    }
    if (trade) return this.prepare(request, text, signal);
    const result = await this.router.handle(key, text, onProgress);
    ensureActive(signal);
    if (result.handled && !(explicit && result.intent === 'unknown-risk')) return this.route(key, result);
    return explicit ? this.prepare(request, text, signal) : { handled: false };
  }

  private async prepare(request: RiskRequest, text: string, signal: AbortSignal): Promise<RiskReply> {
    this.clear(request.key); // A failed NEW request must never leave an old confirmable draft.
    request.onProgress?.('正在提取并核对账户、操作、标的和交易规模。');
    const state = await resolveInitialRiskIntent(text, this.options.service!, () =>
      this.analyze(request.key, text, signal));
    ensureActive(signal);
    return this.store(request.key, state);
  }

  private async analyze(key: string, originalText: string, signal: AbortSignal,
    previous?: RiskAiDraft, correction?: string): Promise<RiskAiDraft> {
    ensureActive(signal);
    if (!this.options.analyze) throw new RiskIntentClarificationError(['请使用完整的标准交易格式；意图解析服务未配置']);
    const draft = await this.options.analyze({ key, originalText, previous, correction, signal });
    ensureActive(signal);
    return draft;
  }

  private async confirm(request: RiskRequest, state: Extract<RiskIntentState, { stage: 'confirm' }>,
    signal: AbortSignal): Promise<RiskReply> {
    ensureActive(signal);
    // Consume before awaiting the backend. Duplicate text/card deliveries cannot submit again.
    this.clear(request.key);
    this.states.rememberTerminal(request.key, 'consumed');
    request.onProgress?.('交易信息已锁定，正在执行投资限额测算。');
    const result = await this.router!.executeConfirmed(state, request.onProgress);
    ensureActive(signal);
    return result.handled ? this.route(request.key, result, true) : unavailable();
  }

  private store(key: string, state: RiskIntentState): RiskReply {
    this.states.setPretrade(key, state);
    return { handled: true, kind: 'intent', state };
  }
  private route(key: string, result: Extract<RiskRouteResult, { handled: true }>, confirmed = false): RiskReply {
    if (result.continuation) this.states.setQuery(key, result.continuation);
    else this.states.delete(key);
    return { handled: true, kind: 'result', result, confirmed };
  }
  private invalidate(key: string): void {
    this.options.invalidateSelections?.(key);
    this.states.clearTasksForConversation(key);
  }
  private clear(key: string): void { this.invalidate(key); this.states.delete(key); }
}

/** Shared transition for validated server-side options, used by every presentation. */
export async function resolveRiskIntentChoice(state: RiskIntentState, value: string,
  service: RiskService): Promise<RiskIntentState> {
  if (state.stage === 'account') {
    if (value === '__other_account__') return { ...state, stage: 'freeform', field: 'account' };
    if (!state.products.includes(value)) throw new Error('Invalid account choice');
    return state.draft.accounts && state.accountIndex !== undefined
      ? normalizeRiskDraft(state.originalText, { ...state.draft, accounts: state.draft.accounts.map((account, index) =>
          index === state.accountIndex ? { ...account, accountQuery: value, resolvedProduct: value } : account) }, service)
      : normalizeSecurity(state.originalText, { ...state.draft, accountQuery: value }, value, service);
  }
  if (state.stage === 'security') {
    if (value === '__other_security__') return { ...state, stage: 'freeform', field: 'security' };
    const security = state.securities.find(item => JSON.stringify(item) === value);
    if (!security) throw new Error('Invalid security choice');
    return selectRiskIntentSecurity(state, security, service);
  }
  if (state.stage === 'confirm' && value !== '__confirm__') {
    const field = value === '__edit_account__' ? 'account' : value === '__edit_security__' ? 'security'
      : value === '__edit_amount__' ? 'amount' : value === '__edit_market__' ? 'market' : 'other';
    return { ...state, stage: 'freeform', field };
  }
  throw new Error('Invalid intent transition');
}

export function isRiskIntentConfirmation(text: string): boolean {
  return /^(?:确认|是|是的|对|对的|好|好的|可以|行|ok|yes|y|1|confirm)$/i.test(text.trim());
}
export function riskIntentInputPrompt(state: Extract<RiskIntentState, { stage: 'freeform' }>): string {
  const prefix = state.accountIndex === undefined
    ? (state.transactionIndex === undefined ? '' : `第${state.transactionIndex + 1}笔：`)
    : `第${state.accountIndex + 1}个账户${state.transactionIndex === undefined ? '' : `第${state.transactionIndex + 1}笔`}：`;
  if (state.draft.accounts && state.field === 'other') return '请指定账户和交易序号，例如“第2个账户第1笔金额改为3000万”。';
  if (state.draft.transactions && state.field === 'other') return `${prefix}请指定交易序号和修改内容，例如“第2笔金额改为3000万”。`;
  return prefix + (state.field === 'account' ? '请直接输入准确的账户名称或关键词。'
    : state.field === 'security' ? '请直接输入准确的证券名称或代码。'
      : state.field === 'amount' ? '请直接输入正确的金额或数量（含单位）。'
        : state.field === 'market' ? '请直接输入“一级”或“二级”。' : '请直接输入需要修改或补充的内容。');
}
function riskCancellationReply(): RiskReply {
  return notice('已取消风险交互', [
    '待确认草稿和排队请求已撤销，后续确认不会启动测算。',
    '已经提交的只读操作可能仍在完成；不会自动重试，也不会恢复已撤销的草稿。',
  ], 'info');
}
function notice(title: string, lines: string[], level: 'info' | 'warning' | 'error' = 'warning'): RiskReply {
  return { handled: true, kind: 'notice', title, lines, level };
}
function unavailable(): RiskReply {
  return notice('风险查询暂时不可用', ['风险数据服务尚未就绪；本次不会进入普通聊天。'], 'error');
}
function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Risk request cancelled');
}
