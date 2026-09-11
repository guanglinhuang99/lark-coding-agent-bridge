export type BusinessCommand =
  | { kind: 'help' }
  | { kind: 'risk-measurement'; payload: string }
  | { kind: 'credit-query'; payload: string }
  | { kind: 'other' };

export const RISK_USAGE_LINES = [
  '请使用：`/测算 <交易或查询文本>`',
  '交易示例：`/测算 安联ESG纯债1号 买入 0.1亿元 019115.SH`',
  '查询示例：`/测算 安联ESG纯债1号 有哪些风险限额`',
  '进入流程后，后续补充、修改、确认和选择无需重复 `/测算`。',
] as const;

export const CREDIT_USAGE_LINES = [
  '请使用：`/授信 <公司或证券名称>`',
  '例如：`/授信 中信银行股份有限公司` 或 `/授信 25中信银行二级资本债01BC`',
  '支持模糊名称；多个名称用逗号、顿号、分号或换行分隔。金额单位为万元，持仓取最新可用日期。',
] as const;

/** The only command grammar for all business-channel adapters. */
export function parseBusinessCommand(text: string): BusinessCommand {
  const value = text.trim();
  if (value.toLowerCase() === '/help') return { kind: 'help' };
  const credit = /^\/授信(?:\s+([\s\S]*))?$/u.exec(value);
  if (credit) return { kind: 'credit-query', payload: credit[1]?.trim() ?? '' };
  const risk = /^\/?测算(?:\s+([\s\S]*))?$/u.exec(value);
  return risk ? { kind: 'risk-measurement', payload: risk[1]?.trim() ?? '' } : { kind: 'other' };
}

export function shouldUseRiskFastPath(
  command: BusinessCommand,
  hasActiveRiskState: boolean,
  hasAttachments: boolean,
  pretradeIntentCandidate = false,
): boolean {
  if (command.kind === 'credit-query') return Boolean(command.payload);
  const required = isRiskIntentFlowRequired(command, pretradeIntentCandidate);
  if (hasAttachments && !hasActiveRiskState && !required) return false;
  return hasActiveRiskState || required;
}

export function isRiskIntentFlowRequired(command: BusinessCommand, pretradeIntentCandidate: boolean): boolean {
  return command.kind === 'risk-measurement' || pretradeIntentCandidate;
}

export function shouldFallbackRiskCommandToIntent(
  explicitRiskCommand: boolean,
  result: { handled: boolean; intent?: string },
): boolean {
  return explicitRiskCommand && result.handled && result.intent === 'unknown-risk';
}
