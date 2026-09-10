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
import {
  buildRiskSelectionCard,
  buildRiskSelectionStatusCard,
  type RiskSelectionTaskRegistry,
  updateRiskCardBestEffort,
} from './card';
import {
  buildIntentSelection,
  confirmationSummary,
  normalizeRiskDraft,
  normalizeSecurity,
  selectRiskIntentSecurity,
  type RiskIntentState,
} from './intent';
import { RiskProgressRelay } from './progress';
import type {
  RiskQueryState,
  RiskRouteResult,
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
 * WeCom-specific presentation and continuation orchestration for risk queries.
 *
 * This class deliberately does not own transaction intent parsing or Codex run lifecycle.
 * RiskStateRegistry remains the single continuation state owner, while WeComRiskRouter stays
 * stateless across messages.
 */
export class RiskInteractionController {
  private readonly selectionCardDelayMs: number;

  constructor(private readonly deps: RiskInteractionDependencies) {
    this.selectionCardDelayMs = deps.selectionCardDelayMs ?? 200;
  }

  async executeQueryMessage(
    body: ConversationBody,
    key: string,
    stream: RiskStreamTarget,
    execute: (onProgress: (progress: string) => void) => Promise<RiskRouteResult>,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const progressRelay = new RiskProgressRelay(
      async (progress) => {
        await stream.update(
          truncateUtf8(
            renderWeComNotice('⏳ 风险限额查询中', [progress]),
            this.deps.streamMaxBytes,
          ),
        );
      },
      (err) => log.fail('wecom-risk-progress', err, { step: 'message' }),
      { includeStageCount: true, coalesce: true },
    );
    const result = await execute((progress) => progressRelay.push(progress));
    await progressRelay.finish();
    if (!result.handled) return false;

    const conversationState = this.applyQueryContinuation(key, result);
    const durationMs = Date.now() - startedAt;
    reportMetric('wecom_risk_fastpath_total', 1, { intent: result.intent });
    reportMetric('wecom_risk_fastpath_ms', durationMs, { intent: result.intent });
    log.info('wecom-risk', 'completed', { intent: result.intent, durationMs });
    await stream.finish(
      truncateUtf8(
        renderWeComRiskOutput(result.markdown, Boolean(result.selection)),
        this.deps.streamMaxBytes,
      ),
    );
    if (result.selection && conversationState) {
      this.scheduleSelectionCard(body, key, result.selection, conversationState);
    }
    return true;
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
    const riskClient = this.deps.riskClient;
    if (!riskClient) return;
    let next: RiskIntentState;
    if (state.stage === 'account') {
      next =
        value === '__other_account__'
          ? {
              stage: 'freeform',
              accountIndex: state.accountIndex,
              originalText: state.originalText,
              draft: state.draft,
              field: 'account',
            }
          : state.draft.accounts && state.accountIndex !== undefined
            ? await normalizeRiskDraft(state.originalText, {
                ...state.draft,
                accounts: state.draft.accounts.map((account, index) => index === state.accountIndex
                  ? { ...account, accountQuery: value, resolvedProduct: value }
                  : account),
              }, riskClient)
            : await normalizeSecurity(
                state.originalText,
                { ...state.draft, accountQuery: value },
                value,
                riskClient,
              );
    } else if (state.stage === 'security') {
      if (value === '__other_security__') {
        next = {
          stage: 'freeform',
          accountIndex: state.accountIndex,
          transactionIndex: state.transactionIndex,
          originalText: state.originalText,
          draft: state.draft,
          field: 'security',
          product: state.product,
        };
      } else {
        const security = JSON.parse(value) as {
          name: string;
          code: string;
          label: string;
        };
        next = await selectRiskIntentSecurity(state, security, riskClient);
      }
    } else if (state.stage === 'confirm') {
      if (value === '__confirm__') {
        this.deps.riskStates.delete(key);
        await updateRiskCardBestEffort(
          () =>
            this.deps.updateTemplateCard(
              frame,
              buildRiskSelectionStatusCard(
                taskId,
                '测算请求提交成功',
                '交易信息已锁定；当前阶段：正在准备测算；已完成 0/4。结果将在下方更新。',
                label,
              ),
            ),
          (error) => log.fail('wecom-risk-card', error, { step: 'confirmation-status' }),
        );
        await this.executeSelection(
          body,
          key,
          { kind: 'pretrade', state },
          false,
          { kind: 'card' },
        );
        return;
      }
      const field =
        value === '__edit_account__'
          ? 'account'
          : value === '__edit_security__'
            ? 'security'
            : value === '__edit_amount__'
              ? 'amount'
              : value === '__edit_market__'
                ? 'market'
                : 'other';
      next = {
        stage: 'freeform',
        accountIndex: state.accountIndex,
        originalText: state.originalText,
        draft: state.draft,
        field,
        product: state.product,
        security: state.security,
      };
    } else {
      return;
    }
    this.deps.riskStates.setPretrade(key, next);
    await updateRiskCardBestEffort(
      () =>
        this.deps.updateTemplateCard(
          frame,
          buildRiskSelectionStatusCard(
            taskId,
            '请补充信息',
            next.stage === 'freeform' ? riskIntentInputPrompt(next) : '正在继续确认。',
            label,
          ),
        ),
      (error) => log.fail('wecom-risk-card', error, { step: 'selection-status' }),
    );
    if (next.stage !== 'freeform') {
      const messageStream: RiskStreamTarget = {
        finish: async (content: string) => this.sendRiskMarkdown(body, content),
        update: async () => false,
      };
      await this.finishIntentState(body, key, messageStream, next);
    }
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
    const riskRouter = this.deps.riskRouter;
    if (!riskRouter) return;
    try {
      const execute = async () => {
        // Health persistence is observability, not a prerequisite for risk execution.
        // Do not put its atomic file write on the user-visible critical path.
        void this.deps.refreshHealth();
        const progressRelay = new RiskProgressRelay(
          (progress) =>
            progressTarget?.kind === 'stream'
              ? progressTarget.stream.update(
                  truncateUtf8(
                    renderWeComNotice('⏳ 风险限额查询中', [progress]),
                    this.deps.streamMaxBytes,
                  ),
                )
              : progressTarget?.kind === 'card'
                ? Promise.resolve()
                : this.sendRiskMarkdown(
                    body,
                    renderWeComNotice('⏳ 风险限额查询中', [progress]),
                  ),
          (err) => log.fail('wecom-risk-progress', err, { step: 'card-selection' }),
          { includeStageCount: true, coalesce: true },
        );
        const onProgress = (progress: string) => {
          if (progress.startsWith('已确认：')) return;
          progressRelay.push(progress);
        };
        const startedAt = Date.now();
        const result = selection.kind === 'query'
          ? await riskRouter.continue(selection.state, selection.input, onProgress)
          : await riskRouter.executeConfirmed(selection.state, onProgress);
        reportMetric(
          selection.kind === 'query' ? 'wecom_risk_selection_ms' : 'wecom_risk_confirmed_ms',
          Date.now() - startedAt,
        );
        await progressRelay.finish();
        if (result.handled) {
          if (progressTarget?.kind === 'stream') {
            const failed = result.intent === 'risk-error';
            await progressTarget.stream.finish(
              truncateUtf8(
                renderWeComNotice(
                  failed ? '⚠️ 风险限额测算失败' : '风险限额测算完成',
                  [
                    failed
                      ? '本次未执行成功，请查看下方错误说明。'
                      : '业务结果已生成，请查看下方结果。',
                  ],
                  failed ? { status: 'error', eyebrow: 'RISK · WECOM' } : undefined,
                ),
                this.deps.streamMaxBytes,
              ),
            );
          }
          await this.sendRouteResult(body, key, result);
        } else {
          const content = renderWeComNotice('无法继续风险查询', [
            '当前选择已失效，请重新发起查询。',
          ], {
            status: 'warning',
            eyebrow: 'RISK · WECOM',
          });
          if (progressTarget?.kind === 'stream') {
            await progressTarget.stream.finish(content);
          } else {
            await this.sendRiskMarkdown(body, content);
          }
        }
      };
      if (withinConversationRun) {
        await execute();
      } else {
        await withReservation(this.deps.startingRuns, key, async () => this.deps.runGate.run(execute));
      }
    } catch (err) {
      if (!(err instanceof WeComRunCapacityError)) {
        if (progressTarget?.kind === 'stream') {
          await progressTarget.stream
            .finish(
              renderWeComNotice('⚠️ 风险限额测算失败', [
                '暂时无法完成测算，请稍后重试。',
              ]),
            )
            .catch(() => {});
        }
        throw err;
      }
      const content = truncateUtf8(
        renderWeComNotice('⚠️ 当前任务较多', [capacityNotice(err.reason)]),
        this.deps.streamMaxBytes,
      );
      if (progressTarget?.kind === 'stream') {
        await progressTarget.stream.finish(content);
      } else {
        await this.sendRiskMarkdown(body, content);
      }
    } finally {
      void this.deps.refreshHealth();
    }
  }

  async sendRouteResult(
    body: ConversationBody,
    key: string,
    result: Extract<RiskRouteResult, { handled: true }>,
  ): Promise<void> {
    const conversationState = this.applyQueryContinuation(key, result);
    const content = renderWeComRiskOutput(result.markdown, Boolean(result.selection));
    await this.sendRiskMarkdown(body, content);
    if (result.selection && conversationState) {
      this.scheduleSelectionCard(body, key, result.selection, conversationState);
    }
  }

  async sendRiskMarkdown(body: ConversationBody, content: string): Promise<void> {
    const rendered = content.includes('**▌ ') ? content : renderWeComRiskOutput(content);
    await this.deps.sendMarkdownMessage(
      body,
      truncateUtf8(rendered, this.deps.streamMaxBytes),
    );
  }

  scheduleSelectionCard(
    body: ConversationBody,
    key: string,
    selection: RiskSelectionRequest,
    conversationState: RiskConversationState,
  ): void {
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
      if (!this.deps.riskSelectionTasks.has(taskId, key)) return;
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

  private applyQueryContinuation(
    key: string,
    result: Extract<RiskRouteResult, { handled: true }>,
  ): RiskConversationState | undefined {
    if (!result.continuation) {
      this.deps.riskStates.delete(key);
      return undefined;
    }
    this.deps.riskStates.setQuery(key, result.continuation);
    return { kind: 'query', state: result.continuation };
  }
}

export function isRiskIntentConfirmation(text: string): boolean {
  return /^(?:确认|是|是的|对|对的|好|好的|可以|行|ok|yes|y|1)$/i.test(text.trim());
}

export function riskIntentInputPrompt(
  state: Extract<RiskIntentState, { stage: 'freeform' }>,
): string {
  const prefix = state.accountIndex === undefined
    ? (state.transactionIndex === undefined ? '' : `第${state.transactionIndex + 1}笔：`)
    : `第${state.accountIndex + 1}个账户${state.transactionIndex === undefined ? '' : `第${state.transactionIndex + 1}笔`}：`;
  if (state.draft.accounts && state.field === 'other') {
    return '请指定账户和交易序号，例如“第2个账户第1笔金额改为3000万”。';
  }
  if (state.draft.transactions && state.field === 'other') {
    return `${prefix}请指定交易序号和修改内容，例如“第2笔金额改为3000万”。`;
  }
  return prefix + (state.field === 'account'
    ? '请直接输入准确的账户名称或关键词。'
    : state.field === 'security'
      ? '请直接输入准确的证券名称或代码。'
      : state.field === 'amount'
        ? '请直接输入正确的金额或数量（含单位）。'
        : state.field === 'market'
          ? '请直接输入“一级”或“二级”。'
          : '请直接输入需要修改或补充的内容。');
}
