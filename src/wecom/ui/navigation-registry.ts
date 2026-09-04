import {
  WeComCardRegistry,
  type WeComCardInstance,
  type WeComCardResolveResult,
} from './registry';

export type NavigationCardPurpose = 'menu' | 'workspace' | 'model' | 'reasoning' | 'session';

export interface NavigationCardPayload {
  optionLabels: ReadonlyMap<string, string>;
}

export type NavigationSelectionResult =
  | {
      status: 'selected';
      card: WeComCardInstance<NavigationCardPayload>;
      selectedId: string;
      label: string;
    }
  | { status: 'invalid' | 'purpose-mismatch' }
  | WeComCardResolveResult<NavigationCardPayload>;

/**
 * Keeps Navigation-specific callback checks at the boundary while delegating
 * lifecycle state and ownership to the shared card registry.
 */
export class WeComNavigationCardRegistry {
  private readonly cards: WeComCardRegistry<NavigationCardPayload>;

  constructor(now: () => number = Date.now) {
    this.cards = new WeComCardRegistry(now);
  }

  register(options: {
    taskId: string;
    purpose: NavigationCardPurpose;
    conversationKey: string;
    optionLabels?: ReadonlyMap<string, string>;
    expiresAt: number;
  }): void {
    this.cards.register({
      taskId: options.taskId,
      purpose: options.purpose,
      conversationKey: options.conversationKey,
      payload: { optionLabels: options.optionLabels ?? new Map() },
      expiresAt: options.expiresAt,
    });
  }

  resolve(
    taskId: string,
    conversationKey: string,
  ): WeComCardResolveResult<NavigationCardPayload> {
    return this.cards.resolve(taskId, conversationKey);
  }

  consumeSelection(
    taskId: string,
    conversationKey: string,
    purpose: Exclude<NavigationCardPurpose, 'menu'>,
    selectedId: string | undefined,
  ): NavigationSelectionResult {
    const resolved = this.cards.resolve(taskId, conversationKey);
    if (resolved.status !== 'resolved') return resolved;
    if (resolved.card.purpose !== purpose) return { status: 'purpose-mismatch' };

    const labels = resolved.card.payload?.optionLabels;
    if (!selectedId || !labels?.has(selectedId)) return { status: 'invalid' };

    const consumed = this.cards.consume(taskId, conversationKey, resolved.card.revision);
    if (consumed.status !== 'resolved') return consumed;
    return {
      status: 'selected',
      card: consumed.card,
      selectedId,
      label: labels.get(selectedId) ?? selectedId,
    };
  }

  clearConversation(conversationKey: string): void {
    this.cards.clearConversation(conversationKey);
  }

  prune(): number {
    return this.cards.prune();
  }
}
