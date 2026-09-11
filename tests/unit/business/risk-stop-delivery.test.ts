import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { RiskApplication } from '../../../src/business/risk/application';
import { createLarkRiskAdapter } from '../../../src/bot/risk-adapter';
import { businessConversationKey, businessWorkspaceScope } from '../../../src/business/identity';
import { ActiveRuns } from '../../../src/bridge/active-runs';
import { ProcessPool } from '../../../src/bridge/process-pool';

const apps: RiskApplication[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('Lark cancellation receipt delivery', () => {
  it('returns control to the ordinary stop handler while receipt delivery is pending', async () => {
    const application = new RiskApplication({}); apps.push(application);
    const identity = { channel: 'lark' as const, accountId: 'bot', instanceId: 'test' };
    const key = businessConversationKey(identity, businessWorkspaceScope('room', undefined), 'owner');
    application.states.setPretrade(key, { stage: 'confirm', product: 'test', originalText: 'test',
      draft: { accountQuery: 'test', action: 'subscription', amountText: '100万', market: 'secondary' } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await gate; });
    const adapter = createLarkRiskAdapter({ application, identity, stateDir: '/unused-test-state', env: {},
      channel: { send } as never, authorized: () => true,
      activeRuns: new ActiveRuns(), pool: new ProcessPool(() => 1) });
    const msg: NormalizedMessage = { content: '/stop', chatId: 'room', senderId: 'owner', messageId: 'stop',
      resources: [], chatType: 'p2p', rawContentType: 'text', mentions: [], mentionAll: false,
      mentionedBot: false, createTime: 1760000001000 };
    let delegated = false;
    const pending = adapter.handle(msg, 'room').then(handled => { delegated = !handled; });
    try {
      await vi.waitFor(() => expect(delegated).toBe(true), { timeout: 200 });
      expect(application.states.has(key)).toBe(false);
      expect(send).toHaveBeenCalledOnce();
    } finally { release(); await pending; await adapter.close(); }
  });
});
