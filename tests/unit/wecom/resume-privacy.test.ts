import { describe, expect, it, vi } from 'vitest';
import type { WeComConversationBindings } from '../../../src/wecom/conversation-bindings';
import { NavigationController } from '../../../src/wecom/navigation-controller';
import { WeComNavigationCardRegistry } from '../../../src/wecom/ui/navigation-registry';

function controller(options: {
  registry?: WeComNavigationCardRegistry;
  sessionsFor?: (key: string) => Array<{ threadId: string; updatedAt: number; status: 'active' | 'archived' }>;
  workspaceFor?: (key: string) => string;
  setThread?: (key: string, threadId: string) => Promise<void>;
  busy?: boolean;
} = {}) {
  const registry = options.registry ?? new WeComNavigationCardRegistry();
  const sessionsFor = vi.fn(options.sessionsFor ?? (() => []));
  const workspaceFor = vi.fn(options.workspaceFor ?? (() => '/private-workspace'));
  const setThread = vi.fn(options.setThread ?? (async () => {}));
  const replyTemplateCard = vi.fn(async () => {});
  const updateTemplateCard = vi.fn(async () => {});
  const deliverControlCard = vi.fn(async () => {});
  const sessionStore = {
    sessionsFor,
    workspaceFor,
    setThread,
  } as unknown as WeComConversationBindings;
  const instance = new NavigationController({
    sessionStore,
    navigationCards: registry,
    configuredWorkspaces: [],
    navigationCardTtlMs: 60_000,
    startupModel: 'gpt-test',
    configuredModelAllowlist: [],
    conversationAgentPreferences: new Map(),
    createNavigationTaskId: () => 'session_test',
    effectiveModel: () => 'gpt-test',
    effectiveReasoningEffort: () => 'low',
    currentThreadId: () => undefined,
    isConversationBusy: () => options.busy ?? false,
    recentTaskHint: () => undefined,
    replyTemplateCard,
    updateTemplateCard,
    deliverControlCard,
    replyControl: vi.fn(async () => {}),
    replyOnce: vi.fn(async () => {}),
  });
  return {
    instance,
    registry,
    sessionsFor,
    workspaceFor,
    setThread,
    replyTemplateCard,
    updateTemplateCard,
    deliverControlCard,
  };
}

describe('WeCom resume privacy', () => {
  it('restores the registered full ID in private chat and rejects a fingerprint', async () => {
    const registry = new WeComNavigationCardRegistry();
    registry.register({
      taskId: 'session_private',
      purpose: 'session',
      conversationKey: 'single:u',
      optionLabels: new Map([['thread-alpha-secret', 'private prompt']]),
      expiresAt: Date.now() + 60_000,
    });
    const h = controller({
      registry,
      sessionsFor: () => [{ threadId: 'thread-alpha-secret', updatedAt: 1, status: 'active' }],
    });

    await h.instance.handleNavigationCardEvent(
      {} as never,
      'single:u',
      'session_private',
      'session',
      'session.resume',
      '#a1b2c3',
    );
    expect(h.setThread).not.toHaveBeenCalled();

    await h.instance.handleNavigationCardEvent(
      {} as never,
      'single:u',
      'session_private',
      'session',
      'session.resume',
      'thread-alpha-secret',
    );
    expect(h.setThread).toHaveBeenCalledOnce();
    expect(h.setThread).toHaveBeenCalledWith('single:u', 'thread-alpha-secret');
  });

  it('blocks group history before querying or rendering private candidates', async () => {
    const h = controller({
      sessionsFor: () => [{ threadId: 'thread-alpha-secret', updatedAt: 1, status: 'active' }],
      workspaceFor: () => '/private-workspace',
    });

    await h.instance.replySessionSelection({ body: { chattype: 'group', chatid: 'g' } } as never, 'group:g');

    expect(h.sessionsFor).not.toHaveBeenCalled();
    expect(h.workspaceFor).not.toHaveBeenCalled();
    expect(h.replyTemplateCard).toHaveBeenCalledOnce();
    const text = JSON.stringify(h.replyTemplateCard.mock.calls);
    expect(text).toContain('私聊');
    for (const secret of ['private-workspace', 'thread-alpha-secret']) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/#[a-f0-9]{6}/);
  });

  it('also blocks an inferred group conversation without chattype', async () => {
    const h = controller();
    await h.instance.replySessionSelection({ body: { chatid: 'g' } } as never, 'group:g');
    expect(h.sessionsFor).not.toHaveBeenCalled();
    expect(h.workspaceFor).not.toHaveBeenCalled();
    expect(h.replyTemplateCard).toHaveBeenCalledOnce();
  });

  it('preserves private-chat candidates and full callback IDs', async () => {
    const h = controller({
      sessionsFor: () => [{ threadId: 'thread-alpha-secret', updatedAt: 1, status: 'active' }],
    });

    await h.instance.replySessionSelection({ body: { chattype: 'single' } } as never, 'single:u');

    expect(h.sessionsFor).toHaveBeenCalledWith('single:u');
    expect(h.replyTemplateCard).toHaveBeenCalledOnce();
    const card = (h.replyTemplateCard.mock.calls as unknown as Array<[unknown, {
      button_selection?: { option_list?: Array<{ id: string }> };
    }]>)[0]?.[1];
    expect(card?.button_selection?.option_list?.[0]?.id).toBe('thread-alpha-secret');
    const resolved = h.registry.resolve('session_test', 'single:u');
    expect(resolved.status).toBe('resolved');
    if (resolved.status === 'resolved') {
      expect(resolved.card.payload?.optionLabels.has('thread-alpha-secret')).toBe(true);
    }
  });

  it('rejects a registered candidate whose ownership no longer matches the current scope', async () => {
    const registry = new WeComNavigationCardRegistry();
    registry.register({
      taskId: 'session_stale',
      purpose: 'session',
      conversationKey: 'single:u',
      optionLabels: new Map([['someone-elses-thread', 'old entry']]),
      expiresAt: Date.now() + 60_000,
    });
    const h = controller({
      registry,
      sessionsFor: () => [{ threadId: 'own-thread', updatedAt: 1, status: 'active' }],
    });

    await h.instance.handleNavigationCardEvent(
      {} as never,
      'single:u',
      'session_stale',
      'session',
      'session.resume',
      'someone-elses-thread',
    );

    expect(h.setThread).not.toHaveBeenCalled();
    expect(h.updateTemplateCard).toHaveBeenCalledOnce();
  });

  it('rejects an old group session callback before resolving or consuming it', async () => {
    const resolve = vi.fn();
    const h = controller();
    const fake = new NavigationController({
      sessionStore: { setThread: h.setThread } as unknown as WeComConversationBindings,
      navigationCards: { resolve } as unknown as WeComNavigationCardRegistry,
      configuredWorkspaces: [],
      navigationCardTtlMs: 60_000,
      startupModel: 'gpt-test',
      configuredModelAllowlist: [],
      conversationAgentPreferences: new Map(),
      createNavigationTaskId: () => 'session_test',
      effectiveModel: () => 'gpt-test',
      effectiveReasoningEffort: () => 'low',
      currentThreadId: () => undefined,
      isConversationBusy: () => false,
      recentTaskHint: () => undefined,
      replyTemplateCard: vi.fn(async () => {}),
      updateTemplateCard: h.updateTemplateCard,
      deliverControlCard: vi.fn(async () => {}),
      replyControl: vi.fn(async () => {}),
      replyOnce: vi.fn(async () => {}),
    });

    await fake.handleNavigationCardEvent(
      {} as never,
      'group:g',
      'session_old',
      'session',
      'session.resume',
      'thread-alpha-secret',
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(h.setThread).not.toHaveBeenCalled();
    expect(h.updateTemplateCard).toHaveBeenCalledOnce();
  });
});
