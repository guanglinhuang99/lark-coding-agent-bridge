import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import {
  buildConfirmationCardView,
  buildErrorCardView,
  buildQueueCardView,
  buildRunCardView,
  buildSelectionCardView,
} from '../../../src/wecom/ui/builders';
import { renderWeComCard } from '../../../src/wecom/ui/renderer';
import { statusColor } from '../../../src/wecom/ui/theme';


describe('WeCom Card UI', () => {
  it('renders semantic buttons to WeCom styles', () => {
    const card = renderWeComCard({
      kind: 'interactive',
      taskId: 'task_1',
      source: 'Codex Bridge',
      sourceColor: statusColor('running'),
      title: 'Codex 会话控制',
      description: '正在执行',
      facts: [{ label: '工作区', value: 'web-cli' }],
      buttons: [
        { key: 'stop', text: '停止', variant: 'danger' },
        { key: 'new', text: '新会话', variant: 'secondary' },
        { key: 'status', text: '查看状态', variant: 'primary' },
      ],
    });

    expect(card.card_type).toBe('button_interaction');
    expect(card.task_id).toBe('task_1');
    expect(card.source?.desc_color).toBe(0);
    expect(card.horizontal_content_list).toEqual([{ keyname: '工作区', value: 'web-cli' }]);
    expect(card.button_list).toEqual([
      { text: '停止', key: 'stop', style: 4 },
      { text: '新会话', key: 'new', style: 2 },
      { text: '查看状态', key: 'status', style: 1 },
    ]);
  });

  it('redacts secrets in run-card prompt and compacts the home path', () => {
    const secret = 'do-not-show-this-value';
    const card = renderWeComCard(
      buildRunCardView({
        taskId: 'task_redaction',
        status: 'running',
        workspace: `${homedir()}/workspace/web-cli`,
        sandbox: 'read-only',
        prompt: `WECOM_SECRET=${secret} cat ${homedir()}/private/file.txt`,
      }),
    );

    expect(JSON.stringify(card)).not.toContain(secret);
    expect(JSON.stringify(card)).not.toContain(homedir());
    expect(JSON.stringify(card)).toContain('WECOM_SECRET=[REDACTED]');
    expect(JSON.stringify(card)).toContain('~/private/file.txt');
  });

  it('renders a selector with a confirmation action', () => {
    const card = renderWeComCard({
      kind: 'interactive',
      taskId: 'select_1',
      source: '风险限额查询',
      title: '请选择账户',
      selection: {
        questionKey: 'risk_product',
        title: '请选择账户',
        options: [
          { id: '1', text: '账户 A' },
          { id: '2', text: '账户 B' },
        ],
      },
      buttons: [{ key: 'submit', text: '确认选择', variant: 'primary' }],
    });

    expect(card.button_selection?.question_key).toBe('risk_product');
    expect(card.button_selection?.option_list).toHaveLength(2);
    expect(card.button_list).toEqual([{ text: '确认选择', key: 'submit', style: 1 }]);
  });

  it('renders non-interactive notices with the safe default action URL', () => {
    const card = renderWeComCard({
      kind: 'notice',
      taskId: 'notice_1',
      source: 'Codex Bridge',
      title: '已完成',
      description: '任务执行完成',
      subtitle: '17 tests passed',
    });

    expect(card.card_type).toBe('text_notice');
    expect(card.card_action).toMatchObject({ type: 1, url: 'https://work.weixin.qq.com/' });
    expect(card.button_list).toBeUndefined();
  });

  it('keeps status colors centralized', () => {
    expect(statusColor('running')).toBe(0);
    expect(statusColor('success')).toBe(1);
    expect(statusColor('error')).toBe(2);
    expect(statusColor('idle')).toBe(3);
  });

  it('builds queue views without inventing an unsafe cancel action', () => {
    const queued = buildQueueCardView({
      taskId: 'queue_1',
      status: 'queued',
      workspace: '/Users/test/workspace/web-cli',
      position: 3,
    });
    const card = renderWeComCard(queued);

    expect(queued.kind).toBe('notice');
    expect(card.main_title?.title).toBe('⏳ 已加入队列');
    expect(card.main_title?.desc).toBe('前面还有 2 个任务');
    expect(card.button_list).toBeUndefined();
    expect(card.horizontal_content_list).toEqual([
      { keyname: '工作区', value: 'web-cli' },
      { keyname: '排队位置', value: '3' },
    ]);
  });

  it('maps queue rejection states to user-readable error views', () => {
    expect(buildQueueCardView({ taskId: 'full', status: 'queue-full' }).title).toBe(
      '❌ 任务队列已满',
    );
    expect(buildQueueCardView({ taskId: 'timeout', status: 'queue-timeout' }).title).toBe(
      '❌ 排队等待超时',
    );
    expect(buildErrorCardView({ taskId: 'expired', kind: 'callback-expired' })).toMatchObject({
      kind: 'notice',
      taskId: 'expired',
      title: '❌ 卡片已失效',
    });
  });

  it('builds selection and confirmation views through the same model', () => {
    const selection = buildSelectionCardView({
      taskId: 'select_1',
      source: 'Codex Bridge',
      title: '选择模型',
      questionKey: 'model',
      options: [
        { id: 'luna', text: 'Luna' },
        { id: 'sol', text: 'Sol' },
      ],
    });
    const confirmation = buildConfirmationCardView({
      taskId: 'confirm_1',
      source: 'Codex Bridge',
      title: '确认执行',
      description: '即将开始任务',
      facts: [{ label: '工作区', value: 'web-cli' }],
      confirmKey: 'submit',
    });

    expect(renderWeComCard(selection).button_selection?.question_key).toBe('model');
    expect(renderWeComCard(selection).button_list).toEqual([
      { text: '确认选择', key: 'submit', style: 1 },
    ]);
    expect(renderWeComCard(confirmation).button_list).toEqual([
      { text: '确认', key: 'submit', style: 1 },
    ]);
  });
});
