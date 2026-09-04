import { describe, expect, it } from 'vitest';
import {
  buildAgentSettingsSummaryCardView,
  buildResultCardView,
} from '../../../src/wecom/ui/surfaces';
import { renderWeComCard } from '../../../src/wecom/ui/renderer';

describe('WeCom card surfaces', () => {
  it('renders a compact settings summary without fake action buttons', () => {
    const card = renderWeComCard(
      buildAgentSettingsSummaryCardView({
        taskId: 'settings_1',
        workspace: 'wecom-bot',
        model: 'gpt-5.6',
        reasoning: 'high',
        sandbox: 'workspace-write',
      }),
    );

    expect(card.card_type).toBe('text_notice');
    expect(card.main_title?.title).toBe('⚙️ Agent Settings');
    expect(card.horizontal_content_list).toEqual([
      { keyname: '工作区', value: 'wecom-bot' },
      { keyname: '模型', value: 'gpt-5.6' },
      { keyname: '推理', value: 'high' },
      { keyname: '权限', value: 'workspace-write' },
    ]);
    expect(card.button_list).toBeUndefined();
  });

  it('renders success result metadata and only existing safe actions', () => {
    const card = renderWeComCard(
      buildResultCardView({
        taskId: 'codex_result_1',
        durationMs: 18_400,
        toolCount: 6,
        fileCount: 3,
        threadId: 'thread_1234567890abcdef',
      }),
    );

    expect(card.card_type).toBe('button_interaction');
    expect(card.main_title?.title).toBe('✅ 已完成');
    expect(card.horizontal_content_list).toEqual([
      { keyname: '耗时', value: '18s' },
      { keyname: '工具', value: '6' },
      { keyname: '文件', value: '3' },
      { keyname: '会话', value: 'thread_12345…' },
    ]);
    expect(card.button_list).toEqual([
      { text: '新会话', key: 'new', style: 2 },
      { text: '查看状态', key: 'status', style: 1 },
    ]);
  });

  it('renders stopped and failed outcomes distinctly', () => {
    const stopped = renderWeComCard(buildResultCardView({ taskId: 'stopped', terminal: 'stopped' }));
    const failed = renderWeComCard(buildResultCardView({ taskId: 'failed', terminal: 'error' }));

    expect(stopped.main_title?.title).toBe('⏹ 已停止');
    expect(failed.main_title?.title).toBe('❌ 执行失败');
    expect(stopped.source?.desc_color).toBe(3);
    expect(failed.source?.desc_color).toBe(2);
  });
});
