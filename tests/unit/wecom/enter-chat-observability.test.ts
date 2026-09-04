import { describe, expect, it } from 'vitest';
import { enterChatObservation } from '../../../src/wecom/enter-chat-observability';

describe('WeCom enter_chat observability', () => {
  it('records received and sent stages without user content', () => {
    expect(enterChatObservation('received', 'single:user-a')).toEqual({
      stage: 'received',
      conversationKey: 'single:user-a',
    });
    expect(enterChatObservation('welcome-sent', 'group:chat-a')).toEqual({
      stage: 'welcome-sent',
      conversationKey: 'group:chat-a',
    });
  });

  it('allows only a compact classified failure', () => {
    expect(enterChatObservation('welcome-failed', 'single:user-a', 'sdk-error')).toEqual({
      stage: 'welcome-failed',
      conversationKey: 'single:user-a',
      errorKind: 'sdk-error',
    });
  });
});
