import { describe, expect, it, vi } from 'vitest';
import type { TemplateCard } from '@wecom/aibot-node-sdk';
import { handleEnterChat, type WeComEnterChatFrame } from '../../../src/wecom/enter-chat-handler';
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

  it('replies once with the Home Card and observes welcome success', async () => {
    const replyWelcome = vi.fn(async () => ({}));
    const stages: string[] = [];
    const homeCard = { card_type: 'text_notice' } as TemplateCard;
    const frame = { headers: { req_id: 'req-1' }, body: { event: {} } } as WeComEnterChatFrame;

    await handleEnterChat(frame, {
      homeCard,
      replyWelcome,
      onStage: (stage) => stages.push(stage),
    });

    expect(replyWelcome).toHaveBeenCalledTimes(1);
    expect(replyWelcome).toHaveBeenCalledWith(frame, {
      msgtype: 'template_card',
      template_card: homeCard,
    });
    expect(stages).toEqual(['received', 'welcome-sent']);
  });

  it('observes welcome failure with only a classified error', async () => {
    const rawError = new Error('{"error":{"message":"secret backend stderr"}}');
    const replyWelcome = vi.fn(async () => {
      throw rawError;
    });
    const observations: Array<{ stage: string; errorKind?: string }> = [];
    const frame = { headers: { req_id: 'req-2' }, body: { event: {} } } as WeComEnterChatFrame;

    await handleEnterChat(frame, {
      homeCard: { card_type: 'text_notice' } as TemplateCard,
      replyWelcome,
      classifyError: () => 'other',
      onStage: (stage, errorKind) => observations.push({ stage, errorKind }),
    });

    expect(replyWelcome).toHaveBeenCalledTimes(1);
    expect(observations.map(({ stage }) => stage)).toEqual(['received', 'welcome-failed']);
    expect(observations[1]).toEqual({ stage: 'welcome-failed', errorKind: 'other' });
    expect(JSON.stringify(observations)).not.toContain(rawError.message);
  });
});
