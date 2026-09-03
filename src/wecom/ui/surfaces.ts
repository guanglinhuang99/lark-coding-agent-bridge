import { WECOM_CARD_ACTIONS } from './actions';
import type { WeComCardFact, WeComCardView } from './model';
import { statusColor } from './theme';

export interface WeComAgentSettingsSummaryOptions {
  taskId: string;
  workspace: string;
  model: string;
  reasoning: string;
  sandbox?: string;
}

export interface WeComResultCardOptions {
  taskId: string;
  title?: string;
  summary?: string;
  durationMs?: number;
  toolCount?: number;
  fileCount?: number;
  threadId?: string;
  terminal?: 'success' | 'stopped' | 'error';
}

/**
 * Compact settings summary. Selection remains in the dedicated model/reasoning
 * cards so this surface never exposes a button whose callback cannot be safely
 * completed with the current WeCom payload shape.
 */
export function buildAgentSettingsSummaryCardView(
  options: WeComAgentSettingsSummaryOptions,
): WeComCardView {
  return {
    kind: 'notice',
    taskId: options.taskId,
    source: 'Codex Bridge',
    sourceColor: statusColor('idle'),
    title: '⚙️ Agent Settings',
    description: '当前会话的 Agent 配置',
    subtitle: '使用 /model 调整模型；推理强度通过对应选择卡修改。',
    facts: [
      { label: '工作区', value: clip(options.workspace, 26) },
      { label: '模型', value: clip(options.model, 26) },
      { label: '推理', value: clip(options.reasoning, 26) },
      ...(options.sandbox ? [{ label: '权限', value: clip(options.sandbox, 26) }] : []),
    ],
  };
}

/**
 * Post-run summary card. Full answer stays in Markdown; this card only exposes
 * compact outcome metadata and callback actions already supported by the
 * existing Codex control dispatcher.
 */
export function buildResultCardView(options: WeComResultCardOptions): WeComCardView {
  const terminal = options.terminal ?? 'success';
  const facts: WeComCardFact[] = [];
  if (options.durationMs !== undefined) facts.push({ label: '耗时', value: formatDuration(options.durationMs) });
  if (options.toolCount !== undefined) facts.push({ label: '工具', value: String(Math.max(0, options.toolCount)) });
  if (options.fileCount !== undefined) facts.push({ label: '文件', value: String(Math.max(0, options.fileCount)) });
  if (options.threadId) facts.push({ label: '会话', value: shortThread(options.threadId) });

  return {
    kind: 'interactive',
    taskId: options.taskId,
    source: 'Codex Bridge',
    sourceColor: statusColor(terminal === 'success' ? 'success' : terminal === 'error' ? 'error' : 'idle'),
    title: options.title ?? titleForTerminal(terminal),
    description: clip(options.summary?.trim() || descriptionForTerminal(terminal), 60),
    ...(facts.length ? { facts } : {}),
    buttons: [
      { text: '新会话', key: WECOM_CARD_ACTIONS.run.newSession, variant: 'secondary' },
      { text: '查看状态', key: WECOM_CARD_ACTIONS.run.status, variant: 'primary' },
    ],
  };
}

function titleForTerminal(terminal: NonNullable<WeComResultCardOptions['terminal']>): string {
  if (terminal === 'error') return '❌ 执行失败';
  if (terminal === 'stopped') return '⏹ 已停止';
  return '✅ 已完成';
}

function descriptionForTerminal(terminal: NonNullable<WeComResultCardOptions['terminal']>): string {
  if (terminal === 'error') return '任务未能完成，详细信息请查看 Markdown 输出。';
  if (terminal === 'stopped') return '任务已停止。';
  return '完整结果已通过 Markdown 输出。';
}

function formatDuration(durationMs: number): string {
  const safe = Math.max(0, durationMs);
  if (safe < 1_000) return `${Math.round(safe)}ms`;
  const seconds = safe / 1_000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function shortThread(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 12)}…` : threadId;
}

function clip(value: string, maxCodePoints: number): string {
  const characters = Array.from(value);
  return characters.length > maxCodePoints
    ? `${characters.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
    : value;
}
