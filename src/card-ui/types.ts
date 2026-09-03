export type CardTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type CardStatus =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'running'
  | 'stopping'
  | 'success'
  | 'warning'
  | 'error';

export type CardStepStatus = 'pending' | 'running' | 'done' | 'error';

export interface CardField {
  label: string;
  value: string;
}

export interface CardStep {
  label: string;
  status: CardStepStatus;
}

export interface CardAction {
  key: string;
  label: string;
  tone?: 'primary' | 'secondary' | 'danger';
}

/**
 * Platform-neutral semantic card model.
 *
 * The bridge produces one of these cards and a platform renderer (WeCom today,
 * Lark/Slack later) decides how to map it to native UI primitives.
 */
export interface AgentCard {
  kind: 'task' | 'result' | 'confirm' | 'error' | 'selection' | 'status';
  title: string;
  subtitle?: string;
  eyebrow?: string;
  status?: CardStatus;
  tone?: CardTone;
  body?: string;
  fields?: readonly CardField[];
  steps?: readonly CardStep[];
  actions?: readonly CardAction[];
  taskId?: string;
}
