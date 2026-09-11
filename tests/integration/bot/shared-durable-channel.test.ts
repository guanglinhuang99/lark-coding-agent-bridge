import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';
import { TaskLedger } from '../../../src/bridge/task-ledger';
import { RiskApplication } from '../../../src/business/risk/application';
import { businessConversationKey, businessWorkspaceScope } from '../../../src/business/identity';
import type { RiskIntentState } from '../../../src/business/risk/intent';
import type { RiskService } from '../../../src/business/risk/client';
import { createLarkRiskAdapter, type LarkRiskAdapter } from '../../../src/bot/risk-adapter';
import { writeFileAtomic } from '../../../src/platform/atomic-write';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  reconnected?: () => void;
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  sent: Array<{ chatId: string; content: unknown; options: unknown }>;
  streams: Array<{ chatId: string; options: unknown }>;
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        message: {
          list: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  recallMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startDurable(h: Awaited<ReturnType<typeof createHarness>>, ledger?: TaskLedger, riskAdapter?: LarkRiskAdapter) {
  const bridge = await startChannel({
    cfg: h.profileConfig, agent: h.agent, sessions: h.sessions, workspaces: h.workspaces,
    controls: h.controls, taskLedger: ledger, riskAdapter,
    appPaths: {
      sessionsFile: join(h.tmp.profile, 'sessions.json'),
      workspacesFile: join(h.tmp.profile, 'workspaces.json'),
      mediaDir: join(h.tmp.profile, 'media'), secretsFile: join(h.tmp.profile, 'secrets.json'),
      keystoreSaltFile: join(h.tmp.profile, 'keystore-salt'),
    },
  });
  cleanups.push(() => bridge.disconnect());
  return bridge;
}
function input(id: string, content: string) {
  return message({ messageId: id, rootId: id, parentId: id, content });
}

describe('Lark production channel with shared durable state', () => {
  it.each(['confirmed', 'cancelled'] as const)('owns post-terminal confirmations through the real intake: %s', async terminal => {
    const h = await createHarness({ chatMode: 'group' });
    const calculatePretrade = vi.fn(async () => ({ status: 'success', result: {} }));
    const application = new RiskApplication({ service: { calculatePretrade } as unknown as RiskService });
    const identity = { channel: 'lark' as const, accountId: 'test', instanceId: 'test' };
    const adapter = createLarkRiskAdapter({ application, env: {}, authorized: () => true, identity,
      stateDir: h.tmp.profile, pool: {} as never, activeRuns: {} as never, channel: h.channel as never });
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), { namespace: 'lark' });
    await ledger.load();
    await startDurable(h, ledger, adapter);
    const key = businessConversationKey(identity, businessWorkspaceScope('oc_topic_chat', h.profileConfig.workspaces.default), 'ou_user');
    application.states.setPretrade(key, { stage: 'confirm', product: '测试账户', originalText: '测试账户申购100万',
      draft: { accountQuery: '测试账户', action: 'subscription', amountText: '100万', market: 'secondary' } });
    await h.channel.handlers.message!(input('terminal-action', terminal === 'confirmed' ? '确认' : '/stop'));
    if (terminal === 'cancelled') expect(JSON.stringify(h.channel.sent)).toContain('已取消风险交互');
    const priorReplies = h.channel.sent.length;
    await h.channel.handlers.message!(input('late-confirmation', '确认'));
    expect(h.channel.sent.length).toBeGreaterThan(priorReplies);
    expect(JSON.stringify(h.channel.sent.slice(priorReplies))).toContain(terminal === 'confirmed' ? '不会重复' : '已取消');
    expect(ledger.snapshot()).toMatchObject({ queued: 0, running: 0 });
    expect(calculatePretrade).toHaveBeenCalledTimes(terminal === 'confirmed' ? 1 : 0);
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it.each(['chat-mode', 'topic'] as const)('fences confirmation arrival before scope resolution: %s', async stage => {
    const h = await createHarness({ chatMode: stage === 'topic' ? 'topic' : 'group',
      rawThreadIds: { 'early-confirm': 'thread-early', 'newer-correction': 'thread-early' } });
    const calculatePretrade = vi.fn(async () => ({ status: 'success', result: {} }));
    const application = new RiskApplication({ service: { calculatePretrade } as unknown as RiskService });
    const identity = { channel: 'lark' as const, accountId: 'test', instanceId: 'test' };
    const adapter = createLarkRiskAdapter({ application, env: {}, authorized: () => true, identity,
      stateDir: h.tmp.profile, pool: {} as never, activeRuns: {} as never, channel: h.channel as never });
    await startDurable(h, undefined, adapter);
    const scope = stage === 'topic' ? 'oc_topic_chat:thread-early' : 'oc_topic_chat';
    const key = businessConversationKey(identity, businessWorkspaceScope(scope, h.profileConfig.workspaces.default), 'ou_user');
    application.states.setPretrade(key, { stage: 'confirm', originalText: '测试账户申购1000万', product: '测试账户',
      draft: { accountQuery: '测试账户', action: 'subscription', amountText: '1000万', market: 'secondary' } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    if (stage === 'chat-mode') {
      vi.spyOn(h.channel, 'getChatMode').mockImplementationOnce(async () => { entered = true; await gate; return 'group'; });
    } else {
      const fetch = h.channel.fetchRawMessage.getMockImplementation()!;
      h.channel.fetchRawMessage.mockImplementation(async (...args) => {
        if (args[0] === 'early-confirm') { entered = true; await gate; }
        return fetch(...args);
      });
    }
    const pending = h.channel.handlers.message!(input('early-confirm', '确认'));
    await waitFor(() => entered);
    try {
      await h.channel.handlers.message!(input('newer-correction', '金额改为2000万'));
      expect(application.states.getPretrade(key)?.draft.amountText).toBe('2000万');
    } finally { release(); }
    await pending;
    expect(calculatePretrade).not.toHaveBeenCalled();
    expect(application.states.getPretrade(key)?.draft.amountText).toBe('2000万');
    expect(JSON.stringify(h.channel.sent)).toContain('已失效');
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it.each(['replaced', 'cancelled'] as const)('does not rebind a delayed confirmation after its draft is %s', async change => {
    const h = await createHarness({ chatMode: 'group' });
    const calculatePretrade = vi.fn(async () => ({ status: 'success', result: {} }));
    const service = { calculatePretrade } as unknown as RiskService;
    const application = new RiskApplication({ service });
    const identity = { channel: 'lark' as const, accountId: 'test', instanceId: 'test' };
    const riskAdapter = createLarkRiskAdapter({ application, env: {}, authorized: () => true,
      identity, stateDir: h.tmp.profile, pool: {} as never, activeRuns: {} as never, channel: h.channel as never });
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), { namespace: 'lark' });
    await ledger.load();
    await startDurable(h, ledger, riskAdapter);
    const key = businessConversationKey(identity,
      businessWorkspaceScope('oc_topic_chat', h.profileConfig.workspaces.default), 'ou_user');
    const original: RiskIntentState = { stage: 'confirm', originalText: '测试账户申购1000万', product: '测试账户',
      draft: { accountQuery: '测试账户', action: 'subscription', amountText: '1000万', market: 'secondary' } };
    application.states.setPretrade(key, original);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const claim = ledger.claimInbound.bind(ledger);
    vi.spyOn(ledger, 'claimInbound').mockImplementation(async (...args) => {
      if (args[0].includes('delayed-confirm')) { entered = true; await gate; }
      return claim(...args);
    });
    const pending = h.channel.handlers.message!(input('delayed-confirm', '确认'));
    await waitFor(() => entered);
    const replacement: RiskIntentState = { ...original, draft: { ...original.draft, amountText: '2000万' } };
    if (change === 'replaced') application.states.setPretrade(key, replacement);
    else application.cancel(key);
    release();
    await pending;
    expect(calculatePretrade).not.toHaveBeenCalled();
    expect(JSON.stringify(h.channel.sent)).toContain(change === 'replaced' ? '已失效' : '已停止');
    expect(application.states.getPretrade(key)).toBe(change === 'replaced' ? replacement : undefined);
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it.each(['duplicate', 'write-failed'] as const)('releases the captured business ingress when durable acceptance is %s', async outcome => {
    const h = await createHarness({ chatMode: 'group' });
    const release = vi.fn();
    const riskAdapter: LarkRiskAdapter = {
      capture: vi.fn(() => ({ accepted: true, release })),
      handle: vi.fn(async () => false), close: vi.fn(async () => {}),
    };
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), { namespace: 'lark' });
    await ledger.load();
    const original = await ledger.claimInbound('existing', 'scope');
    if (outcome === 'duplicate') vi.spyOn(ledger, 'claimInbound').mockResolvedValue({ ...original, accepted: false });
    else vi.spyOn(ledger, 'claimInbound').mockRejectedValue(new Error('synthetic write failure'));
    await startDurable(h, ledger, riskAdapter);
    await h.channel.handlers.message!(input('rejected-confirm', '确认'));
    expect(riskAdapter.capture).toHaveBeenCalledOnce();
    expect(riskAdapter.handle).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('invokes the common runtime on startup, connection recovery and shutdown', async () => {
    const h = await createHarness({ chatMode: 'group' });
    const riskAdapter: LarkRiskAdapter = { start: vi.fn(async () => {}),
      handle: vi.fn(async () => false), close: vi.fn(async () => {}) };
    const bridge = await startDurable(h, undefined, riskAdapter);
    expect(riskAdapter.start).toHaveBeenCalledTimes(2);
    h.channel.handlers.reconnected!();
    expect(riskAdapter.start).toHaveBeenCalledTimes(3);
    await bridge.disconnect();
    expect(riskAdapter.close).toHaveBeenCalledOnce();
    expect(h.agent.runOptions).toHaveLength(0);
  });
  it('closes the business runtime when platform connection fails', async () => {
    const h = await createHarness({ chatMode: 'group' });
    vi.spyOn(h.channel, 'connect').mockRejectedValueOnce(new Error('synthetic connection failure'));
    const riskAdapter: LarkRiskAdapter = { start: vi.fn(async () => {}),
      handle: vi.fn(async () => false), close: vi.fn(async () => {}) };
    await expect(startDurable(h, undefined, riskAdapter)).rejects.toThrow('synthetic connection failure');
    expect(riskAdapter.start).toHaveBeenCalledOnce();
    expect(riskAdapter.close).toHaveBeenCalledOnce();
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('dispatches business messages once through the actual authenticated durable intake', async () => {
    const h = await createHarness({ chatMode: 'group' });
    const service = { getCredit: vi.fn(async (entity: string) => ({
      entity, date: '2026-09-10',
      group_internal: { credit_limit_yuan: 100_000, used_credit_yuan: 20_000, remaining_credit_yuan: 80_000 },
      third_party: { credit_limit_yuan: null, used_credit_yuan: 0, remaining_credit_yuan: null },
    })) } as unknown as RiskService;
    const application = new RiskApplication({ service });
    const riskAdapter = createLarkRiskAdapter({ application, env: {}, authorized: () => true,
      identity: { channel: 'lark', accountId: 'test', instanceId: 'test' },
      stateDir: h.tmp.profile, pool: {} as never, activeRuns: {} as never, channel: h.channel as never });
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), { namespace: 'lark' });
    await ledger.load();
    await startDurable(h, ledger, riskAdapter);
    await Promise.all([
      h.channel.handlers.message!(input('credit-shared', '/授信 公司甲')),
      h.channel.handlers.message!(input('credit-shared', '/授信 公司甲')),
    ]);
    expect(service.getCredit).toHaveBeenCalledOnce();
    expect(service.getCredit).toHaveBeenCalledWith('公司甲');
    expect(h.agent.runOptions).toHaveLength(0);
    expect(ledger.snapshot()).toMatchObject({ done: 1, running: 0, queued: 0 });
    expect(JSON.stringify(h.channel.sent)).toContain('公司甲');
  });

  it('deduplicates redelivery without changing debounce batching of distinct messages', async () => {
    const h = await createHarness({ chatMode: 'group' });
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), { namespace: 'lark' }); await ledger.load();
    await startDurable(h, ledger);
    await Promise.all([
      h.channel.handlers.message!(input('a', 'alpha_unique')),
      h.channel.handlers.message!(input('a', 'alpha_unique')),
      h.channel.handlers.message!(input('b', 'beta_unique')),
    ]);
    await waitFor(() => ledger.snapshot().done === 3, 5000);
    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]!.prompt;
    expect(prompt.match(/alpha_unique/g)).toHaveLength(1);
    expect(prompt.match(/beta_unique/g)).toHaveLength(1);
    await h.channel.handlers.message!(input('a', 'alpha_unique'));
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('rejects the same delivered message after a disconnected channel restarts with a reopened ledger', async () => {
    const h = await createHarness({ chatMode: 'group' });
    // FakeAgentAdapter consumes one event list per run. Supply both turns: an
    // exhausted fixture yields no terminal event and correctly records a failure.
    h.agent.setEvents([
      [{ type: 'done', terminationReason: 'normal' }],
      [{ type: 'done', terminationReason: 'normal' }],
    ]);
    const file = join(h.tmp.profile, 'tasks.json');
    const ledger = new TaskLedger(file, { namespace: 'lark' }); await ledger.load();
    const bridge = await startDurable(h, ledger);
    await h.channel.handlers.message!(input('done', 'first'));
    await waitFor(() => ledger.snapshot().done === 2, 2000);
    await bridge.disconnect();
    const reopened = new TaskLedger(file, { namespace: 'lark' }); await reopened.load();
    await startDurable(h, reopened);
    await h.channel.handlers.message!(input('done', 'first'));
    await h.channel.handlers.message!(input('next', 'second'));
    await waitFor(() => reopened.snapshot().done === 4, 2000);
    expect(reopened.snapshot()).toMatchObject({ total: 4, done: 4, running: 0, queued: 0, failed: 0 });
    expect(h.agent.runOptions).toHaveLength(2);
  });

  it('does not launch an agent after a failed durable claim, and a repaired retry can proceed', async () => {
    const h = await createHarness({ chatMode: 'group' });
    let fail = true;
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), {
      namespace: 'lark', write: async (file, data, options) => {
        if (fail) throw new Error('ENOSPC');
        await writeFileAtomic(file, data, options);
      },
    });
    await ledger.load(); await startDurable(h, ledger);
    await h.channel.handlers.message!(input('retry', 'hello'));
    expect(h.agent.runOptions).toHaveLength(0);
    expect(JSON.stringify(h.channel.sent)).toContain('未执行');
    fail = false;
    await h.channel.handlers.message!(input('retry', 'hello'));
    await waitFor(() => ledger.snapshot().done === 2, 5000);
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('records a command-cancelled pending batch without replaying it', async () => {
    const h = await createHarness({ chatMode: 'group' });
    const ledger = new TaskLedger(join(h.tmp.profile, 'tasks.json'), { namespace: 'lark' }); await ledger.load();
    await startDurable(h, ledger);
    await h.channel.handlers.message!(input('pending', 'pending_work'));
    await h.channel.handlers.message!(input('command', '/new'));
    await waitFor(() => ledger.snapshot().interrupted === 1, 5000);
    await h.channel.handlers.message!(input('pending', 'pending_work'));
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(h.agent.runOptions).toHaveLength(0);
  });
});
async function createHarness(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
  agentEvents?: AgentEvent[];
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('topic-quote-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_topic_chat'],
      allowedUsers: ['ou_user'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: options.agentEvents ?? [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, agent, sessions, workspaces, profileConfig, controls };
}

function createFakeLarkChannel(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
} = {}): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const sent: Array<{ chatId: string; content: unknown; options: unknown }> = [];
  const streams: Array<{ chatId: string; options: unknown }> = [];
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? { om_topic_root: 'topic root content' };
  const rawThreadIds = options.rawThreadIds ?? {};
  const threadMessages = options.threadMessages ?? [];
  return {
    handlers, sent, streams,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          message: {
            list: vi.fn(async () => ({ data: { items: threadMessages, has_more: false } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async (messageId: string) => [
      {
        message_id: messageId,
        msg_type: 'text',
        body: { content: JSON.stringify({ text: quotedMessages[messageId] ?? 'quoted content' }) },
        create_time: '1760000000000',
        sender: { id: 'ou_quote_sender' },
        ...(rawThreadIds[messageId] ? { thread_id: rawThreadIds[messageId] } : {}),
      },
    ]),
    on(nextHandlers) { Object.assign(handlers, nextHandlers); },
    async connect() {},
    async disconnect() {},
    async getChatMode() { return chatMode; },
    getConnectionStatus() { return { state: 'connected', reconnectAttempts: 0 }; },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(chatId, input, options) {
      streams.push({ chatId, options });
      if (isMarkdownStreamInput(input)) await input.markdown({ setContent: async () => {} });
      return { messageId: `om_stream_${streams.length}` };
    },
    recallMessage: vi.fn(async () => {}),
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test', profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json', cfg: profileConfig, processId: 'proc_test',
  };
}

function message(input: {
  messageId: string;
  rootId: string;
  parentId: string;
  threadId?: string;
  content: string;
  rawContentType?: string;
  mentionedBot?: boolean;
  mentions?: Array<{ key: string; openId: string; name: string; isBot: boolean }>;
}): NormalizedMessage {
  const mentionedBot = input.mentionedBot ?? true;
  return {
    messageId: input.messageId, chatId: 'oc_topic_chat', chatType: 'group',
    senderId: 'ou_user', senderName: 'User', content: input.content,
    rawContentType: input.rawContentType ?? 'text', resources: [],
    mentions: input.mentions ?? (mentionedBot
      ? [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }]
      : [{ key: '@_user_1', openId: 'ou_human', name: '同事', isBot: false }]),
    mentionAll: false, mentionedBot, rootId: input.rootId, parentId: input.parentId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    replyToMessageId: input.parentId, createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}
function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}
async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
