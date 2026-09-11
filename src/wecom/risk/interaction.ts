import type {
  EventMessageWith,
  TemplateCard,
  TemplateCardEventData,
  WsFrame,
} from '@wecom/aibot-node-sdk';
import { log, reportMetric } from '../../core/logger';
import {
  type ConversationBody,
  type WeComConversationQueue,
  WeComConversationQueueError,
  WeComRunCapacityError,
  type WeComRunGate,
  withReservation,
} from '../runtime';
import {
  renderWeComNotice,
  renderWeComRiskOutput,
  truncateUtf8,
} from '../presentation';
import {
  capacityNotice,
  conversationQueueNotice,
} from '../reliability';
import {
  buildErrorCardView,
} from '../ui/builders';
import { renderWeComCard } from '../ui/renderer';
import type { RiskService } from './client';
import { splitRiskMessage } from '../../business/risk/presentation';
import { RiskApplication, riskIntentInputPrompt, type RiskReply } from '../../business/risk/application';
import {
  buildRiskSelectionCard,
  buildRiskSelectionStatusCard,
  type RiskSelectionTaskRegistry,
  updateRiskCardBestEffort,
} from './card';
import {
  buildIntentSelection,
  confirmationSummary,
  type RiskIntentState,
} from './intent';
import { RiskProgressRelay } from './progress';
import type {
  RiskQueryState,
  RiskSelectionRequest,
  WeComRiskRouter,
} from './router';
import type { RiskConversationState, RiskStateRegistry } from './state';

export type RiskTemplateCardEventFrame = WsFrame<EventMessageWith<TemplateCardEventData>>;

export interface RiskStreamTarget {
  update(content: string): Promise<unknown>;
  finish(content: string): Promise<unknown>;
}

export type RiskSelectionExecution =
  | { kind: 'pretrade'; state: Extract<RiskIntentState, { stage: 'confirm' }> }
  | { kind: 'query'; state: RiskQueryState; input: string };

export interface RiskInteractionDependencies {
  application?: RiskApplication;
  riskClient?: RiskService;
  riskRouter?: WeComRiskRouter;
  riskStates: RiskStateRegistry;
  riskSelectionTasks: RiskSelectionTaskRegistry;
  conversationQueue: Pick<WeComConversationQueue, 'submit'>;
  runGate: Pick<WeComRunGate, 'run'>;
  startingRuns: Set<string>;
  streamMaxBytes: number;
  selectionCardDelayMs?: number;
  refreshHealth(): Promise<void>;
  isRiskUserAllowed(userid: string | undefined): boolean;
  updateTemplateCard(frame: RiskTemplateCardEventFrame, card: TemplateCard): Promise<unknown>;
  sendMarkdownMessage(body: ConversationBody, content: string): Promise<unknown>;
  sendControlCardMessage(body: ConversationBody, card: TemplateCard): Promise<void>;
  createRiskTaskId(): string;
}

/**
 * WeCom presentation and validated callback transport only.
 * RiskApplication owns every business transition; this adapter only registers views.
 */
export class RiskInteractionController {
  private readonly selectionCardDelayMs: number;
  private readonly application: RiskApplication;

  constructor(private readonly deps: RiskInteractionDependencies) {
    this.selectionCardDelayMs = deps.selectionCardDelayMs ?? 200;
    this.application = deps.application ?? new RiskApplication({
      service: deps.riskClient, router: deps.riskRouter, states: deps.riskStates,
      invalidateSelections: key => deps.riskSelectionTasks.clearConversation(key),
    });
  }

  /** Transport/presentation only: decisions and state changes were made by RiskApplication. */
  async renderReply(body: ConversationBody, key: string, stream: RiskStreamTarget, reply: RiskReply): Promise<void> {
    if (!reply.handled) return;
    if (reply.kind === 'notice') {
      await stream.finish(truncateUtf8(renderWeComNotice(reply.title, reply.lines, {
        status: reply.level === 'info' ? 'running' : reply.level, eyebrow: 'RISK · WECOM',
      }), this.deps.streamMaxBytes));
    } else if (reply.kind === 'intent') {
      await this.finishIntentState(body, key, stream, reply.state);
    } else if (reply.kind === 'pages') {
      await stream.finish(reply.pages[0] ?? '没有可展示的结果。');
      for (const page of reply.pages.slice(1)) await this.deps.sendMarkdownMessage(body, page);
    } else {
      const result = reply.result;
      const content = renderWeComRiskOutput(result.markdown, Boolean(result.selection));
      if (reply.confirmed) {
        await stream.finish(renderWeComNotice(result.intent === 'risk-error' ? '风险限额测算失败' : '风险限额测算完成',
          ['请查看下方业务结果。']));
        await this.sendRiskMarkdown(body, content);
      } else {
        const pages = splitRiskMessage(content, this.deps.streamMaxBytes);
        await stream.finish(pages[0] ?? '没有可展示的结果。');
        for (const page of pages.slice(1)) await this.deps.sendMarkdownMessage(body, page);
      }
      if (result.selection && result.continuation) {
        this.scheduleSelectionCard(body, key, result.selection, { kind: 'query', state: result.continuation });
      }
    }
  }

  async finishIntentState(
    body: ConversationBody,
    key: string,
    stream: RiskStreamTarget,
    state: RiskIntentState,
  ): Promise<void> {
    if (state.stage === 'freeform') {
      await stream.finish(
        renderWeComNotice('请补充信息', [riskIntentInputPrompt(state)], {
          status: 'warning',
          eyebrow: 'RISK · WECOM',
        }),
      );
      return;
    }
    const selection = buildIntentSelection(state, Date.now() + 5 * 60_000);
    if (state.stage === 'confirm' && (state.draft.accounts || state.draft.transactions)) {
      const details = confirmationSummary(state);
      const chunks: string[] = [];
      let chunk = '';
      const budget = Math.max(256, this.deps.streamMaxBytes - 512);
      for (const line of details.split(/(?<=\n)/u)) {
        if (chunk && Buffer.byteLength(chunk + line, 'utf8') > budget) {
          chunks.push(chunk);
          chunk = '';
        }
        for (const character of line) {
          if (Buffer.byteLength(chunk + character, 'utf8') > budget) {
            chunks.push(chunk);
            chunk = '';
          }
          chunk += character;
        }
      }
      if (chunk) chunks.push(chunk);
      await stream.finish(renderWeComNotice('请确认全部交易', [
        state.draft.accounts
          ? `多个账户、共${state.draft.accounts.reduce((sum, account) => sum + account.transactions.length, 0)}笔；请核对后按账户分别测算。`
          : `共${state.draft.transactions!.length}笔，请核对下方全部明细后确认合并测算。`,
      ]));
      for (const detail of chunks) await this.sendRiskMarkdown(body, detail);
      selection.subTitle = state.draft.accounts
        ? `多个账户、共${state.draft.accounts.reduce((sum, account) => sum + account.transactions.length, 0)}笔；按账户分别测算。`
        : `账户：${state.product}；共${state.draft.transactions!.length}笔。请核对上方全部交易明细。`;
    } else {
      await stream.finish(
        truncateUtf8(
          renderWeComNotice(selection.title, [
            selection.subTitle,
            state.stage === 'confirm'
              ? '确认完成前不会执行投资限额测算。'
              : '可选择最符合的一项，也可以直接输入准确名称或代码。',
          ]),
          this.deps.streamMaxBytes,
        ),
      );
    }
    this.scheduleSelectionCard(body, key, selection, { kind: 'pretrade', state });
  }

  async handleIntentChoice(
    frame: RiskTemplateCardEventFrame,
    body: ConversationBody,
    key: string,
    taskId: string,
    state: RiskIntentState,
    value: string,
    label: string,
  ): Promise<void> {
    if (state.stage === 'freeform') return;
    const option = buildIntentSelection(state, Date.now() + 300_000).options
      .find(item => (item.value ?? item.key) === value);
    if (!option) return;
    await updateRiskCardBestEffort(() => this.deps.updateTemplateCard(frame,
      buildRiskSelectionStatusCard(taskId, '已收到选择', '正在校验选择并继续处理。', label)),
    error => log.fail('wecom-risk-card', error, { step: 'selection-status' }));
    await withReservation(this.deps.startingRuns, key, () => this.deps.runGate.run(async () => {
      const reply = await this.application.select({
        key, text: '', authorized: this.deps.isRiskUserAllowed(body.from?.userid),
        maxMessageBytes: this.deps.streamMaxBytes,
      }, state, option.key);
      await this.renderReply(body, key, {
        update: async () => {}, finish: content => this.sendRiskMarkdown(body, content),
      }, reply);
    }));
  }

  async handleSelectionCardEvent(
    frame: RiskTemplateCardEventFrame,
    key: string,
    taskId: string,
    eventKey: string | undefined,
    selectedId: string | undefined,
  ): Promise<void> {
    const body = frame.body;
    if (!body) return;
    if (!this.deps.riskRouter || !this.deps.isRiskUserAllowed(body.from?.userid)) {
      await this.deps.updateTemplateCard(
        frame,
        buildRiskSelectionStatusCard(
          taskId,
          '无法使用此选择',
          this.deps.riskRouter ? '当前用户没有风险查询权限' : '风险查询暂不可用',
        ),
      );
      return;
    }

    const selectedKey = selectedId || (eventKey === 'submit' ? '' : eventKey ?? '');
    const resolution = this.deps.riskSelectionTasks.resolve(taskId, key, selectedKey);
    if (resolution.status === 'invalid') {
      await this.deps.updateTemplateCard(
        frame,
        buildRiskSelectionCard(
          {
            ...resolution.selection,
            replyHint: '请先选择一个候选项，再点击确认',
          },
          taskId,
        ),
      );
      return;
    }
    if (resolution.status !== 'selected') {
      if (resolution.status === 'missing' || resolution.status === 'expired') {
        this.deps.riskStates.deleteTask(taskId);
      }
      await this.deps.updateTemplateCard(
        frame,
        renderWeComCard(
          buildErrorCardView({
            taskId,
            kind: resolution.status === 'mismatch' ? 'callback-invalid' : 'callback-expired',
          }),
        ),
      );
      return;
    }

    const conversationState = this.deps.riskStates.getConversationTask(taskId);
    if (!conversationState) {
      await this.deps.updateTemplateCard(
        frame,
        renderWeComCard(buildErrorCardView({ taskId, kind: 'callback-expired' })),
      );
      return;
    }
    this.deps.riskStates.deleteTask(taskId);
    if (conversationState.kind === 'pretrade') {
      await this.handleIntentChoice(
        frame,
        body,
        key,
        taskId,
        conversationState.state,
        resolution.option.value ?? resolution.option.key,
        resolution.option.label,
      );
      return;
    }

    let submission;
    try {
      submission = this.deps.conversationQueue.submit(key, async () => {
        await this.executeSelection(
          body,
          key,
          {
            kind: 'query',
            state: conversationState.state,
            input: resolution.option.value ?? resolution.option.key,
          },
          false,
          { kind: 'card' },
        );
      });
    } catch (err) {
      if (!(err instanceof WeComConversationQueueError)) throw err;
      await updateRiskCardBestEffort(
        () =>
          this.deps.updateTemplateCard(
            frame,
            buildRiskSelectionStatusCard(
              taskId,
              '无法开始风险查询',
              conversationQueueNotice(err.reason),
              resolution.option.label,
            ),
          ),
        (error) => log.fail('wecom-risk-card', error, { step: 'queue-rejected-status' }),
      );
      return;
    }

    await this.deps
      .updateTemplateCard(
        frame,
        buildRiskSelectionStatusCard(
          taskId,
          submission.queued ? '已加入会话队列' : '已收到选择',
          submission.queued
            ? `当前排队位置：${submission.position}；前一项完成后会自动处理。`
            : '正在继续风险查询',
          resolution.option.label,
        ),
      )
      .catch((err: unknown) => {
        log.fail('wecom-risk-card', err, { step: 'selection-status' });
      });

    void submission.completion.catch(async (err: unknown) => {
      log.fail('wecom-risk-card', err, { step: 'selection' });
      await this.sendRiskMarkdown(
        body,
        renderWeComNotice('⚠️ 风险查询失败', ['暂时无法完成查询，请稍后重试。']),
      ).catch(() => {});
    });
  }

  async executeSelection(
    body: ConversationBody,
    key: string,
    selection: RiskSelectionExecution,
    withinConversationRun = false,
    progressTarget?: { kind: 'card' } | { kind: 'stream'; stream: RiskStreamTarget },
  ): Promise<void> {
    const stream: RiskStreamTarget = progressTarget?.kind === 'stream' ? progressTarget.stream
      : { update: async () => {}, finish: content => this.sendRiskMarkdown(body, content) };
    const execute = async () => {
      void this.deps.refreshHealth();
      const relay = new RiskProgressRelay(message => stream.update(renderWeComNotice('风险查询处理中', [message])),
        error => log.fail('wecom-risk-progress', error), { includeStageCount: true, coalesce: true });
      const request = { key, text: '', authorized: this.deps.isRiskUserAllowed(body.from?.userid),
        maxMessageBytes: this.deps.streamMaxBytes, onProgress: (message: string) => relay.push(message) };
      const startedAt = Date.now();
      const reply = selection.kind === 'query'
        ? await this.application.continueQuery(request, selection.state, selection.input)
        : await this.application.select(request, selection.state, 'confirm');
      await relay.finish();
      reportMetric(selection.kind === 'query' ? 'wecom_risk_selection_ms' : 'wecom_risk_confirmed_ms', Date.now() - startedAt);
      await this.renderReply(body, key, stream, reply);
    };
    try {
      if (withinConversationRun) await execute();
      else await withReservation(this.deps.startingRuns, key, () => this.deps.runGate.run(execute));
    } catch (error) {
      if (!(error instanceof WeComRunCapacityError)) throw error;
      await stream.finish(renderWeComNotice('当前任务较多', [capacityNotice(error.reason)]));
    } finally {
      void this.deps.refreshHealth();
    }
  }

  async sendRiskMarkdown(body: ConversationBody, content: string): Promise<void> {
    const rendered = content.includes('**▌ ') ? content : renderWeComRiskOutput(content);
    for (const page of splitRiskMessage(rendered, this.deps.streamMaxBytes)) {
      await this.deps.sendMarkdownMessage(body, page);
    }
  }

  scheduleSelectionCard(
    body: ConversationBody,
    key: string,
    selection: RiskSelectionRequest,
    conversationState: RiskConversationState,
  ): void {
    if (this.deps.riskStates.getConversation(key)?.state !== conversationState.state) return;
    const taskId = this.deps.createRiskTaskId();
    this.deps.riskSelectionTasks.register(taskId, key, selection);
    this.deps.riskStates.clearTasksForConversation(key);
    this.deps.riskStates.registerConversationTask(
      taskId,
      key,
      conversationState,
      selection.expiresAt,
    );
    void (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, this.selectionCardDelayMs));
      if (!this.deps.riskSelectionTasks.has(taskId, key) ||
          this.deps.riskStates.getConversation(key)?.state !== conversationState.state) return;
      try {
        await this.deps.sendControlCardMessage(
          body,
          buildRiskSelectionCard(selection, taskId),
        );
      } catch (err) {
        this.deps.riskSelectionTasks.remove(taskId);
        this.deps.riskStates.deleteTask(taskId);
        log.fail('wecom-risk-card', err, { step: 'send' });
      }
    })();
  }

}

export { isRiskIntentConfirmation, riskIntentInputPrompt } from '../../business/risk/application';
