export type WeComCommand =
  | { kind: 'help' }
  | { kind: 'risk-measurement'; payload: string }
  | { kind: 'other' };

export const WECOM_RISK_USAGE_LINES = [
  '请使用：`/测算 <交易或查询文本>`',
  '交易示例：`/测算 安联ESG纯债1号 买入 0.1亿元 019115.SH`',
  '查询示例：`/测算 安联ESG纯债1号 有哪些风险限额`',
  '进入流程后，后续补充、修改、确认和选择无需重复 `/测算`。',
] as const;

export const WECOM_HELP_LINES = [
  '可用命令：',
  '`/测算 <交易或查询文本>`：开始风险限额测算或查询。',
  '`/help`：查看帮助。',
  '`/menu`：打开会话控制台。',
  '`/status`：查看当前状态。',
  '`/settings`：查看当前配置。',
  '进入风险流程后，后续补充、修改、确认和选择无需重复 `/测算`。',
] as const;

export const WECOM_COMMAND_HINT =
  '快捷入口：/测算 <文本> · /help · /model · /reasoning · /resume · /settings';

export function parseWeComCommand(text: string): WeComCommand {
  const value = text.trim();
  if (value.toLowerCase() === '/help') return { kind: 'help' };
  const riskMatch = /^\/测算(?:\s+([\s\S]*))?$/u.exec(value);
  if (!riskMatch) return { kind: 'other' };
  return { kind: 'risk-measurement', payload: riskMatch[1]?.trim() ?? '' };
}

export function shouldUseRiskFastPath(
  command: WeComCommand,
  hasActiveRiskState: boolean,
  hasAttachments: boolean,
): boolean {
  if (hasAttachments && !hasActiveRiskState) return false;
  return (
    hasActiveRiskState ||
    (command.kind === 'risk-measurement' && Boolean(command.payload))
  );
}
