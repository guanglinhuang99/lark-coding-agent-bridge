import { WECOM_CARD_ACTIONS } from './actions';
import { buildSelectionCardView } from './builders';
import type { WeComCardSelectionOption, WeComCardView } from './model';
import { statusColor } from './theme';

export interface WeComHomeCardOptions {
  taskId: string;
  busy: boolean;
  workspace: string;
  model?: string;
  reasoning?: string;
  threadId?: string;
}

export interface WeComWorkspaceOption {
  id: string;
  label: string;
}

export interface WeComSessionOption {
  id: string;
  label: string;
  workspace?: string;
  hint?: string;
}

/**
 * Compact home surface. Keep the proven three-button control layout and make
 * richer navigation discoverable through commands until multi-button layouts
 * have been validated in the real WeCom client.
 */
export function buildHomeCardView(options: WeComHomeCardOptions): WeComCardView {
  return {
    kind: 'interactive',
    taskId: options.taskId,
    source: 'Codex Bridge',
    sourceColor: statusColor(options.busy ? 'running' : 'idle'),
    title: '🤖 Codex Bridge',
    description: options.busy ? 'Codex 正在处理当前会话' : '发送消息即可开始新的 Codex 任务',
    subtitle: '快捷入口：/model · /reasoning · /resume · /settings',
    facts: [
      { label: '工作区', value: clip(options.workspace, 26) },
      { label: '模型', value: clip(options.model?.trim() || 'Codex default', 26) },
      ...(options.reasoning ? [{ label: '推理', value: clip(options.reasoning, 26) }] : []),
      { label: '会话', value: clip(options.threadId?.trim() || 'new', 26) },
    ],
    buttons: [
      ...(options.busy
        ? [{ text: '停止', key: WECOM_CARD_ACTIONS.run.stop, variant: 'danger' as const }]
        : []),
      { text: '新会话', key: WECOM_CARD_ACTIONS.run.newSession, variant: 'secondary' },
      { text: '查看状态', key: WECOM_CARD_ACTIONS.run.status, variant: 'primary' },
    ],
  };
}

export function buildWorkspaceSelectionCardView(options: {
  taskId: string;
  workspaces: readonly WeComWorkspaceOption[];
}): WeComCardView {
  return buildNavigationSelection({
    taskId: options.taskId,
    title: '📂 选择 Workspace',
    questionKey: 'workspace',
    actionKey: WECOM_CARD_ACTIONS.workspace.select,
    options: options.workspaces.map((item) => ({ id: item.id, text: item.label })),
  });
}

export function buildModelSelectionCardView(options: {
  taskId: string;
  models: readonly WeComCardSelectionOption[];
}): WeComCardView {
  return buildNavigationSelection({
    taskId: options.taskId,
    title: '🤖 选择模型',
    questionKey: 'model',
    actionKey: WECOM_CARD_ACTIONS.model.select,
    options: options.models,
  });
}

export function buildReasoningSelectionCardView(options: {
  taskId: string;
  levels: readonly WeComCardSelectionOption[];
}): WeComCardView {
  return buildNavigationSelection({
    taskId: options.taskId,
    title: '🧠 选择推理强度',
    questionKey: 'reasoning',
    actionKey: WECOM_CARD_ACTIONS.reasoning.select,
    options: options.levels,
  });
}

export function buildSessionSelectionCardView(options: {
  taskId: string;
  sessions: readonly WeComSessionOption[];
}): WeComCardView {
  return buildNavigationSelection({
    taskId: options.taskId,
    title: '🧵 恢复最近会话',
    questionKey: 'session',
    actionKey: WECOM_CARD_ACTIONS.session.resume,
    options: options.sessions.map((session) => ({
      id: session.id,
      text: sessionLabel(session),
    })),
  });
}

function sessionLabel(session: WeComSessionOption): string {
  return [session.label, session.workspace, session.hint]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .join(' · ');
}

function buildNavigationSelection(options: {
  taskId: string;
  title: string;
  questionKey: string;
  actionKey: string;
  options: readonly WeComCardSelectionOption[];
}): WeComCardView {
  return buildSelectionCardView({
    taskId: options.taskId,
    source: 'Codex Bridge',
    title: options.title,
    description: '请选择一项，再点击确认。',
    questionKey: options.questionKey,
    options: options.options.map((item) => ({ id: item.id, text: clip(item.text, 60) })),
    submitKey: options.actionKey,
    submitText: '应用',
  });
}

function clip(value: string, maxCodePoints: number): string {
  const characters = Array.from(value);
  return characters.length > maxCodePoints
    ? `${characters.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
    : value;
}
