import type { TemplateCard } from '@wecom/aibot-node-sdk';
import type { RiskSelectionOption, RiskSelectionRequest } from './router';

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

  const base: TemplateCard = {
    card_type: 'button_interaction',
    source: { desc: '风险限额查询' },
    main_title: {
      title: selection.title,
      desc: selection.replyHint,
    },
    sub_title_text: selection.subTitle,
    task_id: taskId,
  };

  if (options.length === 1) {
    base.horizontal_content_list = [
      {
        keyname: selection.kind === 'product' ? '账户' : '证券',
        value: clip(options[0]?.label ?? '', 26),
      },
    ];
    base.button_list = [{ text: '确认选择', key: options[0]?.key ?? '1', style: 1 }];
    return base;
  }

  if (options.length <= 6) {
    base.button_list = options.map((option) => ({
      text: clip(`${option.key}.${option.label}`, 20),
      key: option.key,
      style: 1,
    }));
    return base;
  }

  base.button_selection = {
    question_key: `risk_${selection.kind}`,
    title: selection.title,
    option_list: options.map((option) => ({
      id: option.key,
      text: clip(`${option.key}.${option.label}`, 20),
    })),
  };
  base.button_list = [{ text: '确认选择', key: 'submit', style: 1 }];
  return base;
}

export function buildRiskSelectionStatusCard(
  taskId: string,
  title: string,
  description: string,
  selectedLabel?: string,
): TemplateCard {
  return {
    card_type: 'text_notice',
    source: { desc: '风险限额查询' },
    main_title: { title, desc: description },
    ...(selectedLabel ? { sub_title_text: clip(selectedLabel, 112) } : {}),
    task_id: taskId,
  };
}

function clip(value: string, maxLength: number): string {
  const chars = [...value];
  if (chars.length <= maxLength) return value;
  return chars.slice(0, maxLength).join('');
}
