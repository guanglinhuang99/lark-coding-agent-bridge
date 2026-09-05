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

import { TaskLedger } from '../../../src/bridge/task-ledger';
import { writeFileAtomic } from '../../../src/platform/atomic-write';

async function startDurable(h: Awaited<ReturnType<typeof createHarness>>, ledger?: TaskLedger) {
  const bridge = await startChannel({
    cfg: h.profileConfig, agent: h.agent, sessions: h.sessions, workspaces: h.workspaces,
    controls: h.controls, taskLedger: ledger,
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
    const file = join(h.tmp.profile, 'tasks.json');
    const ledger = new TaskLedger(file, { namespace: 'lark' }); await ledger.load();
    const bridge = await startDurable(h, ledger);
    await h.channel.handlers.message!(input('done', 'first'));
    await waitFor(() => ledger.snapshot().done === 2, 5000);
    await bridge.disconnect();
    const reopened = new TaskLedger(file, { namespace: 'lark' }); await reopened.load();
    await startDurable(h, reopened);
    await h.channel.handlers.message!(input('done', 'first'));
    await h.channel.handlers.message!(input('next', 'second'));
    await waitFor(() => reopened.snapshot().done === 4, 5000);
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
} = {}):Promise<{
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
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

function createFakeLarkChannel(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
} = {}):FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const sent: Array<{ chatId: string; content: unknown; options: unknown }> = [];
  const streams: Array<{ chatId: string; options: unknown }> = [];
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? {
    om_topic_root: 'topic root content',
  };
  const rawThreadIds = options.rawThreadIds ?? {};
  const threadMessages = options.threadMessages ?? [];
  return {
    handlers,
    sent,
    streams,
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
        body: {
          content: JSON.stringify({
            text: quotedMessages[messageId] ?? 'quoted content',
          }),
        },
        create_time: '1760000000000',
        sender: { id: 'ou_quote_sender' },
        ...(rawThreadIds[messageId] ? { thread_id: rawThreadIds[messageId] } : {}),
      },
    ]),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(chatId, input, options) {
      streams.push({ chatId, options });
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
      return { messageId: `om_stream_${streams.length}` };
    },
    recallMessage: vi.fn(async () => {}),
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
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
    messageId: input.messageId,
    chatId: 'oc_topic_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: input.rawContentType ?? 'text',
    resources: [],
    mentions:
      input.mentions ??
      (mentionedBot
        ? [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }]
        : [{ key: '@_user_1', openId: 'ou_human', name: '同事', isBot: false }]),
    mentionAll: false,
    mentionedBot,
    rootId: input.rootId,
    parentId: input.parentId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    replyToMessageId: input.parentId,
    createTime: 1760000001000,
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
