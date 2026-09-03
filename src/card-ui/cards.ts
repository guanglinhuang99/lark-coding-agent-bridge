import type {
  AgentCard,
  CardAction,
  CardField,
  CardStatus,
  CardStep,
  CardTone,
} from './types';

interface BaseCardInput {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  body?: string;
  fields?: readonly CardField[];
  actions?: readonly CardAction[];
  taskId?: string;
}

export interface TaskCardInput extends BaseCardInput {
  status: CardStatus;
  steps?: readonly CardStep[];
  tone?: CardTone;
}

export interface ResultCardInput extends BaseCardInput {
  status?: Extract<CardStatus, 'success' | 'warning' | 'error'>;
}

export interface ConfirmCardInput extends BaseCardInput {
  confirmKey: string;
  confirmLabel?: string;
  cancelKey?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface ErrorCardInput extends BaseCardInput {
  retryKey?: string;
  retryLabel?: string;
}

export interface SelectionCardInput extends BaseCardInput {
  options: readonly CardAction[];
}

export function taskCard(input: TaskCardInput): AgentCard {
  return {
    kind: 'task',
    title: input.title,
    subtitle: input.subtitle,
    eyebrow: input.eyebrow ?? 'CODEX TASK',
    status: input.status,
    tone: input.tone ?? toneForStatus(input.status),
    body: input.body,
    fields: input.fields,
    steps: input.steps,
    actions: input.actions,
    taskId: input.taskId,
  };
}

export function resultCard(input: ResultCardInput): AgentCard {
  const status = input.status ?? 'success';
  return {
    kind: 'result',
    title: input.title,
    subtitle: input.subtitle,
    eyebrow: input.eyebrow ?? 'CODEX RESULT',
    status,
    tone: toneForStatus(status),
    body: input.body,
    fields: input.fields,
    actions: input.actions,
    taskId: input.taskId,
  };
}

export function confirmCard(input: ConfirmCardInput): AgentCard {
  return {
    kind: 'confirm',
    title: input.title,
    subtitle: input.subtitle,
    eyebrow: input.eyebrow ?? 'ACTION REQUIRED',
    status: 'warning',
    tone: input.danger ? 'danger' : 'warning',
    body: input.body,
    fields: input.fields,
    actions: [
      {
        key: input.confirmKey,
        label: input.confirmLabel ?? '确认',
        tone: input.danger ? 'danger' : 'primary',
      },
      {
        key: input.cancelKey ?? 'cancel',
        label: input.cancelLabel ?? '取消',
        tone: 'secondary',
      },
      ...(input.actions ?? []),
    ],
    taskId: input.taskId,
  };
}

export function errorCard(input: ErrorCardInput): AgentCard {
  const actions: CardAction[] = [];
  if (input.retryKey) {
    actions.push({
      key: input.retryKey,
      label: input.retryLabel ?? '重试',
      tone: 'primary',
    });
  }
  actions.push(...(input.actions ?? []));

  return {
    kind: 'error',
    title: input.title,
    subtitle: input.subtitle,
    eyebrow: input.eyebrow ?? 'CODEX ERROR',
    status: 'error',
    tone: 'danger',
    body: input.body,
    fields: input.fields,
    actions,
    taskId: input.taskId,
  };
}

export function selectionCard(input: SelectionCardInput): AgentCard {
  return {
    kind: 'selection',
    title: input.title,
    subtitle: input.subtitle,
    eyebrow: input.eyebrow ?? 'SELECT ACTION',
    status: 'idle',
    tone: 'info',
    body: input.body,
    fields: input.fields,
    actions: input.options,
    taskId: input.taskId,
  };
}

export function statusCard(input: BaseCardInput & { status: CardStatus }): AgentCard {
  return {
    kind: 'status',
    title: input.title,
    subtitle: input.subtitle,
    eyebrow: input.eyebrow ?? 'CODEX STATUS',
    status: input.status,
    tone: toneForStatus(input.status),
    body: input.body,
    fields: input.fields,
    actions: input.actions,
    taskId: input.taskId,
  };
}

function toneForStatus(status: CardStatus): CardTone {
  if (status === 'success') return 'success';
  if (status === 'warning' || status === 'stopping') return 'warning';
  if (status === 'error') return 'danger';
  if (status === 'running' || status === 'thinking' || status === 'queued') return 'info';
  return 'neutral';
}
