import { describe, expect, it } from 'vitest';
import { WeComNavigationCardRegistry } from '../../../src/wecom/ui/navigation-registry';

describe('WeCom navigation card lifecycle', () => {
  it('accepts a valid callback and rejects a duplicate as expired/missing', () => {
    const registry = new WeComNavigationCardRegistry(() => 1_000);
    registry.register({
      taskId: 'model_1',
      purpose: 'model',
      conversationKey: 'single:a',
      optionLabels: new Map([['gpt-5.6', 'GPT-5.6']]),
      expiresAt: 2_000,
    });

    expect(registry.consumeSelection('model_1', 'single:a', 'model', 'gpt-5.6')).toMatchObject({
      status: 'selected',
      selectedId: 'gpt-5.6',
      label: 'GPT-5.6',
      card: { state: 'consumed' },
    });
    expect(registry.consumeSelection('model_1', 'single:a', 'model', 'gpt-5.6')).toEqual({
      status: 'missing',
    });
  });

  it('does not consume a valid card for a wrong conversation', () => {
    const registry = new WeComNavigationCardRegistry(() => 1_000);
    registry.register({
      taskId: 'reasoning_1',
      purpose: 'reasoning',
      conversationKey: 'single:a',
      optionLabels: new Map([['high', 'high']]),
      expiresAt: 2_000,
    });

    expect(registry.consumeSelection('reasoning_1', 'group:b', 'reasoning', 'high')).toMatchObject({
      status: 'mismatch',
    });
    expect(registry.consumeSelection('reasoning_1', 'single:a', 'reasoning', 'high')).toMatchObject({
      status: 'selected',
    });
  });

  it('returns expired for an expired callback and invalid for an unknown option without consuming', () => {
    let now = 1_000;
    const registry = new WeComNavigationCardRegistry(() => now);
    registry.register({
      taskId: 'workspace_1',
      purpose: 'workspace',
      conversationKey: 'single:a',
      optionLabels: new Map([['current', '当前']]),
      expiresAt: 2_000,
    });

    expect(registry.consumeSelection('workspace_1', 'single:a', 'workspace', 'unknown')).toEqual({
      status: 'invalid',
    });
    expect(registry.resolve('workspace_1', 'single:a')).toMatchObject({ status: 'resolved' });

    now = 2_001;
    expect(registry.consumeSelection('workspace_1', 'single:a', 'workspace', 'current')).toMatchObject({
      status: 'expired',
      card: { state: 'expired' },
    });
  });

  it('rejects a wrong purpose without consuming the card', () => {
    const registry = new WeComNavigationCardRegistry(() => 1_000);
    registry.register({
      taskId: 'model_1',
      purpose: 'model',
      conversationKey: 'single:a',
      optionLabels: new Map([['gpt-5.6', 'GPT-5.6']]),
      expiresAt: 2_000,
    });

    expect(registry.consumeSelection('model_1', 'single:a', 'reasoning', 'gpt-5.6')).toEqual({
      status: 'purpose-mismatch',
    });
    expect(registry.resolve('model_1', 'single:a')).toMatchObject({ status: 'resolved' });
  });

  it('replaces an older selector and keeps model/reasoning conversations isolated', () => {
    const registry = new WeComNavigationCardRegistry(() => 1_000);
    registry.register({
      taskId: 'model_old',
      purpose: 'model',
      conversationKey: 'single:a',
      optionLabels: new Map([['old', 'old']]),
      expiresAt: 2_000,
    });
    registry.register({
      taskId: 'model_new',
      purpose: 'model',
      conversationKey: 'single:a',
      optionLabels: new Map([['new', 'new']]),
      expiresAt: 2_000,
    });
    registry.register({
      taskId: 'reasoning_b',
      purpose: 'reasoning',
      conversationKey: 'group:b',
      optionLabels: new Map([['high', 'high']]),
      expiresAt: 2_000,
    });

    expect(registry.consumeSelection('model_old', 'single:a', 'model', 'old')).toEqual({
      status: 'missing',
    });
    expect(registry.consumeSelection('model_new', 'single:a', 'model', 'new')).toMatchObject({
      status: 'selected',
    });
    expect(registry.consumeSelection('reasoning_b', 'single:a', 'reasoning', 'high')).toMatchObject({
      status: 'mismatch',
    });
    expect(registry.consumeSelection('reasoning_b', 'group:b', 'reasoning', 'high')).toMatchObject({
      status: 'selected',
    });
  });

  it('keeps Home actions reusable through resolve instead of consume', () => {
    const registry = new WeComNavigationCardRegistry(() => 1_000);
    registry.register({
      taskId: 'menu_1',
      purpose: 'menu',
      conversationKey: 'single:a',
      expiresAt: 2_000,
    });

    expect(registry.resolve('menu_1', 'single:a')).toMatchObject({ status: 'resolved' });
    expect(registry.resolve('menu_1', 'single:a')).toMatchObject({ status: 'resolved' });
  });
});
