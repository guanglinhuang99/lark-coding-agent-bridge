import { describe, expect, it } from 'vitest';
import { buildAgentSettingsSummaryCardView } from '../../../src/wecom/ui/surfaces';
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
    expect(card.main_title?.title).toBe('○ Agent Settings');
    expect(card.sub_title_text).toContain('/model');
    expect(card.sub_title_text).toContain('/reasoning');
    expect(card.sub_title_text).toContain('/menu');
    expect(card.horizontal_content_list).toEqual([
      { keyname: '工作区', value: 'wecom-bot' },
      { keyname: '模型', value: 'gpt-5.6' },
      { keyname: '推理', value: 'high' },
      { keyname: '权限', value: 'workspace-write' },
    ]);
    expect(card.button_list).toBeUndefined();
  });
});
