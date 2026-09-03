import { describe, expect, it } from 'vitest';
import {
  confirmCard,
  errorCard,
  resultCard,
  selectionCard,
  taskCard,
} from '../../../src/card-ui/cards';
import { renderTuiBody, renderWeComAgentCard } from '../../../src/card-ui/wecom-renderer';

describe('card-ui WeCom TUI renderer', () => {
  it('renders a task as a compact button interaction card', () => {
    const card = renderWeComAgentCard(
      taskCard({
        taskId: 'codex_task_1',
        title: '检查 web-cli',
        subtitle: '企业微信 ↔ Codex',
        status: 'running',
        body: '运行完整测试并检查 Outlook Extension。',
        fields: [
          { label: 'workspace', value: 'web-cli' },
          { label: 'branch', value: 'feat/outlook' },
        ],
        steps: [
          { label: 'Read AGENTS.md', status: 'done' },
          { label: 'npm run ci', status: 'running' },
          { label: 'Live validation', status: 'pending' },
        ],
        actions: [
          { key: 'status', label: '查看状态', tone: 'primary' },
          { key: 'stop', label: '停止', tone: 'danger' },
        ],
      }),
    );

    expect(card.card_type).toBe('button_interaction');
    expect(card.task_id).toBe('codex_task_1');
    expect(card.source?.desc).toBe('▌ CODEX TASK');
    expect(card.source?.desc_color).toBe(0);
    expect(card.main_title?.title).toContain('检查 web-cli');
    expect(card.sub_title_text).toContain('▌ ● RUNNING');
    expect(card.sub_title_text).toContain('┃ 运行完整测试并检查 Outlook Extension。');
    expect(card.sub_title_text).toContain('├─ ✓ Read AGENTS.md');
    expect(card.sub_title_text).toContain('└─ ○ Live validation');
    expect(card.button_list?.map((button) => button.key)).toEqual(['status', 'stop']);
    expect(card.button_list?.map((button) => button.style)).toEqual([1, 4]);
  });

  it('renders terminal-style progress glyphs', () => {
    const body = renderTuiBody(
      taskCard({
        title: 'Build',
        status: 'running',
        steps: [
          { label: 'prepare', status: 'done' },
          { label: 'compile', status: 'running' },
          { label: 'test', status: 'error' },
          { label: 'deploy', status: 'pending' },
        ],
      }),
    );

    expect(body).toContain('▌ ● RUNNING');
    expect(body).toContain('✓ prepare');
    expect(body).toContain('⟳ compile');
    expect(body).toContain('× test');
    expect(body).toContain('○ deploy');
  });

  it('maps semantic tones to native WeCom accent colours', () => {
    const success = renderWeComAgentCard(resultCard({ title: '完成' }));
    const warning = renderWeComAgentCard(
      confirmCard({ title: '确认？', confirmKey: 'yes' }),
    );
    const failure = renderWeComAgentCard(errorCard({ title: '失败' }));

    expect(success.source?.desc_color).toBe(1);
    expect(warning.source?.desc_color).toBe(2);
    expect(failure.source?.desc_color).toBe(2);
    expect(success.main_title?.title).toContain('✓');
    expect(failure.main_title?.title).toContain('×');
  });

  it('builds confirmation cards with explicit confirm and cancel actions', () => {
    const card = renderWeComAgentCard(
      confirmCard({
        taskId: 'confirm_merge',
        title: '合并 PR #26？',
        body: 'CI 通过，准备合并到 main。',
        confirmKey: 'merge',
        confirmLabel: '合并',
        danger: true,
      }),
    );

    expect(card.source?.desc).toBe('▌ ACTION REQUIRED');
    expect(card.button_list?.map((button) => button.key)).toEqual(['merge', 'cancel']);
    expect(card.button_list?.map((button) => button.style)).toEqual([4, 2]);
  });

  it('provides result, error, and selection card primitives needed by the bridge', () => {
    const result = renderWeComAgentCard(
      resultCard({
        title: '任务完成',
        fields: [{ label: 'tests', value: '128/128' }],
      }),
    );
    const error = renderWeComAgentCard(
      errorCard({ title: '构建失败', retryKey: 'retry' }),
    );
    const selection = renderWeComAgentCard(
      selectionCard({
        title: '选择工作区',
        options: [
          { key: 'web-cli', label: 'web-cli', tone: 'primary' },
          { key: 'wecom-bot', label: 'wecom-bot', tone: 'secondary' },
        ],
      }),
    );

    expect(result.main_title?.title).toContain('任务完成');
    expect(JSON.stringify(result)).toContain('128/128');
    expect(error.button_list?.map((button) => button.key)).toEqual(['retry']);
    expect(selection.button_list?.map((button) => button.key)).toEqual(['web-cli', 'wecom-bot']);
  });

  it('clips long Chinese and emoji text without corrupting code points', () => {
    const card = renderWeComAgentCard(
      taskCard({
        title: '中文🙂'.repeat(30),
        status: 'running',
        body: '状态🙂'.repeat(80),
      }),
    );

    expect(card.main_title?.title).not.toContain('�');
    expect(card.sub_title_text).not.toContain('�');
  });
});
