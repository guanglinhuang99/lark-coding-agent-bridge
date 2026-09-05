import type { TemplateCard } from '@wecom/aibot-node-sdk';
import type { RiskSelectionOption, RiskSelectionRequest } from './router';
import { WECOM_CARD_ACTIONS } from '../ui/actions';
import {
  buildConfirmationCardView,
  buildNoticeCardView,
  buildSelectionCardView,
} from '../ui/builders';
import { renderWeComCard } from '../ui/renderer';

export type RiskSelectionResolution =
  | {
      status: 'selected';
      selection: RiskSelectionRequest;
      option: RiskSelectionOption;
    }
  | { status: 'invalid'; selection: RiskSelectionRequest }
  | { status: 'missing' | 'expired' | 'mismatch' };

/** A stale WeCom card must not abort the follow-up measurement path. */
export async function updateRiskCardBestEffort(
  update: () => Promise<unknown>,
  onError: (error: unknown) => void = () => {},
): Promise<void> {
  try {
    await update();
  } catch (error) {
    onError(error);
  }
}

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
    return renderWeComCard(
      buildConfirmationCardView({
        taskId,
        source: '风险限额查询',
        title: selection.title,
        description: selection.replyHint,
        facts: [{ label: candidateLabel, value: clip(options[0]?.label ?? '', 26) }],
        confirmKey: options[0]?.key ?? '1',
        confirmText: '确认选择',
      }),
    );
  }

  return renderWeComCard(
    buildSelectionCardView({
      taskId,
      source: '风险限额查询',
      title: selection.title,
      description: selection.replyHint,
      subtitle: selection.subTitle,
      questionKey: `risk_${selection.kind}`,
      options: options.map((option) => ({
        id: option.key,
        text: clip(option.label, 60),
      })),
      submitKey: WECOM_CARD_ACTIONS.selection.submit,
      submitText: '确认选择',
    }),
  );
}

export function buildRiskSelectionStatusCard(
  taskId: string,
  title: string,
  description: string,
  selectedLabel?: string,
): TemplateCard {
  const status = /失败|错误|无效|无法|未授权|过期/.test(title)
    ? 'error'
    : /已收到|已确认/.test(title)
      ? 'running'
      : /补充|修改|选择|确认/.test(title)
        ? 'warning'
        : /完成|成功/.test(title)
          ? 'success'
          : 'running';
  return renderWeComCard(
    buildNoticeCardView({
      taskId,
      source: '风险限额查询',
      title,
      description,
      status,
      ...(selectedLabel ? { subtitle: clip(selectedLabel, 112) } : {}),
    }),
  );
}

function clip(value: string, maxLength: number): string {
  const chars = [...value];
  if (chars.length <= maxLength) return value;
  return chars.slice(0, maxLength).join('');
}
