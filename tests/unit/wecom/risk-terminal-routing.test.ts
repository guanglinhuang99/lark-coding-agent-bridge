import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiskApplication } from '../../../src/business/risk/application';
import { businessConversationKey } from '../../../src/business/identity';
import { parseBusinessCommand } from '../../../src/business/commands';
import { RiskProgressRelay } from '../../../src/business/risk/progress';
import { RiskInteractionController } from '../../../src/wecom/risk/interaction';
import { RiskSelectionTaskRegistry } from '../../../src/wecom/risk/card';
import { renderWeComNotice, truncateUtf8 } from '../../../src/wecom/presentation';
import type { RiskService } from '../../../src/business/risk/client';
import { withTimeout } from '../../../src/bridge/reliability';

const apps: RiskApplication[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.useRealTimers(); });
const trade = '/测算 测试账户 申购 100万';
function setup() {
  const source = readFileSync('src/wecom/cli.ts', 'utf8');
  const handler = source.slice(source.indexOf('async function handleMessage'), source.indexOf('async function executeConversationMessage'));
  const execute = source.slice(source.indexOf('async function executeConversationMessage'), source.indexOf('function isWorkspaceScope'));
  const stop = source.slice(source.indexOf('function requestRiskIntentStop'), source.indexOf('class RiskIntentInterruptedError'));
  const calculatePretrade = vi.fn(async () => ({ status: 'success', result: {} }));
  const app = new RiskApplication({ service: { listProducts: async () => ['测试账户'], calculatePretrade } as unknown as RiskService });
  apps.push(app);
  const messages: string[] = [];
  const activeRuns = new Map();
  const keyFor = (scope: string, actor: string) => businessConversationKey({ channel: 'wecom', accountId: 'bot', instanceId: 'test' }, scope, actor);
  const controller = new RiskInteractionController({ application: app, riskStates: app.states, riskRouter: app.router,
    riskSelectionTasks: new RiskSelectionTaskRegistry(), conversationQueue: {} as never,
    runGate: { run: async fn => fn() }, startingRuns: new Set(), streamMaxBytes: 4000, selectionCardDelayMs: 0,
    refreshHealth: async () => {}, isRiskUserAllowed: () => true, updateTemplateCard: async () => {},
    sendControlCardMessage: async () => {}, sendMarkdownMessage: async (_body, text) => { messages.push(text); },
    createRiskTaskId: () => 'test-selection' });
  const generic = vi.fn(async () => {});
  const context: Record<string, any> = {
    Date, Buffer, withTimeout, RiskProgressRelay, truncateUtf8, renderWeComNotice, riskApplication: app,
    riskInteraction: controller, riskKeyFor: keyFor, activeRuns,
    riskIntentRunsStarting: new Set(), riskIntentStopRequests: new Set(), startingRuns: new Set(),
    textFromWeComMessage: (body: any) => body.text.content, normalizeIncomingText: (text: string) => text,
    collectWeComMediaInputs: () => [], parseWeComCommand: parseBusinessCommand,
    conversationKey: () => 'room', sessionStore: { captureScope: (key: string) => key, workspaceFor: () => '/test', clear: async () => {} },
    isConversationBusy: () => false, riskSelectionTasks: { clearConversation: () => {} },
    navigationCards: { clearConversation: () => {} },
    isRiskUserAllowed: () => true, taskStore: {}, client: {},
    withReservation: async (_set: unknown, _key: string, fn: () => Promise<void>) => fn(),
    runGate: { run: async (fn: () => Promise<void>) => fn() }, refreshHealth: async () => {},
    conversationQueue: { has: () => false, submit: (_key: string, fn: () => Promise<void>) => ({
      queued: false, position: 0, cancel: () => false, completion: Promise.resolve().then(fn),
    }) },
    streamMaxBytes: 4000, generateReqId: () => 'request', createTaskId: () => 'control', registerControlCard: () => {},
    renderWeComAcknowledgement: () => 'ack', renderStream: () => 'agent', currentThreadId: () => undefined,
    freshRunState: () => ({}), buildWeComControlCard: () => ({}), sandbox: 'read-only',
    WeComStreamReply: class {
      async update() {} async start() {} async startWithCard() { return false; }
      async finish(text: string) { messages.push(text); return true; }
    },
    replyControl: async (_frame: unknown, _key: string, title: string, lines: string[]) => { messages.push([title, ...lines].join('\n')); },
    resolveAttachments: async () => [], promptContextFromWeComMessage: () => ({}),
    buildWeComAgentPrompt: (text: string) => text, runCodexPrompt: generic,
    markInterrupted: (state: object) => ({ ...state, terminal: 'interrupted' }),
    reportMetric: vi.fn(), log: { info: vi.fn(), fail: vi.fn() },
    RiskIntentInterruptedError: class extends Error {}, WeComRunCapacityError: class extends Error {},
  };
  vm.runInNewContext(ts.transpileModule(handler + execute + stop + '\nglobalThis.handle = handleMessage;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return { app, calculatePretrade, messages, generic, controller, activeRuns, key: keyFor('room', 'owner'),
    send: (text: string) => context.handle({ body: { chattype: 'single', from: { userid: 'owner' }, text: { content: text } } }) as Promise<void> };
}

describe('WeCom actual message entry after risk termination', () => {
  it.each(['draft', 'consumed', 'cancelled'])('new session releases the previous business ownership: %s', async state => {
    const api = setup(); await api.send(trade);
    if (state === 'consumed') await api.send('确认');
    if (state === 'cancelled') await api.send('/stop');
    await api.send('/new');
    await api.send('确认');
    expect(api.generic).toHaveBeenCalledOnce();
    expect(api.app.states.terminalFor(api.key)).toBeUndefined();
    expect(api.calculatePretrade).toHaveBeenCalledTimes(state === 'consumed' ? 1 : 0);
  });
  it('finishes a stop request when its cancellation receipt never settles', async () => {
    vi.useFakeTimers();
    const api = setup(); await api.send(trade);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(api.controller, 'renderReply').mockImplementationOnce(async () => { await gate; });
    let finished = false;
    const pending = api.send('/stop').then(() => { finished = true; });
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(finished).toBe(true);
      expect(api.app.states.has(api.key)).toBe(false);
    } finally { release(); await pending; }
  });
  it('keeps a second confirmation on the business reply path after the first result finished', async () => {
    const api = setup();
    await api.send(trade); await api.send('确认'); await api.send('确认');
    expect(api.calculatePretrade).toHaveBeenCalledOnce();
    expect(api.generic).not.toHaveBeenCalled();
    expect(api.messages.at(-1)).toContain('不会重复');
  });
  it('acknowledges cancellation of an idle draft, without an incorrect no-task reply', async () => {
    const api = setup(); await api.send(trade);
    const before = api.messages.length;
    await api.send('/stop');
    expect(api.messages.slice(before).join('\n')).toContain('已取消风险交互');
    expect(api.messages.slice(before).join('\n')).not.toContain('当前没有运行任务');
    await api.send('确认');
    expect(api.messages.at(-1)).toContain('已取消');
    expect(api.calculatePretrade).not.toHaveBeenCalled();
    expect(api.generic).not.toHaveBeenCalled();
  });
  it('still reports an idle ordinary stop when there is no business draft', async () => {
    const api = setup(); await api.send('/stop');
    expect(api.messages.join('\n')).toContain('当前没有运行任务');
    expect(api.app.states.terminalFor(api.key)).toBeUndefined();
  });
  it('still stops a normal active run even if the cancellation receipt fails', async () => {
    const api = setup(); await api.send(trade);
    const stop = vi.fn(async () => {});
    api.activeRuns.set('room', { run: { stop }, state: {}, prompt: 'ordinary coding task' });
    vi.spyOn(api.controller, 'renderReply').mockRejectedValueOnce(new Error('synthetic send failure'));
    await api.send('/stop');
    expect(stop).toHaveBeenCalledOnce();
    expect(api.app.states.has(api.key)).toBe(false);
    expect(api.calculatePretrade).not.toHaveBeenCalled();
  });
  it('stops the active run while cancellation receipt delivery is pending', async () => {
    const api = setup(); await api.send(trade);
    const stop = vi.fn(async () => {});
    api.activeRuns.set('room', { run: { stop }, state: {}, prompt: 'ordinary coding task' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(api.controller, 'renderReply').mockImplementationOnce(async () => { await gate; });
    const pending = api.send('/stop');
    try { await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce(), { timeout: 200 }); }
    finally { release(); await pending; }
    expect(api.calculatePretrade).not.toHaveBeenCalled();
  });
  it('keeps text confirmation in the business flow after a card consumed the draft', async () => {
    const api = setup(); await api.send(trade);
    const draft = api.app.states.getPretrade(api.key)!;
    await api.app.select({ key: api.key, text: '', authorized: true }, draft, 'confirm');
    await api.send('确认');
    expect(api.messages.at(-1)).toContain('不会重复');
    expect(api.calculatePretrade).toHaveBeenCalledOnce();
    expect(api.generic).not.toHaveBeenCalled();
  });
  it('returns to ordinary chat for a genuinely new message and its later confirmation', async () => {
    const api = setup(); await api.send(trade); await api.send('/stop');
    await api.send('帮我解释一段代码'); await api.send('确认');
    expect(api.generic).toHaveBeenCalledTimes(2);
    expect(api.calculatePretrade).not.toHaveBeenCalled();
  });
});
