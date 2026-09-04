export type WeComEnterChatStage = 'received' | 'welcome-sent' | 'welcome-failed';

export interface WeComEnterChatObservation {
  stage: WeComEnterChatStage;
  conversationKey: string;
  errorKind?: string;
}

/**
 * Minimal structured payload for diagnosing whether the platform emitted an
 * enter_chat event and whether replyWelcome succeeded. Never include message
 * bodies, credentials, raw errors or user content here.
 */
export function enterChatObservation(
  stage: WeComEnterChatStage,
  conversationKey: string,
  errorKind?: string,
): WeComEnterChatObservation {
  return {
    stage,
    conversationKey,
    ...(errorKind ? { errorKind } : {}),
  };
}
