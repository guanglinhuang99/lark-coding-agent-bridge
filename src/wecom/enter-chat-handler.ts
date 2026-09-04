import type {
  EnterChatEvent,
  EventMessageWith,
  TemplateCard,
  WelcomeTemplateCardReplyBody,
  WsFrame,
  WsFrameHeaders,
} from '@wecom/aibot-node-sdk';

export type WeComEnterChatFrame = WsFrame<EventMessageWith<EnterChatEvent>>;

export interface WeComEnterChatHandlerOptions {
  homeCard: TemplateCard;
  replyWelcome: (
    frame: WsFrameHeaders,
    body: WelcomeTemplateCardReplyBody,
  ) => Promise<unknown>;
  classifyError?: (error: unknown) => string;
  onStage?: (stage: 'received' | 'welcome-sent' | 'welcome-failed', errorKind?: string) => void;
}

/** Reply to one enter_chat event with exactly one Home Card welcome. */
export async function handleEnterChat(
  frame: WeComEnterChatFrame,
  options: WeComEnterChatHandlerOptions,
): Promise<void> {
  if (!frame.body) return;
  options.onStage?.('received');
  try {
    await options.replyWelcome(frame, {
      msgtype: 'template_card',
      template_card: options.homeCard,
    });
    options.onStage?.('welcome-sent');
  } catch (error) {
    options.onStage?.('welcome-failed', options.classifyError?.(error));
  }
}
