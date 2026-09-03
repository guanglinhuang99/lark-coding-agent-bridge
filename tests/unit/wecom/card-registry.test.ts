import { describe, expect, it } from 'vitest';
import { WeComCardRegistry } from '../../../src/wecom/ui/registry';

describe('WeComCardRegistry', () => {
  it('resolves and consumes one card exactly once', () => {
    let now = 1_000;
    const registry = new WeComCardRegistry(() => now);
    registry.register({
      taskId: 'model_1',
      purpose: 'model',
      conversationKey: 'single:a',
      payload: { options: ['a', 'b'] },
      expiresAt: 2_000,
    });

    expect(registry.resolve('model_1', 'single:a')).toMatchObject({ status: 'resolved' });
    expect(registry.consume('model_1', 'single:a')).toMatchObject({
      status: 'resolved',
      card: { state: 'consumed' },
    });
    expect(registry.consume('model_1', 'single:a')).toEqual({ status: 'missing' });
  });

  it('rejects callbacks from another conversation without consuming the card', () => {
    const registry = new WeComCardRegistry(() => 1_000);
    registry.register({
      taskId: 'session_1',
      purpose: 'session',
      conversationKey: 'single:a',
      expiresAt: 2_000,
    });

    expect(registry.resolve('session_1', 'group:b')).toMatchObject({ status: 'mismatch' });
    expect(registry.has('session_1', 'single:a')).toBe(true);
  });

  it('expires cards and rejects stale revisions', () => {
    let now = 1_000;
    const registry = new WeComCardRegistry(() => now);
    registry.register({
      taskId: 'menu_1',
      purpose: 'menu',
      conversationKey: 'single:a',
      expiresAt: 2_000,
      revision: 3,
    });

    expect(registry.resolve('menu_1', 'single:a', 2)).toMatchObject({ status: 'stale' });
    expect(registry.resolve('menu_1', 'single:a', 3)).toMatchObject({ status: 'resolved' });

    now = 2_001;
    expect(registry.resolve('menu_1', 'single:a')).toMatchObject({
      status: 'expired',
      card: { state: 'expired' },
    });
    expect(registry.has('menu_1')).toBe(false);
  });

  it('keeps only the latest card for a conversation and purpose', () => {
    const registry = new WeComCardRegistry(() => 1_000);
    registry.register({
      taskId: 'model_old',
      purpose: 'model',
      conversationKey: 'single:a',
      expiresAt: 2_000,
    });
    registry.register({
      taskId: 'model_new',
      purpose: 'model',
      conversationKey: 'single:a',
      expiresAt: 2_000,
    });

    expect(registry.has('model_old')).toBe(false);
    expect(registry.has('model_new')).toBe(true);
  });

  it('keeps different purposes and conversations isolated', () => {
    const registry = new WeComCardRegistry(() => 1_000);
    registry.register({ taskId: 'model_a', purpose: 'model', conversationKey: 'single:a', expiresAt: 2_000 });
    registry.register({ taskId: 'session_a', purpose: 'session', conversationKey: 'single:a', expiresAt: 2_000 });
    registry.register({ taskId: 'model_b', purpose: 'model', conversationKey: 'group:b', expiresAt: 2_000 });

    expect(registry.has('model_a', 'single:a')).toBe(true);
    expect(registry.has('session_a', 'single:a')).toBe(true);
    expect(registry.has('model_b', 'group:b')).toBe(true);

    registry.clearConversation('single:a');
    expect(registry.has('model_a')).toBe(false);
    expect(registry.has('session_a')).toBe(false);
    expect(registry.has('model_b')).toBe(true);
  });

  it('increments revision without changing task identity', () => {
    let now = 1_000;
    const registry = new WeComCardRegistry(() => now);
    registry.register({ taskId: 'menu_1', purpose: 'menu', conversationKey: 'single:a', expiresAt: 2_000 });
    now = 1_100;
    const updated = registry.bump('menu_1');

    expect(updated).toMatchObject({ taskId: 'menu_1', revision: 2, updatedAt: 1_100 });
    expect(registry.resolve('menu_1', 'single:a', 1)).toMatchObject({ status: 'stale' });
    expect(registry.resolve('menu_1', 'single:a', 2)).toMatchObject({ status: 'resolved' });
  });
});
