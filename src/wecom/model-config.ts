export interface WeComModelConfig {
  codexModel: string;
  codexReasoningEffort: string;
  riskIntentModel: string;
}

export function resolveWeComModelConfig(
  env: Record<string, string | undefined>,
): WeComModelConfig {
  const codexModel = env.WECOM_CODEX_MODEL?.trim() || 'gpt-5.6-luna';
  const codexReasoningEffort = env.WECOM_CODEX_REASONING_EFFORT?.trim() || 'max';
  const riskIntentModel = env.WECOM_RISK_INTENT_MODEL?.trim() || 'gpt-5.3-codex-spark';
  return { codexModel, codexReasoningEffort, riskIntentModel };
}
