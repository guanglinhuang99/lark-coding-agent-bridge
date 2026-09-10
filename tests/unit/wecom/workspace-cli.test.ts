import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationKey } from '../../../src/wecom/runtime';
import { parseWeComCommand, shouldUseRiskFastPath } from '../../../src/wecom/commands';
import { WeComConversationBindings } from '../../../src/wecom/conversation-bindings';
import { NavigationController } from '../../../src/wecom/navigation-controller';
import { WeComNavigationCardRegistry } from '../../../src/wecom/ui/navigation-registry';
import { navigationActionForPurpose } from '../../../src/wecom/card-routing';

const source = readFileSync('src/wecom/cli.ts', 'utf8');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function loadFunction<T extends (...args: any[]) => any>(
  start: string,
  end: string,
  name: string,
  context: Record<string, unknown>,
): T {
  const block = source.slice(source.indexOf(start), source.indexOf(end));
  const output = ts.transpileModule(
    `${block}\nglobalThis.__selected = ${name};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  vm.runInNewContext(output, context);
  return context.__selected as T;
}

function frame(body: Record<string, unknown>): { body: Record<string, unknown> } {
  return { body };
}

describe('WeCom workspace scope at CLI boundaries', () => {
  it('switches a busy group through the real workspace card handler and preserves its old thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-cli-switch-'));
    tempDirs.push(root);
    const review = join(root, 'review'); await mkdir(review);
    const store = new WeComConversationBindings(join(root, 'sessions.json'), {
      identity: { channel: 'wecom', accountId: 'bot', instanceId: root },
      workspace: root, policyFingerprint: 'policy',
    });
    await store.load();
    const original = store.captureScope('group:room');
    await store.setThread(original, 'original-thread');
    const registry = new WeComNavigationCardRegistry();
    registry.register({ taskId: 'workspace_1', purpose: 'workspace', conversationKey: original,
      optionLabels: new Map([['review', '审核']]), expiresAt: Date.now() + 60_000 });
    const navigation = new NavigationController({
      sessionStore: store,
      navigationCards: registry,
      configuredWorkspaces: [{ id: 'review', name: '审核', cwd: review }],
      navigationCardTtlMs: 60_000,
      startupModel: 'gpt-test',
      configuredModelAllowlist: [],
      conversationAgentPreferences: new Map(),
      createNavigationTaskId: () => 'workspace_test',
      effectiveModel: () => 'gpt-test',
      effectiveReasoningEffort: () => 'low',
      currentThreadId: () => undefined,
      isConversationBusy: () => true,
      recentTaskHint: () => undefined,
      replyTemplateCard: vi.fn(async () => {}),
      updateTemplateCard: vi.fn(async () => {}),
      deliverControlCard: vi.fn(async () => {}),
      replyControl: vi.fn(async () => {}),
      replyOnce: vi.fn(async () => {}),
    });
    const replyNavigationResult = vi.spyOn(navigation, 'replyNavigationResult');
    await navigation.handleNavigationCardEvent(
      frame({}) as never,
      original,
      'workspace_1',
      'workspace',
      navigationActionForPurpose('workspace'),
      'review',
    );
    const selected = store.captureScope('group:room');
    expect(selected).not.toBe(original);
    expect(store.threadId(selected)).toBeUndefined();
    expect(store.threadId(original)).toBe('original-thread');
    expect(replyNavigationResult.mock.calls[0]?.[1]).toBe(selected);
    expect(store.captureScope('group:another-room')).not.toBe(selected);
    expect(store.workspaceFor('single:alice')).toBe(root);
  });
  it('captures scope before claim await and replays the task-owned scope', async () => {
    const events: string[] = [];
    const captured = 'group:workspace-v1:["group:room","/new"]';
    const replayed = 'group:workspace-v1:["group:room","/old"]';
    const handleMessage = vi.fn(async () => {});
    const context: Record<string, unknown> = {
      conversationKey,
      sessionStore: {
        captureScope: vi.fn((scope: string) => {
          events.push(`capture:${scope}`);
          return captured;
        }),
        conversationScope: vi.fn((scope: string) => scope.includes('workspace-v1:') ? 'group:room' : scope),
      },
      taskStore: {
        claimInbound: vi.fn(async (_messageId: string, scope: string) => {
          events.push(`claim:${scope}`);
          return {
            accepted: true,
            replayed: true,
            task: { id: 'task-1', conversationKey: replayed, status: 'queued' },
          };
        }),
        markDone: vi.fn(async () => {}),
      },
      messageDeduplicator: { claim: vi.fn(() => { events.push('dedupe'); return true; }) },
      handleMessage,
      isWorkspaceScope: (value: string) => value.startsWith('group:workspace-v1:'),
      log: { info: vi.fn(), fail: vi.fn() },
      reportMetric: vi.fn(),
      replyOnce: vi.fn(async () => {}),
    };
    const processMessageEvent = loadFunction<(
      input: { body?: Record<string, unknown> },
    ) => Promise<void>>(
      'async function processMessageEvent',
      'async function handleMessage',
      'processMessageEvent',
      context,
    );

    await processMessageEvent(frame({
      msgid: 'msg-1',
      chattype: 'group',
      chatid: 'room',
      from: { userid: 'alice' },
    }));

    expect(events.slice(0, 2)).toEqual([
      'capture:group:room',
      `claim:${captured}`,
    ]);
    expect(handleMessage).toHaveBeenCalledWith(expect.anything(), 'task-1', replayed);
    expect(context.messageDeduplicator).toBeDefined();
  });

  it('keeps a queued message on its captured key after the chat switches workspace', async () => {
    const oldKey = 'single:workspace-v1:["single:alice","/old"]';
    const executedKeys: string[] = [];
    let queuedKey: string | undefined;
    let queuedTask: (() => Promise<void>) | undefined;
    let resolveCompletion!: () => void;
    let currentWorkspace = '/old';
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const context: Record<string, unknown> = {
      sessionStore: {
        captureScope: vi.fn((scope: string) => scope),
        workspaceFor: vi.fn(() => currentWorkspace),
      },
      textFromWeComMessage: vi.fn(() => 'hello'),
      normalizeIncomingText: vi.fn((value: string) => value),
      collectWeComMediaInputs: vi.fn(() => []),
      parseWeComCommand,
      shouldUseRiskFastPath: vi.fn(() => false),
      isPretradeIntentCandidate: vi.fn(() => false),
      classifyTask: vi.fn(),
      taskStore: { annotate: vi.fn(async () => {}) },
      riskStates: { hasPendingOrExpired: vi.fn(() => false) },
      conversationQueue: {
        submit: vi.fn((key: string, task: () => Promise<void>) => {
          queuedKey = key;
          queuedTask = task;
          return {
            queued: true,
            position: 1,
            completion,
            cancel: vi.fn(() => false),
          };
        }),
        queued: vi.fn(() => 1),
        has: vi.fn(() => true),
      },
      conversationQueueTimeoutMs: 5_000,
      streamMaxBytes: 4_000,
      renderWeComAcknowledgement: vi.fn(() => 'ack'),
      renderWeComNotice: vi.fn((_title: string, lines: string[]) => lines.join('\n')),
      truncateUtf8: vi.fn((value: string) => value),
      WeComStreamReply: class {
        async finish(): Promise<boolean> { return true; }
        async start(): Promise<void> {}
        async startWithCard(): Promise<boolean> { return false; }
      },
      client: {},
      generateReqId: vi.fn(() => 'req'),
      createTaskId: vi.fn(() => 'task'),
      createQueueTaskId: vi.fn(() => 'queue-task'),
      registerControlCard: vi.fn(),
      currentThreadId: vi.fn(),
      conversationQueueNotice: vi.fn(() => 'queued'),
      buildQueueCardView: vi.fn(() => ({})),
      deliverCardView: vi.fn(async () => {}),
      deliverErrorCard: vi.fn(async () => {}),
      executeConversationMessage: vi.fn(async (_frame: unknown, key: string) => {
        executedKeys.push(key);
      }),
      log: { info: vi.fn(), fail: vi.fn() },
      reportMetric: vi.fn(),
      failureKind: vi.fn(() => 'failed'),
      WeComConversationQueueError: class extends Error {},
    };
    const handleMessage = loadFunction<(
      input: { body?: Record<string, unknown> },
      durableTaskId?: string,
      capturedScope?: string,
    ) => Promise<void>>(
      'async function handleMessage',
      'async function executeConversationMessage',
      'handleMessage',
      context,
    );

    const pending = handleMessage(
      frame({ chattype: 'single', from: { userid: 'alice' } }),
      undefined,
      oldKey,
    );
    for (let attempt = 0; attempt < 20 && !queuedTask; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(queuedKey).toBe(oldKey);
    currentWorkspace = '/new';
    await queuedTask!();
    resolveCompletion();
    await pending;
    expect(executedKeys).toEqual([oldKey]);
  });

  it('allows a workspace command while the current scope is busy', async () => {
    const key = 'group:workspace-v1:["group:room","/old"]';
    const applyWorkspaceSelection = vi.fn(async () => {});
    const context: Record<string, unknown> = {
      sessionStore: {
        captureScope: vi.fn(() => key),
        workspaceFor: vi.fn(() => '/old'),
      },
      textFromWeComMessage: vi.fn(() => '/workspace review'),
      normalizeIncomingText: vi.fn((value: string) => value),
      collectWeComMediaInputs: vi.fn(() => []),
      parseWeComCommand,
      isPretradeIntentCandidate: vi.fn(() => false),
      taskStore: {},
      navigation: { applyWorkspaceSelection },
      activeRuns: new Map([[key, {}]]),
      startingRuns: new Set([key]),
      conversationQueue: { has: vi.fn(() => true) },
    };
    const handleMessage = loadFunction<(
      input: { body?: Record<string, unknown> },
      durableTaskId?: string,
      capturedScope?: string,
    ) => Promise<void>>(
      'async function handleMessage',
      'async function executeConversationMessage',
      'handleMessage',
      context,
    );

    await handleMessage(frame({ chattype: 'group', chatid: 'room' }), undefined, key);
    expect(applyWorkspaceSelection).toHaveBeenCalledWith(expect.anything(), key, 'review');
  });

  it('uses one key for group members and separate keys for private chats', () => {
    const aliceGroup = conversationKey({ chattype: 'group', chatid: 'room', from: { userid: 'alice' } });
    const bobGroup = conversationKey({ chattype: 'group', chatid: 'room', from: { userid: 'bob' } });
    const alicePrivate = conversationKey({ chattype: 'single', from: { userid: 'alice' } });
    const bobPrivate = conversationKey({ chattype: 'single', from: { userid: 'bob' } });
    expect(aliceGroup).toBe(bobGroup);
    expect(alicePrivate).not.toBe(bobPrivate);
  });

  it('rejects an unregistered or mismatched legacy control card', async () => {
    const updateInvalidCallback = vi.fn(async () => {});
    const taskId = 'codex_1';
    const context: Record<string, unknown> = {
      controlCardScopes: new Map(),
      navigation: { updateInvalidCallback },
      Date,
    };
    const handleLegacyControlCardEvent = loadFunction<(
      input: unknown,
      key: string,
      taskId: string,
      action?: string,
    ) => Promise<void>>(
      'async function handleLegacyControlCardEvent',
      'async function replyDoctor',
      'handleLegacyControlCardEvent',
      context,
    );

    const input = frame({});
    await handleLegacyControlCardEvent(input, 'single:workspace-v1:["single:alice","/new"]', taskId, 'stop');
    context.controlCardScopes = new Map([
      [taskId, { key: 'single:workspace-v1:["single:alice","/old"]', expiresAt: Date.now() + 60_000 }],
    ]);
    await handleLegacyControlCardEvent(input, 'single:workspace-v1:["single:alice","/new"]', taskId, 'stop');
    expect(updateInvalidCallback).toHaveBeenCalledTimes(2);
  });

  it('lists only current chat threads in resume selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-cli-resume-'));
    tempDirs.push(root);
    const other = join(root, 'other');
    await mkdir(other);
    const identity = { channel: 'wecom' as const, accountId: 'bot', instanceId: root };
    const store = new WeComConversationBindings(join(root, 'sessions.json'), {
      identity,
      workspace: root,
      policyFingerprint: 'policy',
    });
    await store.load();
    const alice = conversationKey({ chattype: 'single', from: { userid: 'alice' } });
    const bob = conversationKey({ chattype: 'single', from: { userid: 'bob' } });
    await store.setThread(store.captureScope(alice), 'thread-alice');
    await store.setThread(store.captureScope(bob), 'thread-bob');

    const registry = new WeComNavigationCardRegistry();
    const replyTemplateCard = vi.fn(async () => {});
    const navigation = new NavigationController({
      sessionStore: store,
      navigationCards: registry,
      configuredWorkspaces: [],
      navigationCardTtlMs: 60_000,
      startupModel: 'gpt-test',
      configuredModelAllowlist: [],
      conversationAgentPreferences: new Map(),
      createNavigationTaskId: () => 'session_1',
      effectiveModel: () => 'gpt-test',
      effectiveReasoningEffort: () => 'low',
      currentThreadId: () => undefined,
      isConversationBusy: () => false,
      recentTaskHint: () => undefined,
      replyTemplateCard,
      updateTemplateCard: vi.fn(async () => {}),
      deliverControlCard: vi.fn(async () => {}),
      replyControl: vi.fn(async () => {}),
      replyOnce: vi.fn(async () => {}),
    });

    const aliceScope = store.captureScope(alice);
    await navigation.replySessionSelection(frame({}) as never, aliceScope);
    expect(replyTemplateCard).toHaveBeenCalledOnce();
    const card = (replyTemplateCard.mock.calls as unknown as Array<[unknown, {
      button_selection?: { option_list?: Array<{ id: string }> };
    }]>)[0]?.[1];
    expect(card?.button_selection?.option_list?.map((entry) => entry.id)).toEqual(['thread-alice']);
    const registered = registry.resolve('session_1', aliceScope);
    expect(registered.status).toBe('resolved');
    if (registered.status === 'resolved') {
      expect([...registered.card.payload!.optionLabels.keys()]).toEqual(['thread-alice']);
    }
  });
});
