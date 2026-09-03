import { describe, expect, it } from 'vitest';
import {
  effectiveModel,
  effectiveReasoningEffort,
  setConversationModel,
  setConversationReasoningEffort,
  type ConversationAgentPreferences,
} from '../../../src/wecom/agent-preferences';

describe('WeCom conversation agent preferences', () => {
  it('isolates model and reasoning choices by conversation key', () => {
    const preferences = new Map<string, ConversationAgentPreferences>();

    setConversationModel(preferences, 'single:user-a', 'model-A');
    setConversationReasoningEffort(preferences, 'single:user-a', 'high');

    expect(effectiveModel(preferences, 'single:user-a', 'default-model')).toBe('model-A');
    expect(effectiveReasoningEffort(preferences, 'single:user-a', 'default-reasoning')).toBe(
      'high',
    );
    expect(effectiveModel(preferences, 'single:user-b', 'default-model')).toBe('default-model');
    expect(effectiveReasoningEffort(preferences, 'single:user-b', 'default-reasoning')).toBe(
      'default-reasoning',
    );

    setConversationModel(preferences, 'single:user-b', 'model-B');

    expect(effectiveModel(preferences, 'single:user-b', 'default-model')).toBe('model-B');
    expect(effectiveModel(preferences, 'single:user-a', 'default-model')).toBe('model-A');
    expect(effectiveReasoningEffort(preferences, 'single:user-a', 'default-reasoning')).toBe(
      'high',
    );
  });

  it('keeps private and group conversations independent', () => {
    const preferences = new Map<string, ConversationAgentPreferences>();

    setConversationModel(preferences, 'single:user-a', 'private-model');
    setConversationReasoningEffort(preferences, 'group:chat-a', 'low');

    expect(effectiveModel(preferences, 'group:chat-a', 'default-model')).toBe('default-model');
    expect(effectiveReasoningEffort(preferences, 'single:user-a', 'default-reasoning')).toBe(
      'default-reasoning',
    );
    expect(effectiveModel(preferences, 'single:user-a', 'default-model')).toBe('private-model');
    expect(effectiveReasoningEffort(preferences, 'group:chat-a', 'default-reasoning')).toBe('low');
  });
});
