import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiskApplication, type RiskReply } from '../../../src/business/risk/application';
import { businessConversationKey } from '../../../src/business/identity';
import type { RiskService } from '../../../src/business/risk/client';
import type { RiskIntentState } from '../../../src/business/risk/intent';
import { RiskStateRegistry } from '../../../src/business/risk/state';

const product = '安联ESG纯债1号资产管理产品';
const security = { name: '国债0115', code: '100115.SZ', label: '国债0115 100115.SZ' };
const trade = `/测算 ${product} 买入 1000万 ${security.code}`;
const applications: RiskApplication[] = [];
function service(overrides: Partial<RiskService> = {}): RiskService {
  return {
    listProducts: vi.fn(async () => [product]), searchSecurities: vi.fn(async () => [security]),
    calculatePretrade: vi.fn(async () => ({ status: 'success', result: {} })),
    getHoldings: vi.fn(async () => ({ product, holdings: [] })),
    getRestrictions: vi.fn(async () => ({ product, investment_restrictions: [] })),
    checkSecurity: vi.fn(async () => ({ hit: false })), checkCounterparty: vi.fn(async () => ({ hit: false })),
    getCredit: vi.fn(async entity => ({ entity, group_internal: { credit_limit_yuan: 100_000,
      used_credit_yuan: 20_000, remaining_credit_yuan: 80_000 },
      third_party: { credit_limit_yuan: null, used_credit_yuan: 0, remaining_credit_yuan: null } })),
    ...overrides,
  };
}
function setup(overrides: Partial<RiskService> = {}, states?: RiskStateRegistry) {
  const backend = service(overrides);
  const analyze = vi.fn();
  const app = new RiskApplication({ service: backend, analyze, states });
  applications.push(app);
  return { app, backend, analyze };
}
function key(channel: 'lark' | 'wecom', actor = 'owner', scope = 'room') {
  return businessConversationKey({ channel, accountId: 'bot', instanceId: 'test' }, scope, actor);
}
function request(conversation: string, text: string, authorized = true) {
  return { key: conversation, text, authorized };
}
function confirmed(reply: RiskReply): Extract<RiskIntentState, { stage: 'confirm' }> {
  expect(reply).toMatchObject({ handled: true, kind: 'intent', state: { stage: 'confirm' } });
  if (!reply.handled || reply.kind !== 'intent' || reply.state.stage !== 'confirm') throw new Error('Expected confirmation');
  return reply.state;
}
afterEach(async () => {
  await Promise.all(applications.splice(0).map(app => app.close()));
  vi.useRealTimers();
});

describe.each(['wecom', 'lark'] as const)('shared risk application: %s', channel => {
  it('keeps the zero-AI fast path, then converts units and executes exactly once', async () => {
    const { app, backend, analyze } = setup();
    const conversation = key(channel);
    confirmed(await app.handle(request(conversation, trade)));
    expect(analyze).not.toHaveBeenCalled();
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
    const results = await Promise.all([app.handle(request(conversation, '确认')), app.handle(request(conversation, '确认'))]);
    expect(results[0]).toMatchObject({ handled: true, kind: 'result', confirmed: true });
    expect(backend.calculatePretrade).toHaveBeenCalledOnce();
    expect(backend.calculatePretrade).toHaveBeenCalledWith(product,
      { type: 'buy', market: 'secondary', amount: 0.1, security_name: security.code }, undefined);
    expect(backend.listProducts).toHaveBeenCalledOnce();
    expect(backend.searchSecurities).toHaveBeenCalledOnce();
    expect(results.every(item => item.handled)).toBe(true);
  });

  it('applies a direct correction without an extra AI or identifier lookup', async () => {
    const { app, backend, analyze } = setup();
    const conversation = key(channel);
    confirmed(await app.handle(request(conversation, trade)));
    const next = confirmed(await app.handle(request(conversation, '金额改为2000万')));
    expect(next.draft.amountText).toBe('2000万');
    expect(next.security).toEqual(security);
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    await app.handle(request(conversation, 'confirm'));
    expect(backend.calculatePretrade).toHaveBeenCalledWith(product,
      { type: 'buy', market: 'secondary', amount: 0.2, security_name: security.code }, undefined);
  });

  it('cannot confirm a draft owned by another user', async () => {
    const { app, backend } = setup();
    const owner = key(channel), other = key(channel, 'other');
    const state = confirmed(await app.handle(request(owner, trade)));
    expect(await app.select(request(other, ''), state, 'confirm')).toMatchObject({ kind: 'notice' });
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
    expect(app.states.getPretrade(owner)).toBe(state);
  });

  it('rejects a stale confirmation after a new trade replaces it', async () => {
    const { app, backend } = setup();
    const conversation = key(channel);
    const old = confirmed(await app.handle(request(conversation, trade)));
    const current = confirmed(await app.handle(request(conversation, trade.replace('1000万', '3000万'))));
    expect(await app.select(request(conversation, ''), old, 'confirm')).toMatchObject({ kind: 'notice' });
    expect(app.states.getPretrade(conversation)).toBe(current);
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
  });

  it('does not lose the pending trade when querying credit', async () => {
    const { app, backend } = setup();
    const conversation = key(channel);
    const pending = confirmed(await app.handle(request(conversation, trade)));
    const credit = await app.handle(request(conversation, '/授信 公司甲'));
    expect(credit).toMatchObject({ handled: true, kind: 'pages' });
    expect(backend.getCredit).toHaveBeenCalledWith('公司甲');
    expect(app.states.getPretrade(conversation)).toBe(pending);
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
  });

  it('routes restrictions through the shared direct service, never through AI', async () => {
    const { app, backend, analyze } = setup();
    const reply = await app.handle(request(key(channel), `/测算 ${product}有哪些风险限额`));
    expect(reply).toMatchObject({ handled: true, kind: 'result', result: { intent: 'query_restrictions' } });
    expect(backend.getRestrictions).toHaveBeenCalledWith(product);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('checks authorization before touching the business service or extraction model', async () => {
    const { app, backend, analyze } = setup();
    expect(await app.handle(request(key(channel), trade, false))).toMatchObject({ kind: 'notice', level: 'error' });
    expect(backend.listProducts).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
  });

  it('expires a draft without routing a confirmation into generic chat', async () => {
    vi.useFakeTimers();
    const { app, backend } = setup({}, new RiskStateRegistry(Date.now, 100));
    confirmed(await app.handle(request(key(channel), trade)));
    await vi.advanceTimersByTimeAsync(101);
    expect(await app.handle(request(key(channel), '确认'))).toMatchObject({ handled: true, kind: 'notice' });
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
  });

  it('never restores a cancelled draft when a slow lookup completes', async () => {
    let resolve!: (products: string[]) => void;
    const products = new Promise<string[]>(done => { resolve = done; });
    const { app, backend } = setup({ listProducts: vi.fn(() => products) });
    const pending = app.handle(request(key(channel), trade));
    await vi.waitFor(() => expect(backend.listProducts).toHaveBeenCalledOnce());
    app.cancel(key(channel));
    resolve([product]);
    expect(await pending).toMatchObject({ kind: 'notice', title: '风险交互已停止' });
    expect(app.states.has(key(channel))).toBe(false);
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
  });

  it('discards a credit result that completes after cancellation', async () => {
    let resolve!: (report: Record<string, unknown>) => void;
    const report = new Promise<Record<string, unknown>>(done => { resolve = done; });
    const { app, backend } = setup({ getCredit: vi.fn(() => report) });
    const pending = app.handle(request(key(channel), '/授信 公司甲'));
    await vi.waitFor(() => expect(backend.getCredit).toHaveBeenCalledOnce());
    app.cancel(key(channel));
    resolve({ entity: '公司甲' });
    expect(await pending).toMatchObject({ kind: 'notice', title: '风险交互已停止' });
    expect(app.states.has(key(channel))).toBe(false);
  });

  it('does not announce success for a calculation that finishes after cancellation', async () => {
    let resolve!: (report: Record<string, unknown>) => void;
    const report = new Promise<Record<string, unknown>>(done => { resolve = done; });
    const { app, backend } = setup({ calculatePretrade: vi.fn(() => report) });
    confirmed(await app.handle(request(key(channel), trade)));
    const pending = app.handle(request(key(channel), '确认'));
    await vi.waitFor(() => expect(backend.calculatePretrade).toHaveBeenCalledOnce());
    app.cancel(key(channel));
    resolve({ status: 'success', result: {} });
    expect(await pending).toMatchObject({ kind: 'notice', title: '风险交互已停止' });
    expect(app.states.has(key(channel))).toBe(false);
    expect(backend.calculatePretrade).toHaveBeenCalledOnce();
  });

  it('never confirms the old draft after a requested correction fails', async () => {
    const { app, backend, analyze } = setup();
    const conversation = key(channel);
    const old = confirmed(await app.handle(request(conversation, trade)));
    analyze.mockRejectedValue(new Error('correction extraction unavailable'));
    expect(await app.handle(request(conversation, '标的改为另一只债券'))).toMatchObject({ kind: 'notice' });
    await app.handle(request(conversation, '确认'));
    await app.select(request(conversation, ''), old, 'confirm');
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
    expect(app.states.getPretrade(conversation)?.stage).not.toBe('confirm');
  });

  it('does not revive an old confirmation when a new request cannot be parsed', async () => {
    const { app, backend, analyze } = setup();
    const old = confirmed(await app.handle(request(key(channel), trade)));
    analyze.mockRejectedValueOnce(new Error('synthetic extraction failure'));
    expect(await app.handle(request(key(channel), '/测算 不完整的新交易'))).toMatchObject({ handled: true, kind: 'notice' });
    await app.select(request(key(channel), ''), old, 'confirm');
    expect(app.states.has(key(channel))).toBe(false);
    expect(backend.calculatePretrade).not.toHaveBeenCalled();
  });
});

describe('shared business boundaries', () => {
  it('isolates channel, actor and workspace namespaces', () => {
    expect(new Set([key('lark'), key('wecom'), key('lark', 'other'), key('lark', 'owner', 'other-workspace')]).size).toBe(4);
  });
  it('keeps generic chat generic but handles unavailable business commands explicitly', async () => {
    const app = new RiskApplication({}); applications.push(app);
    expect(await app.handle(request('test', 'hello'))).toEqual({ handled: false });
    expect(await app.handle(request('test', trade))).toMatchObject({ handled: true, kind: 'notice', level: 'error' });
    expect(await app.handle(request('test', '/授信'))).toMatchObject({ handled: true, kind: 'pages' });
  });
  it('cancels all actors in the selected scope without affecting another scope', async () => {
    const { app } = setup();
    for (const conversation of [key('wecom'), key('wecom', 'second'), key('wecom', 'owner', 'elsewhere')]) {
      await app.handle(request(conversation, trade));
    }
    app.cancelScope('room');
    expect(app.states.has(key('wecom'))).toBe(false);
    expect(app.states.has(key('wecom', 'second'))).toBe(false);
    expect(app.states.has(key('wecom', 'owner', 'elsewhere'))).toBe(true);
  });
  it('returns backend failures as failed results, not successful zero exposure', async () => {
    const { app } = setup({ calculatePretrade: vi.fn(async () => { throw new Error('synthetic failure'); }) });
    await app.handle(request(key('lark'), trade));
    expect(await app.handle(request(key('lark'), '确认'))).toMatchObject({
      kind: 'result', result: { intent: 'risk-error' },
    });
  });
});
