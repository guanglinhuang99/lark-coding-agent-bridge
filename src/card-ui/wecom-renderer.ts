import type { TemplateCard } from '@wecom/aibot-node-sdk';
import type { AgentCard, CardAction, CardStatus, CardStepStatus, CardTone } from './types';

/** Render the platform-neutral AgentCard as a compact WeCom "TUI" card. */
export function renderWeComAgentCard(card: AgentCard): TemplateCard {
  const buttons = (card.actions ?? []).slice(0, 3).map(renderAction);
  const fields = (card.fields ?? []).slice(0, 6).map((field) => ({
    keyname: clip(field.label, 12),
    value: clip(field.value, 26),
  }));

  return {
    card_type: 'button_interaction',
    source: {
      desc: clip(card.eyebrow ?? 'CODEX', 20),
      desc_color: toneColor(card.tone ?? 'neutral'),
    },
    main_title: {
      title: `${statusGlyph(card.status)} ${clip(card.title, 30)}`.trim(),
      desc: clip(card.subtitle ?? statusLabel(card.status), 30),
    },
    sub_title_text: clip(renderTuiBody(card), 112),
    ...(fields.length > 0 ? { horizontal_content_list: fields } : {}),
    ...(buttons.length > 0 ? { button_list: buttons } : {}),
    ...(card.taskId ? { task_id: card.taskId } : {}),
  };
}

/**
 * Small text surface that deliberately borrows terminal/TUI visual grammar.
 * We use only Unicode and plain text so it survives all WeCom clients.
 */
export function renderTuiBody(card: AgentCard): string {
  const lines: string[] = [];
  if (card.status) {
    lines.push(`${statusDot(card.status)} ${statusLabel(card.status).toUpperCase()}`);
  }
  if (card.body?.trim()) lines.push(clip(singleLine(card.body), 72));

  const steps = (card.steps ?? []).slice(0, 4);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const branch = index === steps.length - 1 ? '└' : '├';
    lines.push(`${branch} ${stepGlyph(step.status)} ${clip(singleLine(step.label), 54)}`);
  }

  return lines.join('\n') || '○ READY';
}

function renderAction(action: CardAction): { text: string; key: string; style: 1 | 2 | 4 } {
  return {
    text: clip(action.label, 12),
    key: action.key,
    style: action.tone === 'danger' ? 4 : action.tone === 'secondary' ? 2 : 1,
  };
}

function toneColor(tone: CardTone): 0 | 1 | 2 | 3 {
  if (tone === 'success') return 1;
  if (tone === 'warning' || tone === 'danger') return 2;
  if (tone === 'info') return 0;
  return 3;
}

function statusGlyph(status: CardStatus | undefined): string {
  if (status === 'success') return '✓';
  if (status === 'error') return '×';
  if (status === 'warning' || status === 'stopping') return '!';
  if (status === 'running' || status === 'thinking' || status === 'queued') return '●';
  return '○';
}

function statusDot(status: CardStatus): string {
  if (status === 'success') return '●';
  if (status === 'error') return '●';
  if (status === 'warning' || status === 'stopping') return '●';
  if (status === 'running' || status === 'thinking' || status === 'queued') return '●';
  return '○';
}

function statusLabel(status: CardStatus | undefined): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'thinking':
      return 'Thinking';
    case 'running':
      return 'Running';
    case 'stopping':
      return 'Stopping';
    case 'success':
      return 'Completed';
    case 'warning':
      return 'Attention';
    case 'error':
      return 'Failed';
    case 'idle':
    default:
      return 'Ready';
  }
}

function stepGlyph(status: CardStepStatus): string {
  if (status === 'done') return '✓';
  if (status === 'running') return '⟳';
  if (status === 'error') return '×';
  return '○';
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string, maxCodePoints: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxCodePoints) return value;
  if (maxCodePoints <= 1) return chars.slice(0, maxCodePoints).join('');
  return `${chars.slice(0, maxCodePoints - 1).join('')}…`;
}
