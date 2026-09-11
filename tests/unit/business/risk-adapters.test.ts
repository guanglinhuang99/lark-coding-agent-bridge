import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { RiskApplication } from '../../../src/business/risk/application';
import { businessConversationKey, businessWorkspaceScope } from '../../../src/business/identity';
import { RiskProgressRelay } from '../../../src/business/risk/progress';
import { createLarkRiskAdapter, splitLarkRiskMessage } from '../../../src/bot/risk-adapter';
import { RiskInteractionController } from '../../../src/wecom/risk/interaction';
import { RiskSelectionTaskRegistry } from '../../../src/wecom/risk/card';
import { truncateUtf8 } from '../../../src/wecom/presentation';
import { parseBusinessCommand } from '../../../src/business/commands';
import type { RiskService } from '../../../src/business/risk/client';

const product = '测试账户';
const security = { code: '100115.SZ', name: '测试国债', label: '测试国债 100115.SZ' };
const applications: RiskApplication[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });
function backend(): RiskService {
  return { listProducts: vi.fn(async () => [product]), searchSecurities: vi.fn(async () => [security]),
    calculatePretrade: vi.fn(async () => ({ status: 'success', result: {} })),
    getRestrictions: vi.fn(async () => ({ product, investment_restrictions: [] })),
    getHoldings: vi.fn(async () => ({ holdings: [] })), getCredit: vi.fn(async entity => ({ entity })),
    checkSecurity: vi.fn(async () => ({ hit: false })), checkCounterparty: vi.fn(async () => ({ hit: false })) };
}
function fixture(channel: 'wecom' | 'lark') {
  const service = backend();
  const app = new RiskApplication({ service }); applications.push(app);
  const identity = { channel, accountId: 'bot', instanceId: 'test' };
  const keyFor = (scope: string, actor: string, workspace?: string) => businessConversationKey(identity,
    channel === 'lark' ? businessWorkspaceScope(scope, workspace) : scope, actor);
  const messages: string[] = [];
  let sequence = 0;
  if (channel === 'lark') {
    const adapter = createLarkRiskAdapter({ application: app, identity, stateDir: '/unused-test-state',
      pool: {} as never, activeRuns: {} as never, env: {}, authorized: () => true,
      channel: { send: vi.fn(async (_chat: string, message: { markdown: string }) => { messages.push(message.markdown); }) } as never });
    return { app, service, messages, keyFor, send: (text: string, actor = 'owner', workspace?: string) => adapter.handle({
      content: text, chatId: 'room', senderId: actor, messageId: `m-${++sequence}`, resources: [], chatType: 'group',
      rawContentType: 'text', mentions: [], mentionAll: false, mentionedBot: true, createTime: 1760000001000,
    } satisfies NormalizedMessage, 'room', workspace) };
  }
  const controller = new RiskInteractionController({ application: app, riskClient: service, riskRouter: app.router,
    riskStates: app.states, riskSelectionTasks: new RiskSelectionTaskRegistry(),
    conversationQueue: {} as never, runGate: { run: async fn => fn() }, startingRuns: new Set(),
    streamMaxBytes: 4000, selectionCardDelayMs: 0, refreshHealth: async () => {}, isRiskUserAllowed: () => true,
    updateTemplateCard: async () => {}, sendControlCardMessage: async () => {},
    sendMarkdownMessage: async (_body, content) => { messages.push(content); }, createRiskTaskId: () => `risk-${++sequence}` });
  // Load the actual private entrypoint, without evaluating CLI startup or secrets.
  const source = readFileSync('src/wecom/cli.ts', 'utf8');
  const block = source.slice(source.indexOf('async function executeConversationMessage('), source.indexOf('function isWorkspaceScope('));
  const context: Record<string, any> = { Date, Buffer, RiskProgressRelay, truncateUtf8, riskKeyFor: keyFor,
    parseWeComCommand: parseBusinessCommand,
    riskApplication: app, riskInteraction: controller, riskClient: service, riskRouter: app.router,
    riskStates: app.states, startingRuns: new Set(), isRiskUserAllowed: () => true,
    withReservation: async (_set: unknown, _key: string, fn: () => Promise<void>) => fn(),
    runGate: { run: async (fn: () => Promise<void>) => fn() }, refreshHealth: async () => {},
    reportMetric: vi.fn(), log: { info: vi.fn(), fail: vi.fn() }, streamMaxBytes: 4000,
    RiskIntentInterruptedError: class extends Error {},
    renderWeComNotice: (title: string, lines: string[]) => [title, ...lines].join('\n'),
  };
  vm.runInNewContext(ts.transpileModule(block + '\nglobalThis.execute = executeConversationMessage;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return { app, service, messages, keyFor, send: async (text: string, actor = 'owner', _workspace?: string) => {
    await context.execute({ body: { chattype: 'group', chatid: 'room', from: { userid: actor } } }, 'room', text, [],
      { update: async () => {}, finish: async (content: string) => { messages.push(content); return true; } },
      true, false, text.startsWith('/测算'), 'test-task', false);
    return true;
  } };
}

describe('real business channel adapters', () => {
  it.each(['wecom', 'lark'] as const)('%s uses the shared confirmation flow and identical backend action', async channel => {
    const api = fixture(channel);
    await api.send(`/测算 ${product} 买入 1000万 ${security.code}`);
    expect(api.service.calculatePretrade).not.toHaveBeenCalled();
    expect(api.app.states.getPretrade(api.keyFor('room', 'owner'))?.stage).toBe('confirm');
    expect(api.messages.join('\n')).toContain('1000万');
    await api.send('确认');
    expect(api.service.calculatePretrade).toHaveBeenCalledOnce();
    expect(vi.mocked(api.service.calculatePretrade).mock.calls[0]?.slice(0, 2)).toEqual([
      product, { type: 'buy', market: 'secondary', amount: 0.1, security_name: security.code },
    ]);
  });
  it('Lark routes a direct query without invoking the generic agent', async () => {
    const api = fixture('lark');
    expect(await api.send(`/测算 ${product}有哪些风险限额`)).toBe(true);
    expect(api.service.getRestrictions).toHaveBeenCalledWith(product);
  });
  it('Lark rejects cross-user confirmation and preserves the owner draft', async () => {
    const api = fixture('lark');
    await api.send(`/测算 ${product} 买入 1000万 ${security.code}`);
    expect(await api.send('确认', 'someone-else')).toBe(false);
    expect(api.service.calculatePretrade).not.toHaveBeenCalled();
    expect(api.app.states.has(api.keyFor('room', 'owner'))).toBe(true);
  });
  it('Lark stop clears pending business state and leaves the generic stop command available', async () => {
    const api = fixture('lark');
    await api.send(`/测算 ${product} 买入 1000万 ${security.code}`);
    expect(await api.send('/stop')).toBe(false);
    expect(api.app.states.has(api.keyFor('room', 'owner'))).toBe(false);
    expect(api.service.calculatePretrade).not.toHaveBeenCalled();
  });
  it('Lark cannot confirm a draft after switching workspace', async () => {
    const api = fixture('lark');
    await api.send(`/测算 ${product} 买入 1000万 ${security.code}`, 'owner', '/old-workspace');
    expect(await api.send('确认', 'owner', '/new-workspace')).toBe(false);
    expect(api.service.calculatePretrade).not.toHaveBeenCalled();
    expect(api.app.states.has(api.keyFor('room', 'owner', '/old-workspace'))).toBe(true);
  });

  it('Lark default authorization denies business access even with an injected service', async () => {
    const service = backend(), app = new RiskApplication({ service }); applications.push(app);
    const send = vi.fn();
    const adapter = createLarkRiskAdapter({ application: app, env: {}, pool: {} as never, activeRuns: {} as never,
      identity: { channel: 'lark', accountId: 'test', instanceId: 'test' }, stateDir: '/unused-test-state',
      channel: { send } as never });
    await adapter.handle({ content: '/授信 公司甲', chatId: 'room', senderId: 'not-allowed', resources: [], messageId: 'm',
      chatType: 'group', rawContentType: 'text', mentions: [], mentionAll: false, mentionedBot: true, createTime: 1760000001000,
    } satisfies NormalizedMessage, 'room');
    expect(service.getCredit).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1].markdown).toContain('没有风险查询权限');
  });
  it('paginates multilingual results without losing content or splitting Unicode characters', () => {
    const text = '风险结果🙂\n'.repeat(2000);
    const pages = splitLarkRiskMessage(text, 4000);
    expect(pages.join('')).toBe(text);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every(page => Buffer.byteLength(page) <= 4000)).toBe(true);
  });
});
