import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { RiskApplication } from '../../../src/business/risk/application';
import { businessConversationKey } from '../../../src/business/identity';
import type { RiskService } from '../../../src/business/risk/client';

const product = '测试账户';
const security = { code: '100115.SZ', name: '测试国债', label: '测试国债 100115.SZ' };
const trade = `/测算 ${product} 买入 1000万 ${security.code}`;
const applications: RiskApplication[] = [];
const key = businessConversationKey({ channel: 'wecom', accountId: 'bot', instanceId: 'test' }, 'room', 'owner');
const request = (text: string) => ({ key, text, authorized: true });
function setup(maxPending = 32) {
  const service: RiskService = {
    listProducts: vi.fn(async () => [product]), searchSecurities: vi.fn(async () => [security]),
    calculatePretrade: vi.fn(async () => ({ status: 'success', result: {} })),
    getHoldings: vi.fn(async () => ({})), getRestrictions: vi.fn(async () => ({})),
    getCredit: vi.fn(async () => ({})), checkSecurity: vi.fn(async () => ({})),
    checkCounterparty: vi.fn(async () => ({})),
  };
  const app = new RiskApplication({ service, maxPending }); applications.push(app);
  return { app, service };
}
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });

describe('business ingress receipts', () => {
  it('binds a queued confirmation to the draft visible at ingress, never a revised draft', async () => {
    const { app, service } = setup();
    await app.handle(request(trade));
    const confirmation = request('确认');
    const queued = app.capture(confirmation);
    await app.handle(request('金额改为2000万'));
    expect(await app.handle(confirmation, queued)).toMatchObject({ handled: true, kind: 'notice' });
    expect(service.calculatePretrade).not.toHaveBeenCalled();
    await app.handle(request('确认'));
    expect(service.calculatePretrade).toHaveBeenCalledWith(product,
      { type: 'buy', market: 'secondary', amount: 0.2, security_name: security.code }, undefined);
  });
  it('stops a new request cancelled before the outer channel queue dispatches it', async () => {
    const { app, service } = setup();
    const input = request(trade);
    const queued = app.capture(input);
    app.cancelScope('room');
    expect(await app.handle(input, queued)).toMatchObject({ kind: 'notice', title: '风险交互已停止' });
    expect(service.listProducts).not.toHaveBeenCalled();
    expect(app.states.has(key)).toBe(false);
    expect(await app.handle(request(trade))).toMatchObject({ kind: 'intent' });
  });
  it('rejects premature confirmation while the initial request is still outside the application queue', async () => {
    const { app, service } = setup();
    const queuedTrade = app.capture(request(trade));
    const confirmation = request('确认');
    const queuedConfirm = app.capture(confirmation);
    expect(queuedConfirm.accepted).toBe(true);
    await app.handle(request(trade), queuedTrade);
    expect(await app.handle(confirmation, queuedConfirm)).toMatchObject({ kind: 'notice' });
    expect(service.calculatePretrade).not.toHaveBeenCalled();
  });
  it('never reclassifies already queued generic chat as a business continuation', async () => {
    const { app } = setup();
    const input = request('hello');
    const queued = app.capture(input);
    await app.handle(request(trade));
    expect(await app.handle(input, queued)).toEqual({ handled: false });
    expect(app.states.getPretrade(key)?.stage).toBe('confirm');
  });
  it('refuses a receipt with changed text or actor', async () => {
    const { app, service } = setup();
    const input = request(trade);
    const queued = app.capture(input);
    expect(await app.handle({ ...input, key: 'other-user' }, queued)).toMatchObject({ kind: 'notice' });
    expect(await app.handle({ ...input, text: 'different request' }, queued)).toMatchObject({ kind: 'notice' });
    expect(service.listProducts).not.toHaveBeenCalled();
    queued.release();
  });
  it('allows each ingress receipt to be consumed only once', async () => {
    const { app, service } = setup();
    const input = request(trade), queued = app.capture(input);
    await app.handle(input, queued);
    expect(await app.handle(input, queued)).toMatchObject({ kind: 'notice' });
    expect(service.listProducts).toHaveBeenCalledOnce();
  });
  it('bounds external queued requests and frees capacity on queue rejection', async () => {
    const { app, service } = setup(1);
    const queued = app.capture(request(trade));
    expect(await app.handle(request(trade))).toMatchObject({ kind: 'notice', title: '当前任务较多' });
    expect(service.listProducts).not.toHaveBeenCalled();
    queued.release(); queued.release();
    expect(await app.handle(request(trade))).toMatchObject({ kind: 'intent' });
  });
  it('does not execute an abandoned receipt after shutdown', async () => {
    const { app, service } = setup();
    const input = request(trade), queued = app.capture(input);
    await app.close();
    expect(await app.handle(input, queued)).toMatchObject({ kind: 'notice' });
    expect(service.listProducts).not.toHaveBeenCalled();
  });
  it('captures WeCom business context before acknowledgement and its transport queue', () => {
    const source = readFileSync('src/wecom/cli.ts', 'utf8');
    const handler = source.slice(source.indexOf('async function handleMessage'), source.indexOf('async function executeConversationMessage'));
    expect(handler.indexOf('riskApplication.capture(')).toBeGreaterThan(-1);
    expect(handler.indexOf('riskApplication.capture(')).toBeLessThan(handler.indexOf("generateReqId('ack')"));
    expect(handler.indexOf('riskApplication.capture(')).toBeLessThan(handler.indexOf('conversationQueue.submit('));
    expect(handler).toContain('riskIngress.release()');
    expect(source).toContain('}, riskIngress)');
  });
});
