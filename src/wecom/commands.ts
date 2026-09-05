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
  '`/menu`：打开会话控制台。',
  '`/doctor`：检查 WeCom、Codex、Workspace、Risk Service 和任务状态。',
  '`/runs`：查看最近任务及异常恢复状态。',
  '`/status`：查看当前状态。',
  '`/settings`：查看当前配置。',
  '`/help`：查看帮助。',
  '进入风险流程后，后续补充、修改、确认和选择无需重复 `/测算`。',
] as const;

export const WECOM_COMMAND_HINT =
  '快捷：/doctor · /runs · /resume · /model · /reasoning · /settings · /测算';

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
