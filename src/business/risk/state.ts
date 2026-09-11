import type { RiskIntentState } from './intent';
import type { RiskQueryState } from './router';

export type RiskConversationState =
  | { kind: 'pretrade'; state: RiskIntentState }
  | { kind: 'query'; state: RiskQueryState };

type StoredConversationState =
  | { status: 'active'; state: RiskConversationState; expiresAt: number }
  | { status: 'expired' };

interface StoredTaskState {
  expiresAt: number;
  conversationKey: string;
  state: RiskConversationState;
}

/** Single owner for a runtime's risk continuation state and interaction callbacks. */
export class RiskStateRegistry {
  keys(): string[] { return [...this.states.keys()]; }

  dispose(): void {
    for (const key of this.keys()) this.clearConversation(key);
    for (const taskId of [...this.taskStates.keys()]) this.deleteTask(taskId);
  }

  private readonly states = new Map<string, StoredConversationState>();
  private readonly stateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly taskStates = new Map<string, StoredTaskState>();
  private readonly taskTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60_000,
    private readonly maxExpiredEntries = 2_000,
  ) {}

  getConversation(conversationKey: string): RiskConversationState | undefined {
    const stored = this.states.get(conversationKey);
    if (stored?.status === 'active' && stored.expiresAt <= this.now()) {
      this.expire(conversationKey, stored);
      return undefined;
    }
    return stored?.status === 'active' ? stored.state : undefined;
  }

  getPretrade(conversationKey: string): RiskIntentState | undefined {
    const state = this.getConversation(conversationKey);
    return state?.kind === 'pretrade' ? state.state : undefined;
  }

  getQuery(conversationKey: string): RiskQueryState | undefined {
    const state = this.getConversation(conversationKey);
    return state?.kind === 'query' ? state.state : undefined;
  }

  has(conversationKey: string): boolean {
    return this.getConversation(conversationKey) !== undefined;
  }

  hasPendingOrExpired(conversationKey: string): boolean {
    return this.states.has(conversationKey);
  }

  consumeExpired(conversationKey: string): boolean {
    this.getConversation(conversationKey);
    if (this.states.get(conversationKey)?.status !== 'expired') return false;
    this.states.delete(conversationKey);
    return true;
  }

  setPretrade(conversationKey: string, state: RiskIntentState): void {
    this.setConversation(conversationKey, { kind: 'pretrade', state });
  }

  setQuery(conversationKey: string, state: RiskQueryState): void {
    this.setConversation(conversationKey, { kind: 'query', state });
  }

  delete(conversationKey: string): void {
    const timer = this.stateTimers.get(conversationKey);
    if (timer) clearTimeout(timer);
    this.stateTimers.delete(conversationKey);
    this.states.delete(conversationKey);
  }

  registerConversationTask(
    taskId: string,
    conversationKey: string,
    state: RiskConversationState,
    expiresAt: number,
  ): void {
    this.deleteTask(taskId);
    this.clearTasksForConversation(conversationKey);
    this.taskStates.set(taskId, { conversationKey, state, expiresAt });
    const timer = setTimeout(() => this.deleteTask(taskId), Math.max(0, expiresAt - this.now()));
    timer.unref?.();
    this.taskTimers.set(taskId, timer);
  }

  getConversationTask(taskId: string): RiskConversationState | undefined {
    const task = this.taskStates.get(taskId);
    if (task && task.expiresAt <= this.now()) {
      this.deleteTask(taskId);
      return undefined;
    }
    return task?.state;
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

  // Compatibility surface for callers that still treat this as the former
  // pretrade-only RiskIntentStateRegistry. These methods delegate to the same
  // underlying registry; they do not create a second state owner.
  get(conversationKey: string): RiskIntentState | undefined {
    return this.getPretrade(conversationKey);
  }

  set(conversationKey: string, state: RiskIntentState): void {
    this.setPretrade(conversationKey, state);
  }

  registerTask(
    taskId: string,
    conversationKey: string,
    state: RiskIntentState,
    expiresAt: number,
  ): void {
    this.registerConversationTask(taskId, conversationKey, { kind: 'pretrade', state }, expiresAt);
  }

  getTask(taskId: string): RiskIntentState | undefined {
    const state = this.getConversationTask(taskId);
    return state?.kind === 'pretrade' ? state.state : undefined;
  }

  private setConversation(conversationKey: string, state: RiskConversationState): void {
    this.delete(conversationKey);
    const stored: StoredConversationState = { status: 'active', state, expiresAt: this.now() + this.ttlMs };
    this.states.set(conversationKey, stored);
    const timer = setTimeout(() => {
      this.expire(conversationKey, stored);
    }, this.ttlMs);
    timer.unref?.();
    this.stateTimers.set(conversationKey, timer);
  }

  private expire(key: string, stored: StoredConversationState): void {
    if (this.states.get(key) !== stored) return;
    const timer = this.stateTimers.get(key);
    if (timer) clearTimeout(timer);
    this.stateTimers.delete(key);
    this.clearTasksForConversation(key);
    // Keep only a bounded marker so late replies receive an expiry notice.
    this.states.set(key, { status: 'expired' });
    this.pruneExpired();
  }

  private pruneExpired(): void {
    let expired = 0;
    for (const state of this.states.values()) {
      if (state.status === 'expired') expired += 1;
    }
    if (expired <= this.maxExpiredEntries) return;
    for (const [key, state] of this.states) {
      if (state.status !== 'expired') continue;
      this.states.delete(key);
      expired -= 1;
      if (expired <= this.maxExpiredEntries) return;
    }
  }
}
