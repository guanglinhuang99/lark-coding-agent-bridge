export interface ConversationAgentPreferences {
  model?: string;
  reasoningEffort?: string;
}

export function effectiveModel(
  preferences: ReadonlyMap<string, ConversationAgentPreferences>,
  key: string,
  startupModel: string,
): string {
  return preferences.get(key)?.model ?? startupModel;
}

export function effectiveReasoningEffort(
  preferences: ReadonlyMap<string, ConversationAgentPreferences>,
  key: string,
  startupReasoningEffort: string,
): string {
  return preferences.get(key)?.reasoningEffort ?? startupReasoningEffort;
}

export function setConversationModel(
  preferences: Map<string, ConversationAgentPreferences>,
  key: string,
  model: string,
): void {
  preferences.set(key, { ...preferences.get(key), model });
}

export function setConversationReasoningEffort(
  preferences: Map<string, ConversationAgentPreferences>,
  key: string,
  reasoningEffort: string,
): void {
  preferences.set(key, { ...preferences.get(key), reasoningEffort });
}
