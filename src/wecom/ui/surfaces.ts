import type { WeComCardView } from './model';
import { statusColor } from './theme';

export interface WeComAgentSettingsSummaryOptions {
  taskId: string;
  workspace: string;
  model: string;
  reasoning: string;
  sandbox?: string;
}

/** Compact settings summary with command affordances that already exist. */
export function buildAgentSettingsSummaryCardView(
  options: WeComAgentSettingsSummaryOptions,
): WeComCardView {
  return {
    kind: 'notice',
    taskId: options.taskId,
    source: 'Codex Bridge',
    sourceColor: statusColor('idle'),
    title: 'Agent Settings',
    description: '当前会话的 Agent 配置',
    subtitle: '使用 /model、/reasoning 调整；/menu 返回主控制台。',
    tui: {
      status: 'idle',
      eyebrow: 'CODEX SETTINGS',
      body: '使用 /model、/reasoning 调整；/menu 返回主控制台。',
      steps: [{ label: 'Configuration loaded', status: 'done' }],
    },
    facts: [
      { label: '工作区', value: clip(options.workspace, 26) },
      { label: '模型', value: clip(options.model, 26) },
      { label: '推理', value: clip(options.reasoning, 26) },
      ...(options.sandbox ? [{ label: '权限', value: clip(options.sandbox, 26) }] : []),
    ],
  };
}

function clip(value: string, maxCodePoints: number): string {
  const characters = Array.from(value);
  return characters.length > maxCodePoints
    ? `${characters.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
    : value;
}
