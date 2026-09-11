import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { RiskApplication } from '../../../src/business/risk/application';
import type { RiskService } from '../../../src/business/risk/client';
import { createLarkRiskAdapter } from '../../../src/bot/risk-adapter';
import { businessConversationKey, businessWorkspaceScope } from '../../../src/business/identity';
import { ActiveRuns } from '../../../src/bridge/active-runs';
import { ProcessPool } from '../../../src/bridge/process-pool';

const apps: RiskApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.useRealTimers();
});

describe('terminal review regressions', () => {
  it.each(['draft', 'consumed', 'cancelled'])('Lark new session releases previous business ownership: %s', async state => {
    const calculatePretrade = vi.fn(async () => ({ status: 'success', result: {} }));
    const app = new RiskApplication({ service: { calculatePretrade } as unknown as RiskService }); apps.push(app);
    const identity = { channel: 'lark' as const, accountId: 'bot', instanceId: 'test' };
    const key = businessConversationKey(identity, businessWorkspaceScope('room', undefined), 'owner');
    app.states.setPretrade(key, { stage: 'confirm', product: 'test', originalText: 'test',
      draft: { accountQuery: 'test', action: 'subscription', amountText: '100万', market: 'secondary' } });
    if (state === 'consumed') await app.handle({ key, text: '确认', authorized: true });
    if (state === 'cancelled') app.cancel(key);
    const send = vi.fn(async () => {});
    const adapter = createLarkRiskAdapter({ application: app, identity, stateDir: '/unused-test-state', env: {},
      channel: { send } as never, authorized: () => true, activeRuns: new ActiveRuns(), pool: new ProcessPool(() => 1) });
    const msg: NormalizedMessage = { content: '/new', chatId: 'room', senderId: 'owner', messageId: 'new',
      resources: [], chatType: 'p2p', rawContentType: 'text', mentions: [], mentionAll: false,
      mentionedBot: false, createTime: 1760000001000 };
    expect(await adapter.handle(msg, 'room')).toBe(false);
    expect(await adapter.handle({ ...msg, content: '确认', messageId: 'next' }, 'room')).toBe(false);
    expect(app.states.terminalFor(key)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(calculatePretrade).toHaveBeenCalledTimes(state === 'consumed' ? 1 : 0);
    await adapter.close();
  });
  it('finishes shutdown even if a cancellation receipt never settles', async () => {
    vi.useFakeTimers();
    const app = new RiskApplication({}); apps.push(app);
    const identity = { channel: 'lark' as const, accountId: 'bot', instanceId: 'test' };
    const key = businessConversationKey(identity, businessWorkspaceScope('room', undefined), 'owner');
    app.states.setPretrade(key, { stage: 'confirm', product: 'test', originalText: 'test',
      draft: { accountQuery: 'test', action: 'subscription', amountText: '100万', market: 'secondary' } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await gate; });
    const adapter = createLarkRiskAdapter({ application: app, identity, stateDir: '/unused-test-state', env: {},
      channel: { send } as never, authorized: () => true,
      activeRuns: new ActiveRuns(), pool: new ProcessPool(() => 1) });
    const msg: NormalizedMessage = { content: '/stop', chatId: 'room', senderId: 'owner', messageId: 'stop',
      resources: [], chatType: 'p2p', rawContentType: 'text', mentions: [], mentionAll: false,
      mentionedBot: false, createTime: 1760000001000 };
    await adapter.handle(msg, 'room');
    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(closed).toBe(true);
      expect(app.states.has(key)).toBe(false);
    } finally { release(); await closing; }
  });

  it('does not let ordinary input delayed before capture erase a newer terminal marker', async () => {
    const calculatePretrade = vi.fn(async () => ({ status: 'success', result: {} }));
    const app = new RiskApplication({ service: { calculatePretrade } as unknown as RiskService }); apps.push(app);
    const key = 'conversation';
    app.states.setPretrade(key, { stage: 'confirm', product: 'test', originalText: 'test',
      draft: { accountQuery: 'test', action: 'subscription', amountText: '100万', market: 'secondary' } });
    const arrival = app.markArrival(); // Before asynchronous chat/thread resolution.
    await app.handle({ key, text: '确认', authorized: true });
    expect(calculatePretrade).toHaveBeenCalledOnce();
    const terminal = app.states.terminalFor(key);
    const ordinary = { key, text: '解释代码', authorized: true };
    expect(await app.handle(ordinary, app.capture(ordinary, arrival))).toEqual({ handled: false });
    expect(app.states.terminalFor(key)).toBe(terminal);
    expect(await app.handle({ key, text: '确认', authorized: true })).toMatchObject({ handled: true, kind: 'notice' });
    expect(calculatePretrade).toHaveBeenCalledOnce();
  });
});
