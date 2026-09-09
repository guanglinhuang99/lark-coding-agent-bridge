import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RiskIntentState } from '../../../src/wecom/risk/intent';
import type { RiskQueryState } from '../../../src/wecom/risk/router';
import { RiskStateRegistry } from '../../../src/wecom/risk/state';

const pretrade: RiskIntentState = {
  stage: 'freeform',
  originalText: '交易',
  draft: { accountQuery: '账户A', market: 'secondary' },
  field: 'amount',
  product: '账户A',
};

const query: RiskQueryState = {
  kind: 'missing',
  intent: { kind: 'query_credit', entity: '' },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('RiskStateRegistry', () => {
  it('stores pretrade and query continuations in one mutually exclusive conversation slot', () => {
    const states = new RiskStateRegistry();

    states.setPretrade('chat', pretrade);
    expect(states.getPretrade('chat')).toBe(pretrade);
    expect(states.getQuery('chat')).toBeUndefined();

    states.setQuery('chat', query);
    expect(states.getPretrade('chat')).toBeUndefined();
    expect(states.getQuery('chat')).toBe(query);
    expect(states.getConversation('chat')).toEqual({ kind: 'query', state: query });
  });

  it('keeps the legacy intent-registry methods on the same underlying state owner', () => {
    const states = new RiskStateRegistry();
    states.set('chat', pretrade);

    expect(states.get('chat')).toBe(pretrade);
    expect(states.getPretrade('chat')).toBe(pretrade);
    expect(states.has('chat')).toBe(true);
  });

  it('stores card callbacks for either risk continuation kind and clears prior conversation tasks', () => {
    const states = new RiskStateRegistry(() => 1_000);
    states.registerConversationTask('query-card', 'chat', { kind: 'query', state: query }, 10_000);
    expect(states.getConversationTask('query-card')).toEqual({ kind: 'query', state: query });

    states.registerTask('pretrade-card', 'chat', pretrade, 10_000);
    expect(states.getConversationTask('query-card')).toBeUndefined();
    expect(states.getTask('pretrade-card')).toBe(pretrade);
  });

  it('drops the heavy state on expiry but preserves one explicit-expiry marker', async () => {
    vi.useFakeTimers();
    const states = new RiskStateRegistry(Date.now, 100);
    states.setQuery('chat', query);

    expect(states.has('chat')).toBe(true);
    await vi.advanceTimersByTimeAsync(101);

    expect(states.has('chat')).toBe(false);
    expect(states.getConversation('chat')).toBeUndefined();
    expect(states.hasPendingOrExpired('chat')).toBe(true);
    expect(states.consumeExpired('chat')).toBe(true);
    expect(states.hasPendingOrExpired('chat')).toBe(false);
    expect(states.consumeExpired('chat')).toBe(false);
  });

  it('clears conversation and card continuation state together', () => {
    const states = new RiskStateRegistry(() => 1_000);
    states.setQuery('chat', query);
    states.registerConversationTask('card', 'chat', { kind: 'query', state: query }, 10_000);

    states.clearConversation('chat');

    expect(states.hasPendingOrExpired('chat')).toBe(false);
    expect(states.getConversationTask('card')).toBeUndefined();
  });
});
