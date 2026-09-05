import type { TemplateCard } from '@wecom/aibot-node-sdk';
import type {
  WeComCardView,
  WeComTuiStatus,
  WeComTuiStepStatus,
} from './model';
import { buttonStyle } from './theme';

export function renderWeComCard(view: WeComCardView): TemplateCard {
  const source = view.tui?.eyebrow ?? view.source;
  const title = view.tui
    ? `${statusGlyph(view.tui.status)} ${view.title}`.trim()
    : view.title;
  const subtitle = view.tui ? renderTuiPanel(view) : view.subtitle;
  if (view.kind === 'notice') {
    return {
      card_type: 'text_notice',
      card_action: { type: 1, url: view.noticeUrl ?? 'https://work.weixin.qq.com/' },
      source: {
        desc: clip(view.tui ? `▌ ${source}` : source, 20),
        ...(view.sourceColor === undefined ? {} : { desc_color: view.sourceColor }),
      },
      main_title: {
        title: clip(title, 30),
        ...(view.description ? { desc: view.description } : {}),
      },
      ...(subtitle ? { sub_title_text: clip(subtitle, 112) } : {}),
      ...(view.facts?.length
        ? {
            horizontal_content_list: view.facts.map((fact) => ({
              keyname: fact.label,
              value: fact.value,
            })),
          }
        : {}),
      task_id: view.taskId,
    };
  }

  return {
    card_type: 'button_interaction',
    card_action: { type: 0 },
    source: {
      desc: clip(view.tui ? `▌ ${source}` : source, 20),
      ...(view.sourceColor === undefined ? {} : { desc_color: view.sourceColor }),
    },
    main_title: {
      title: clip(title, 30),
      ...(view.description ? { desc: view.description } : {}),
    },
    ...(subtitle ? { sub_title_text: clip(subtitle, 112) } : {}),
    ...(view.facts?.length
      ? {
          horizontal_content_list: view.facts.map((fact) => ({
            keyname: fact.label,
            value: fact.value,
          })),
        }
      : {}),
    ...(view.selection
      ? {
          button_selection: {
            question_key: view.selection.questionKey,
            title: view.selection.title,
            option_list: view.selection.options,
          },
        }
      : {}),
    ...(view.buttons?.length
      ? {
          button_list: view.buttons.map((button) => ({
            text: button.text,
            key: button.key,
            style: buttonStyle(button.variant),
          })),
        }
      : {}),
    task_id: view.taskId,
  };
}

export function renderTuiPanel(view: WeComCardView): string {
  if (!view.tui) return view.subtitle ?? '';
  const lines = [`▌ ${statusGlyph(view.tui.status)} ${statusLabel(view.tui.status)}`];
  if (view.tui.body?.trim()) lines.push(`┃ ${singleLine(view.tui.body)}`);
  if (view.tui.steps?.length && view.tui.body?.trim()) lines.push('┃');
  const steps = (view.tui.steps ?? []).slice(0, 4);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    lines.push(
      `${index === steps.length - 1 ? '└─' : '├─'} ${stepGlyph(step.status)} ${singleLine(step.label)}`,
    );
  }
  return lines.join('\n');
}

function statusGlyph(status: WeComTuiStatus): string {
  if (status === 'success') return '✓';
  if (status === 'error') return '×';
  if (status === 'warning' || status === 'stopping') return '!';
  if (status === 'thinking' || status === 'running' || status === 'streaming' || status === 'queued') return '●';
  if (status === 'stopped') return '■';
  return '○';
}

function statusLabel(status: WeComTuiStatus): string {
  if (status === 'queued') return 'QUEUED';
  if (status === 'thinking') return 'THINKING';
  if (status === 'running') return 'RUNNING';
  if (status === 'streaming') return 'STREAMING';
  if (status === 'stopping') return 'STOPPING';
  if (status === 'success') return 'COMPLETED';
  if (status === 'warning') return 'ACTION REQUIRED';
  if (status === 'error') return 'FAILED';
  if (status === 'stopped') return 'STOPPED';
  return 'READY';
}

function stepGlyph(status: WeComTuiStepStatus): string {
  if (status === 'done') return '✓';
  if (status === 'running') return '⟳';
  if (status === 'error') return '×';
  return '○';
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string, maxCodePoints: number): string {
  const characters = Array.from(value);
  return characters.length > maxCodePoints
    ? `${characters.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
    : value;
}
