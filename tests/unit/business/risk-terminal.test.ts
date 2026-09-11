import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiskApplication } from '../../../src/business/risk/application';
import { businessConversationKey } from '../../../src/business/identity';
import type { RiskService } from '../../../src/business/risk/client';
import { RiskStateRegistry } from '../../../src/business/risk/state';

const applications: RiskApplication[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });
const trade = '/测算 测试账户 申购 100万';
function setup(channel: 'wecom' | 'lark', failure = false) {
  const calculatePretrade = vi.fn(async () => {
    if (failure) throw new Error('synthetic failure');
    return { status: 'success', result: {} };
  });
  const listProducts = vi.fn(async () => ['测试账户']);
  const analyze = vi.fn();
  const app = new RiskApplication({ service: { listProducts, calculatePretrade } as unknown as RiskService, analyze });
  applications.push(app);
  const key = businessConversationKey({ channel, accountId: 'bot', instanceId: 'test' }, 'room', 'owner');
  const request = (text: string) => ({ key, text, authorized: true });
  return { app, key, request, calculatePretrade, listProducts, analyze };
}

describe.each(['wecom', 'lark'] as const)('terminal confirmation ownership: %s', channel => {
  it.each([false, true])('keeps delayed confirmation out of generic chat after a consumed confirmation: failure=%s', async failure => {
    const api = setup(channel, failure);
    await api.app.handle(api.request(trade));
    await api.app.handle(api.request('确认'));
    expect(api.calculatePretrade).toHaveBeenCalledOnce();
    expect(api.app.states.has(api.key)).toBe(false);
    for (const text of ['确认', 'confirm', '好的', '1']) {
      expect(api.app.accepts(api.key, text)).toBe(true);
      const reply = await api.app.handle(api.request(text));
      expect(reply).toMatchObject({ handled: true, kind: 'notice' });
      expect(JSON.stringify(reply)).toContain('不会重复');
    }
    expect(api.calculatePretrade).toHaveBeenCalledOnce();
    expect(api.listProducts).toHaveBeenCalledOnce();
    expect(api.analyze).not.toHaveBeenCalled();
  });
  it('acknowledges draft cancellation and rejects subsequent confirmation without a backend call', async () => {
    const api = setup(channel);
    await api.app.handle(api.request(trade));
    const cancellation = api.app.cancel(api.key);
    expect(cancellation).toMatchObject({ handled: true, kind: 'notice', title: '已取消风险交互' });
    expect(api.app.accepts(api.key, '确认')).toBe(true);
    const reply = await api.app.handle(api.request('确认'));
    expect(reply).toMatchObject({ handled: true, kind: 'notice' });
    expect(JSON.stringify(reply)).toContain('已取消');
    expect(api.calculatePretrade).not.toHaveBeenCalled();
    expect(api.analyze).not.toHaveBeenCalled();
  });
  it('does not claim another actor, workspace or a conversation with no risk history', async () => {
    const api = setup(channel);
    await api.app.handle(api.request(trade));
    api.app.cancel(api.key);
    for (const key of ['new-chat', businessConversationKey({ channel, accountId: 'bot', instanceId: 'test' }, 'room', 'other')]) {
      expect(await api.app.handle({ ...api.request('确认'), key })).toEqual({ handled: false });
    }
    expect(api.calculatePretrade).not.toHaveBeenCalled();
  });
  it('does not let a delayed ordinary receipt erase a newer terminal marker', async () => {
    const api = setup(channel);
    await api.app.handle(api.request(trade)); api.app.cancel(api.key);
    const ordinary = api.request('解释代码');
    const captured = api.app.capture(ordinary);
    await api.app.handle(api.request(trade)); await api.app.handle(api.request('确认'));
    expect(await api.app.handle(ordinary, captured)).toEqual({ handled: false });
    expect(await api.app.handle(api.request('确认'))).toMatchObject({ handled: true, kind: 'notice' });
    expect(api.calculatePretrade).toHaveBeenCalledOnce();
  });
  it('allows a new ordinary conversation and its confirmations after leaving the ended risk flow', async () => {
    const api = setup(channel);
    await api.app.handle(api.request(trade));
    api.app.cancel(api.key);
    expect(await api.app.handle(api.request('帮我解释一段代码'))).toEqual({ handled: false });
    expect(await api.app.handle(api.request('确认'))).toEqual({ handled: false });
    expect(api.calculatePretrade).not.toHaveBeenCalled();
  });
  it('allows a fresh measurement but rejects a delayed confirmation captured before the new draft', async () => {
    const api = setup(channel);
    await api.app.handle(api.request(trade));
    api.app.cancel(api.key);
    const old = api.app.capture(api.request('确认'));
    await api.app.handle(api.request(trade.replace('100万', '200万')));
    expect(await api.app.handle(api.request('确认'), old)).toMatchObject({ handled: true, kind: 'notice' });
    expect(api.calculatePretrade).not.toHaveBeenCalled();
    await api.app.handle(api.request('确认'));
    expect(api.calculatePretrade).toHaveBeenCalledOnce();
    expect(api.calculatePretrade).toHaveBeenCalledWith('测试账户', { type: 'subscription', market: 'secondary', amount: 0.02 }, undefined);
  });
});

describe('bounded terminal metadata', () => {
  it('expires on reads even without a timer, without extending the lifetime on a repeat read', () => {
    let now = 1000;
    const states = new RiskStateRegistry(() => now, 100);
    states.rememberTerminal('chat', 'consumed');
    const first = states.terminalFor('chat');
    expect(first).toEqual({ reason: 'consumed', expiresAt: 1100 });
    now = 1050; expect(states.terminalFor('chat')).toBe(first);
    now = 1100; expect(states.terminalFor('chat')).toBeUndefined();
    states.dispose();
  });
  it('bounds retained hints and releases them at shutdown', () => {
    const states = new RiskStateRegistry(() => 1000, 100, 2);
    for (const key of ['a', 'b', 'c']) states.rememberTerminal(key, 'cancelled');
    expect(states.terminalFor('a')).toBeUndefined();
    expect(states.terminalFor('b')).toBeDefined();
    expect(states.terminalFor('c')).toBeDefined();
    expect(states.keys()).toEqual([]);
    states.dispose();
    expect(states.terminalFor('c')).toBeUndefined();
  });
  it('does not clear a replacement hint with an old expected marker', () => {
    const states = new RiskStateRegistry();
    states.rememberTerminal('chat', 'consumed');
    const old = states.terminalFor('chat')!;
    states.rememberTerminal('chat', 'cancelled');
    states.forgetTerminal('chat', old);
    expect(states.terminalFor('chat')?.reason).toBe('cancelled');
    states.dispose();
  });
});
