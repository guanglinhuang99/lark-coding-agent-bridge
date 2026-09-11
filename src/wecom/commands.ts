// Compatibility names for channel callers; the business grammar has one owner.
export {
  parseBusinessCommand as parseWeComCommand,
  RISK_USAGE_LINES as WECOM_RISK_USAGE_LINES,
  CREDIT_USAGE_LINES as WECOM_CREDIT_USAGE_LINES,
  shouldUseRiskFastPath,
  isRiskIntentFlowRequired,
  shouldFallbackRiskCommandToIntent,
} from '../business/commands';
export type { BusinessCommand as WeComCommand } from '../business/commands';

export const WECOM_HELP_LINES = [
  '可用命令：',
  '`/测算 <交易或查询文本>`：开始风险限额测算或查询。',
  '`/授信 <公司或证券名称>`：查询发行人的三方和集团内授信，多个名称用顿号或逗号分隔。',
  '`/menu`：打开会话控制台。',
  '`/workspace`：查看当前聊天可用的工作区；`/workspace <ID>`：立即切换。',
  '`/doctor`：检查 WeCom、Codex、Workspace、Risk Service 和任务状态。',
  '`/runs`：查看最近任务及异常恢复状态。',
  '`/status`：查看当前状态。',
  '`/settings`：查看当前配置。',
  '`/help`：查看帮助。',
  '进入风险流程后，后续补充、修改、确认和选择无需重复 `/测算`。',
] as const;

export const WECOM_COMMAND_HINT =
  '快捷：/workspace · /doctor · /runs · /resume · /model · /reasoning · /settings · /测算 · /授信';
