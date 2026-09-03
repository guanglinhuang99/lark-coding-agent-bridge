import type { WeComCardButtonVariant, WeComCardColor } from './model';

export type WeComUiStatus =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'running'
  | 'streaming'
  | 'success'
  | 'warning'
  | 'error'
  | 'stopped';

export const WECOM_UI_ICONS = {
  agent: '🤖',
  thinking: '🧠',
  running: '⚙️',
  tool: '🛠',
  workspace: '📂',
  success: '✅',
  warning: '⚠️',
  error: '❌',
  stopped: '⏹',
  queued: '⏳',
} as const;

export function statusColor(status: WeComUiStatus): WeComCardColor {
  switch (status) {
    case 'thinking':
    case 'running':
    case 'streaming':
      return 0;
    case 'success':
      return 1;
    case 'warning':
    case 'error':
      return 2;
    case 'idle':
    case 'queued':
    case 'stopped':
      return 3;
  }
}

export function buttonStyle(variant: WeComCardButtonVariant = 'secondary'): 1 | 2 | 4 {
  switch (variant) {
    case 'primary':
      return 1;
    case 'secondary':
      return 2;
    case 'danger':
      return 4;
  }
}
