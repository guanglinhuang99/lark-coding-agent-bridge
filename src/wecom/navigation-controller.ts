import path from 'node:path';
import type {
  EventMessageWith,
  TemplateCard,
  TemplateCardEventData,
  WsFrame,
} from '@wecom/aibot-node-sdk';
import { formatRelTime } from '../session/history';
import { log } from '../core/logger';
import type { WeComConversationBindings } from './conversation-bindings';
import type { WeComWorkspace } from './workspace-config';
import {
  navigationActionForPurpose,
  type WeComCardPurpose,
} from './card-routing';
import {
  setConversationModel,
  setConversationReasoningEffort,
  type ConversationAgentPreferences,
} from './agent-preferences';
import { weComModelOptions } from './model-options';
import type { WeComCardStatus } from './presentation';
import {
  buildErrorCardView,
  buildNoticeCardView,
} from './ui/builders';
import {
  buildHomeCardView,
  buildModelSelectionCardView,
  buildReasoningSelectionCardView,
  buildSessionSelectionCardView,
  buildWorkspaceSelectionCardView,
  type WeComHomeCardOptions,
  type WeComSessionOption,
  type WeComWorkspaceOption,
} from './ui/navigation';
import {
  type NavigationCardPurpose,
  type NavigationSelectionResult,
  type WeComNavigationCardRegistry,
} from './ui/navigation-registry';
import { renderWeComCard } from './ui/renderer';

export type NavigationTemplateCardEventFrame = WsFrame<EventMessageWith<TemplateCardEventData>>;

export interface NavigationControllerDependencies {
  sessionStore: WeComConversationBindings;
  navigationCards: WeComNavigationCardRegistry;
  configuredWorkspaces: readonly WeComWorkspace[];
  navigationCardTtlMs: number;
  startupModel: string;
  configuredModelAllowlist: readonly string[];
  conversationAgentPreferences: Map<string, ConversationAgentPreferences>;
  createNavigationTaskId(purpose: NavigationCardPurpose): string;
  effectiveModel(key: string): string;
  effectiveReasoningEffort(key: string): string;
  currentThreadId(key: string): string | undefined;
  isConversationBusy(key: string): boolean;
  recentTaskHint(key: string): string | undefined;
  replyTemplateCard(frame: WsFrame, card: TemplateCard): Promise<unknown>;
  updateTemplateCard(frame: NavigationTemplateCardEventFrame, card: TemplateCard): Promise<unknown>;
  deliverControlCard(frame: WsFrame, card: TemplateCard): Promise<void>;
  replyControl(
    frame: WsFrame,
    key: string,
    title: string,
    lines: readonly string[],
    status: WeComCardStatus,
    notice: string,
  ): Promise<void>;
  replyOnce(frame: WsFrame, title: string, lines: readonly string[]): Promise<void>;
}

/** Navigation and selection UI orchestration; run lifecycle remains in cli.ts. */
export class NavigationController {
  constructor(private readonly deps: NavigationControllerDependencies) {}

  homeCardOptions(
    key: string,
    taskId = this.deps.createNavigationTaskId('menu'),
  ): WeComHomeCardOptions {
    const workspace = this.deps.sessionStore.workspaceFor(key);
    this.registerHomeCard(taskId, key);
    return {
      taskId,
      busy: this.deps.isConversationBusy(key),
      workspace,
      model: this.deps.effectiveModel(key),
      reasoning: this.deps.effectiveReasoningEffort(key),
      threadId: this.deps.currentThreadId(key),
      recentTask: this.deps.recentTaskHint(key),
    };
  }

  async replyHomeCard(frame: WsFrame, key: string): Promise<void> {
    await this.deps.replyTemplateCard(
      frame,
      renderWeComCard(buildHomeCardView(this.homeCardOptions(key))),
    );
  }

  async replyWorkspaceSelection(frame: WsFrame, key: string): Promise<void> {
    const workspace = this.deps.sessionStore.workspaceFor(key);
    const taskId = this.deps.createNavigationTaskId('workspace');
    const current = path.resolve(workspace);
    const options: WeComWorkspaceOption[] = this.deps.configuredWorkspaces.map((entry) => ({
      id: entry.id,
      label: `${entry.name}${path.resolve(entry.cwd) === current ? '（当前）' : ''}`,
    }));
    this.registerNavigationTask(
      taskId,
      'workspace',
      key,
      options.map((item) => [item.id, item.label]),
    );
    await this.deps.replyTemplateCard(
      frame,
      renderWeComCard(buildWorkspaceSelectionCardView({ taskId, workspaces: options })),
    );
  }

  async switchWorkspace(
    key: string,
    selectedId: string,
  ): Promise<{ key: string; workspace: WeComWorkspace } | undefined> {
    const entry = this.workspaceById(selectedId);
    if (!entry) return undefined;
    const chatKey = this.deps.sessionStore.conversationScope(key);
    const targetKey = this.deps.sessionStore.captureScope(chatKey, entry.cwd);
    await this.deps.sessionStore.bindWorkspace(chatKey, entry.cwd);
    return { key: targetKey, workspace: entry };
  }

  async applyWorkspaceSelection(
    frame: WsFrame,
    key: string,
    selectedId: string,
  ): Promise<void> {
    const entry = this.workspaceById(selectedId);
    if (!entry) {
      await this.deps.replyOnce(frame, '无法切换 Workspace', [
        `未找到 \`${selectedId}\`。可用 ID：${this.deps.configuredWorkspaces.map((item) => item.id).join('、')}`,
      ]);
      return;
    }
    try {
      const switched = await this.switchWorkspace(key, selectedId);
      if (!switched) throw new Error('Workspace selection disappeared');
      await this.deps.replyControl(
        frame,
        switched.key,
        '✅ 已切换 Workspace',
        [
          `当前工作区：\`${entry.name}\``,
          '后续新消息立即使用该工作区；正在运行或排队的任务继续使用原工作区。',
        ],
        this.deps.isConversationBusy(switched.key) ? 'running' : 'idle',
        `已切换到 ${entry.name}`,
      );
    } catch (err) {
      log.fail('wecom-workspace', err, { step: 'switch' });
      await this.deps.replyOnce(frame, '无法确认 Workspace 切换结果', [
        '请发送 `/workspace` 查看当前工作区后再继续。',
      ]);
    }
  }

  async replyModelSelection(frame: WsFrame, key: string): Promise<void> {
    const taskId = this.deps.createNavigationTaskId('model');
    const options = this.modelSelectionOptions(key);
    this.registerNavigationTask(
      taskId,
      'model',
      key,
      options.map((item) => [item.id, item.text]),
    );
    await this.deps.replyTemplateCard(
      frame,
      renderWeComCard(buildModelSelectionCardView({ taskId, models: options })),
    );
  }

  async replyReasoningSelection(frame: WsFrame, key: string): Promise<void> {
    const taskId = this.deps.createNavigationTaskId('reasoning');
    const options = this.reasoningSelectionOptions(key);
    this.registerNavigationTask(
      taskId,
      'reasoning',
      key,
      options.map((item) => [item.id, item.text]),
    );
    await this.deps.replyTemplateCard(
      frame,
      renderWeComCard(buildReasoningSelectionCardView({ taskId, levels: options })),
    );
  }

  async replySessionSelection(frame: WsFrame, key: string): Promise<void> {
    if (key.startsWith('group:')) {
      await this.replyNoticeCard(frame, {
        taskId: this.deps.createNavigationTaskId('session'),
        title: '🧵 请在私聊中恢复会话',
        description: '为保护历史会话隐私，请在与机器人的私聊中使用 /resume。',
      });
      return;
    }
    const workspace = this.deps.sessionStore.workspaceFor(key);
    const taskId = this.deps.createNavigationTaskId('session');
    const sessions: WeComSessionOption[] = this.deps.sessionStore.sessionsFor(key).map((entry) => ({
      id: entry.threadId,
      label: `Codex 会话 ${entry.threadId.slice(0, 8)}`,
      workspace: path.basename(workspace),
      ...(entry.updatedAt > 0 ? { hint: formatRelTime(entry.updatedAt) } : {}),
    }));
    if (sessions.length === 0) {
      await this.replyNoticeCard(frame, {
        taskId,
        title: '🧵 没有可恢复的会话',
        description: `工作区 ${path.basename(workspace)} 暂无当前聊天可恢复的 Codex 会话。`,
      });
      return;
    }
    this.registerNavigationTask(
      taskId,
      'session',
      key,
      sessions.map((item) => [item.id, item.label]),
    );
    await this.deps.replyTemplateCard(
      frame,
      renderWeComCard(buildSessionSelectionCardView({ taskId, sessions })),
    );
  }

  async handleNavigationCardEvent(
    frame: NavigationTemplateCardEventFrame,
    key: string,
    taskId: string,
    purpose: Exclude<WeComCardPurpose, 'menu' | 'codex' | 'queue' | 'risk' | 'unknown'>,
    rawAction: string | undefined,
    selectedId: string | undefined,
  ): Promise<void> {
    if (purpose === 'session' && key.startsWith('group:')) {
      await this.updateInvalidCallback(frame, taskId);
      return;
    }
    if (rawAction !== navigationActionForPurpose(purpose)) {
      await this.updateInvalidCallback(frame, taskId);
      return;
    }
    const resolution = this.deps.navigationCards.resolve(taskId, key);
    if (resolution.status !== 'resolved') {
      await this.updateCardLifecycleError(frame, taskId, resolution);
      return;
    }
    if (resolution.card.purpose !== purpose) {
      await this.updateInvalidCallback(frame, taskId);
      return;
    }
    const optionLabels = resolution.card.payload?.optionLabels;
    if (!optionLabels || !selectedId || !optionLabels.has(selectedId)) {
      await this.updateInvalidCallback(frame, taskId);
      return;
    }

    if (purpose === 'session' && this.deps.isConversationBusy(key)) {
      await this.replyNavigationResult(
        frame,
        key,
        taskId,
        '当前任务仍在运行，请先停止后再恢复会话。',
        'warning',
        '⚠️ 暂不能恢复会话',
      );
      return;
    }

    const selection = this.deps.navigationCards.consumeSelection(taskId, key, purpose, selectedId);
    if (selection.status === 'invalid' || selection.status === 'purpose-mismatch') {
      await this.updateInvalidCallback(frame, taskId);
      return;
    }
    if (selection.status !== 'selected') {
      await this.updateCardLifecycleError(frame, taskId, selection);
      return;
    }
    const label = selection.label;
    if (purpose === 'workspace') {
      try {
        const switched = await this.switchWorkspace(key, selection.selectedId);
        if (!switched) {
          await this.updateInvalidCallback(frame, taskId);
          return;
        }
        await this.replyNavigationResult(
          frame,
          switched.key,
          taskId,
          `已切换到 Workspace：${switched.workspace.name}。后续新消息立即使用该工作区；正在运行或排队的任务继续使用原工作区。`,
          'success',
          '✅ Workspace 已切换',
        );
      } catch (err) {
        log.fail('wecom-workspace', err, { step: 'card-switch' });
        await this.updateInvalidCallback(frame, taskId);
      }
      return;
    }
    if (purpose === 'model') {
      setConversationModel(this.deps.conversationAgentPreferences, key, selectedId);
    }
    if (purpose === 'reasoning') {
      setConversationReasoningEffort(this.deps.conversationAgentPreferences, key, selectedId);
    }
    if (purpose === 'session') {
      const allowed = this.deps.sessionStore.sessionsFor(key).some((entry) => entry.threadId === selectedId);
      if (!allowed) {
        await this.updateInvalidCallback(frame, taskId);
        return;
      }
      await this.deps.sessionStore.setThread(key, selectedId);
    }

    const message =
      purpose === 'session'
        ? `已恢复会话：${label}`
        : `已应用${purpose === 'model' ? '模型' : '推理强度'}：${label}（当前会话后续新任务生效）`;
    await this.replyNavigationResult(
      frame,
      key,
      taskId,
      message,
      'success',
      '✅ 操作已处理',
    );
  }

  async replyNavigationResult(
    frame: NavigationTemplateCardEventFrame,
    key: string,
    taskId: string,
    message: string,
    status: 'success' | 'warning',
    title: string,
  ): Promise<void> {
    await this.deps.updateTemplateCard(
      frame,
      renderWeComCard(
        buildNoticeCardView({
          taskId,
          source: 'Codex Bridge',
          title,
          description: message,
          subtitle: '可继续使用下方最新控制卡片。',
          status,
        }),
      ),
    );
    await this.deps.deliverControlCard(
      frame,
      renderWeComCard(buildHomeCardView(this.homeCardOptions(key))),
    );
  }

  async replyNoticeCard(
    frame: WsFrame,
    options: { taskId: string; title: string; description: string },
  ): Promise<void> {
    await this.deps.replyTemplateCard(
      frame,
      renderWeComCard(
        buildNoticeCardView({
          ...options,
          source: 'Codex Bridge',
          status: 'warning',
        }),
      ),
    );
  }

  async updateHomeCard(
    frame: NavigationTemplateCardEventFrame,
    key: string,
    taskId: string,
  ): Promise<void> {
    await this.deps.updateTemplateCard(
      frame,
      renderWeComCard(buildHomeCardView(this.homeCardOptions(key, taskId))),
    );
  }

  async updateInvalidCallback(
    frame: NavigationTemplateCardEventFrame,
    taskId: string,
  ): Promise<void> {
    await this.deps.updateTemplateCard(
      frame,
      renderWeComCard(buildErrorCardView({ taskId, kind: 'callback-invalid' })),
    );
  }

  async updateCardLifecycleError(
    frame: NavigationTemplateCardEventFrame,
    taskId: string,
    result: NavigationSelectionResult,
  ): Promise<void> {
    await this.deps.updateTemplateCard(
      frame,
      renderWeComCard(
        buildErrorCardView({
          taskId,
          kind: result.status === 'mismatch' ? 'callback-invalid' : 'callback-expired',
        }),
      ),
    );
  }

  private workspaceById(id: string): WeComWorkspace | undefined {
    return this.deps.configuredWorkspaces.find((entry) => entry.id === id);
  }

  private registerNavigationTask(
    taskId: string,
    purpose: NavigationCardPurpose,
    key: string,
    options: readonly [string, string][],
  ): void {
    this.deps.navigationCards.register({
      taskId,
      purpose,
      conversationKey: key,
      optionLabels: new Map(options),
      expiresAt: Date.now() + this.deps.navigationCardTtlMs,
    });
  }

  private registerHomeCard(taskId: string, key: string): void {
    this.deps.navigationCards.register({
      taskId,
      purpose: 'menu',
      conversationKey: key,
      expiresAt: Date.now() + this.deps.navigationCardTtlMs,
    });
  }

  private modelSelectionOptions(key: string) {
    const currentModel = this.deps.effectiveModel(key);
    return weComModelOptions({
      startupModel: this.deps.startupModel,
      currentModel,
      configuredModels: this.deps.configuredModelAllowlist,
    }).map((item) => ({ id: item.value, text: item.label }));
  }

  private reasoningSelectionOptions(key: string) {
    const currentReasoningEffort = this.deps.effectiveReasoningEffort(key);
    const known = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({
      id,
      text: id,
    }));
    return [
      { id: currentReasoningEffort, text: `${currentReasoningEffort}（当前）` },
      ...known.filter((item) => item.id !== currentReasoningEffort),
    ];
  }
}
