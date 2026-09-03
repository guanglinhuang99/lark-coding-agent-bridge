import type { TemplateCard } from '@wecom/aibot-node-sdk';
import type { RiskSelectionOption, RiskSelectionRequest } from './router';
import { WECOM_CARD_ACTIONS } from '../ui/actions';
import { renderWeComCard } from '../ui/renderer';

export type RiskSelectionResolution =
  | {
      status: 'selected';
      selection: RiskSelectionRequest;
      option: RiskSelectionOption;
    }
  | { status: 'invalid'; selection: RiskSelectionRequest }
  | { status: 'missing' | 'expired' | 'mismatch' };

interface RiskSelectionTask {
  conversationKey: string;
  selection: RiskSelectionRequest;
}

export class RiskSelectionTaskRegistry {
  private readonly tasks = new Map<string, RiskSelectionTask>();

  constructor(private readonly now: () => number = Date.now) {}

  register(
    taskId: string,
    conversationKey: string,
    selection: RiskSelectionRequest,
  ): void {
    this.clearConversation(conversationKey);
    this.tasks.set(taskId, { conversationKey, selection });
  }

  resolve(
    taskId: string,
    conversationKey: string,
    selectedKey: string,
  ): RiskSelectionResolution {
    const task = this.tasks.get(taskId);
    if (!task) return { status: 'missing' };
    if (task.selection.expiresAt <= this.now()) {
      this.tasks.delete(taskId);
      return { status: 'expired' };
    }
    if (task.conversationKey !== conversationKey) return { status: 'mismatch' };
    const option = task.selection.options.find((item) => item.key === selectedKey);
    if (!option) return { status: 'invalid', selection: task.selection };
    this.tasks.delete(taskId);
    return { status: 'selected', selection: task.selection, option };
  }

  has(taskId: string, conversationKey: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.conversationKey !== conversationKey) return false;
    if (task.selection.expiresAt <= this.now()) {
      this.tasks.delete(taskId);
      return false;
    }
    return true;
  }

  remove(taskId: string): void {
    this.tasks.delete(taskId);
  }

  clearConversation(conversationKey: string): void {
    for (const [taskId, task] of this.tasks) {
      if (task.conversationKey === conversationKey) this.tasks.delete(taskId);
    }
  }
}

export function buildRiskSelectionCard(
  selection: RiskSelectionRequest,
  taskId: string,
): TemplateCard {
  const options = selection.options;
  if (options.length === 0 || options.length > 10) {
    throw new Error(`Risk selection card requires 1-10 options; received ${options.length}`);
  }

  const candidateLabel =
    selection.kind === 'product' || selection.kind === 'intent-account'
      ? '账户'
      : selection.kind === 'security' || selection.kind === 'intent-security'
        ? '证券'
        : '交易';

  if (options.length === 1) {
    return renderWeComCard({
      kind: 'interactive',
      taskId,
      source: '风险限额查询',
      title: selection.title,
      description: selection.replyHint,
      subtitle: selection.subTitle,
      facts: [{ label: candidateLabel, value: clip(options[0]?.label ?? '', 26) }],
      buttons: [
        {
          text: '确认选择',
          key: options[0]?.key ?? '1',
          variant: 'primary',
        },
      ],
    });
  }

  return renderWeComCard({
    kind: 'interactive',
    taskId,
    source: '风险限额查询',
    title: selection.title,
    description: selection.replyHint,
    subtitle: selection.subTitle,
    selection: {
      questionKey: `risk_${selection.kind}`,
      title: selection.title,
      options: options.map((option) => ({
        id: option.key,
        text: clip(option.label, 60),
      })),
    },
    buttons: [
      {
        text: '确认选择',
        key: WECOM_CARD_ACTIONS.selection.submit,
        variant: 'primary',
      },
    ],
  });
}

export function buildRiskSelectionStatusCard(
  taskId: string,
  title: string,
  description: string,
  selectedLabel?: string,
): TemplateCard {
  return renderWeComCard({
    kind: 'notice',
    taskId,
    source: '风险限额查询',
    title,
    description,
    ...(selectedLabel ? { subtitle: clip(selectedLabel, 112) } : {}),
  });
}

function clip(value: string, maxLength: number): string {
  const chars = [...value];
  if (chars.length <= maxLength) return value;
  return chars.slice(0, maxLength).join('');
}
