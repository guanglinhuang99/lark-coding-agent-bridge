import { describe, expect, it } from 'vitest';
import {
  buildRiskSelectionCard,
  buildRiskSelectionStatusCard,
  RiskSelectionTaskRegistry,
} from '../../../src/wecom/risk/card';
import type { RiskSelectionRequest } from '../../../src/wecom/risk/router';

describe('WeCom risk selection cards', () => {
  it('uses one confirmation button for a single candidate', () => {
    const card = buildRiskSelectionCard(selection(1), 'risk_single');

    expect(card.card_type).toBe('button_interaction');
    expect(card.task_id).toBe('risk_single');
    expect(card.horizontal_content_list?.[0]?.value).toContain('候选1');
    expect(card.button_list).toEqual([{ text: '确认选择', key: '1', style: 1 }]);
    expect(card.button_selection).toBeUndefined();
  });

  it('uses one wide selector and one confirmation button for multiple candidates', () => {
    const card = buildRiskSelectionCard(selection(6), 'risk_buttons');

    expect(card.button_selection?.option_list.map((option) => option.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    expect(card.button_selection?.option_list.map((option) => option.text)).toEqual([
      '候选1 CODE1',
      '候选2 CODE2',
      '候选3 CODE3',
      '候选4 CODE4',
      '候选5 CODE5',
      '候选6 CODE6',
    ]);
    expect(card.button_list).toEqual([{ text: '确认选择', key: 'submit', style: 1 }]);
  });

  it('uses a dropdown and confirmation button for seven to ten candidates', () => {
    const card = buildRiskSelectionCard(selection(10), 'risk_dropdown');

    expect(card.button_selection?.question_key).toBe('risk_security');
    expect(card.button_selection?.option_list).toHaveLength(10);
    expect(card.button_selection?.option_list[9]).toMatchObject({ id: '10' });
    expect(card.button_list).toEqual([{ text: '确认选择', key: 'submit', style: 1 }]);
  });

  it('builds a non-interactive status card after a selection', () => {
    const card = buildRiskSelectionStatusCard(
      'risk_done',
      '已收到选择',
      '正在继续风险查询',
      '国债0115（100115.SZ）',
    );

    expect(card).toMatchObject({
      card_type: 'text_notice',
      task_id: 'risk_done',
      main_title: { title: '已收到选择' },
    });
    expect(card.card_action).toMatchObject({ type: 1 });
    expect(card.button_list).toBeUndefined();
  });

  it('consumes a valid task once and rejects invalid, expired, or mismatched callbacks', () => {
    let now = 1_000;
    const registry = new RiskSelectionTaskRegistry(() => now);
    const request = selection(2, now + 100);

    registry.register('risk_1', 'single:u1', request);
    expect(registry.resolve('risk_1', 'single:u1', '9')).toMatchObject({ status: 'invalid' });
    expect(registry.resolve('risk_1', 'single:u2', '1')).toEqual({ status: 'mismatch' });
    expect(registry.resolve('risk_1', 'single:u1', '2')).toMatchObject({
      status: 'selected',
      option: { key: '2', label: '候选2 CODE2' },
    });
    expect(registry.resolve('risk_1', 'single:u1', '2')).toEqual({ status: 'missing' });

    registry.register('risk_2', 'single:u1', selection(1, now + 100));
    now += 101;
    expect(registry.resolve('risk_2', 'single:u1', '1')).toEqual({ status: 'expired' });
  });

  it('keeps only the latest card for one conversation', () => {
    const registry = new RiskSelectionTaskRegistry(() => 1_000);
    registry.register('risk_old', 'single:u1', selection(2));
    registry.register('risk_new', 'single:u1', selection(2));

    expect(registry.has('risk_old', 'single:u1')).toBe(false);
    expect(registry.has('risk_new', 'single:u1')).toBe(true);
    registry.clearConversation('single:u1');
    expect(registry.has('risk_new', 'single:u1')).toBe(false);
  });
});

function selection(count: number, expiresAt = 2_000): RiskSelectionRequest {
  return {
    kind: 'security',
    title: count === 1 ? '请确认证券' : '请选择证券',
    subTitle: `匹配到 ${count} 个候选证券`,
    replyHint: '点击选择，也可回复数字序号',
    options: Array.from({ length: count }, (_, index) => ({
      key: String(index + 1),
      label: `候选${index + 1} CODE${index + 1}`,
    })),
    expiresAt,
  };
}
