export type WeComCardLifecycleState = 'active' | 'consumed' | 'expired';

export interface WeComCardRegistration<T = unknown> {
  taskId: string;
  purpose: string;
  conversationKey: string;
  payload?: T;
  expiresAt: number;
  revision?: number;
}

export interface WeComCardInstance<T = unknown> extends WeComCardRegistration<T> {
  revision: number;
  createdAt: number;
  updatedAt: number;
  state: WeComCardLifecycleState;
}

export type WeComCardResolveResult<T = unknown> =
  | { status: 'resolved'; card: WeComCardInstance<T> }
  | { status: 'missing' }
  | { status: 'expired'; card: WeComCardInstance<T> }
  | { status: 'mismatch'; card: WeComCardInstance<T> }
  | { status: 'stale'; card: WeComCardInstance<T> };

/**
 * Process-local lifecycle registry for interactive WeCom cards.
 *
 * The registry intentionally does not know business semantics. It only guards
 * task identity, conversation ownership, expiry, revision and duplicate use.
 * Feature handlers remain responsible for validating selected values/actions.
 */
export class WeComCardRegistry<T = unknown> {
  private readonly cards = new Map<string, WeComCardInstance<T>>();
  private readonly latestByConversationPurpose = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  register(input: WeComCardRegistration<T>): WeComCardInstance<T> {
    const timestamp = this.now();
    const revision = input.revision ?? 1;
    const card: WeComCardInstance<T> = {
      ...input,
      revision,
      createdAt: timestamp,
      updatedAt: timestamp,
      state: 'active',
    };

    const slot = slotKey(input.conversationKey, input.purpose);
    const previousTaskId = this.latestByConversationPurpose.get(slot);
    if (previousTaskId && previousTaskId !== input.taskId) {
      this.cards.delete(previousTaskId);
    }

    this.cards.set(input.taskId, card);
    this.latestByConversationPurpose.set(slot, input.taskId);
    return card;
  }

  has(taskId: string, conversationKey?: string): boolean {
    const card = this.cards.get(taskId);
    if (!card) return false;
    if (card.state !== 'active') return false;
    if (card.expiresAt <= this.now()) return false;
    return conversationKey ? card.conversationKey === conversationKey : true;
  }

  resolve(
    taskId: string,
    conversationKey: string,
    expectedRevision?: number,
  ): WeComCardResolveResult<T> {
    const card = this.cards.get(taskId);
    if (!card || card.state !== 'active') return { status: 'missing' };

    if (card.expiresAt <= this.now()) {
      const expired = this.finish(card, 'expired');
      return { status: 'expired', card: expired };
    }
    if (card.conversationKey !== conversationKey) return { status: 'mismatch', card };
    if (expectedRevision !== undefined && expectedRevision !== card.revision) {
      return { status: 'stale', card };
    }

    return { status: 'resolved', card };
  }

  consume(
    taskId: string,
    conversationKey: string,
    expectedRevision?: number,
  ): WeComCardResolveResult<T> {
    const result = this.resolve(taskId, conversationKey, expectedRevision);
    if (result.status !== 'resolved') return result;
    return { status: 'resolved', card: this.finish(result.card, 'consumed') };
  }

  bump(taskId: string): WeComCardInstance<T> | undefined {
    const card = this.cards.get(taskId);
    if (!card || card.state !== 'active') return undefined;
    const updated: WeComCardInstance<T> = {
      ...card,
      revision: card.revision + 1,
      updatedAt: this.now(),
    };
    this.cards.set(taskId, updated);
    return updated;
  }

  clearConversation(conversationKey: string): void {
    for (const [taskId, card] of this.cards) {
      if (card.conversationKey === conversationKey) this.cards.delete(taskId);
    }
    for (const [slot, taskId] of this.latestByConversationPurpose) {
      if (slot.startsWith(`${conversationKey}\u0000`)) {
        this.latestByConversationPurpose.delete(slot);
        this.cards.delete(taskId);
      }
    }
  }

  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [taskId, card] of this.cards) {
      if (card.state !== 'active' || card.expiresAt <= now) {
        this.cards.delete(taskId);
        this.dropLatest(card);
        removed += 1;
      }
    }
    return removed;
  }

  private finish(
    card: WeComCardInstance<T>,
    state: Exclude<WeComCardLifecycleState, 'active'>,
  ): WeComCardInstance<T> {
    const finished: WeComCardInstance<T> = {
      ...card,
      state,
      updatedAt: this.now(),
    };
    this.cards.delete(card.taskId);
    this.dropLatest(card);
    return finished;
  }

  private dropLatest(card: WeComCardInstance<T>): void {
    const slot = slotKey(card.conversationKey, card.purpose);
    if (this.latestByConversationPurpose.get(slot) === card.taskId) {
      this.latestByConversationPurpose.delete(slot);
    }
  }
}

function slotKey(conversationKey: string, purpose: string): string {
  return `${conversationKey}\u0000${purpose}`;
}
