import { describe, expect, it } from 'vitest';
import {
  formatCalculation,
  formatCounterpartyCheck,
} from '../../../src/wecom/risk/formatter';

describe('WeCom risk result formatting', () => {
  it('does not present an existing breach as an overall green pass', () => {
    const markdown = formatCalculation({
      status: 'success',
      product: '测试产品',
      result: {
        before: { status_counts: { FAIL: 1, PASS: 2 } },
        after: { status_counts: { FAIL: 1, PASS: 2 } },
        comparison: [
          {
            规则类型: '集中度',
            限制对象: '单一主体',
            测算前状态: 'FAIL',
            测算后状态: 'FAIL',
            测算前实际值: '12%',
            测算后实际值: '12%',
          },
        ],
      },
    });

    expect(markdown).toContain('本笔未新增超限');
    expect(markdown).toContain('既有超限');
    expect(markdown).not.toContain('🟢 **通过**');
  });

  it('marks incomplete checks as inconclusive', () => {
    const markdown = formatCalculation({
      status: 'success',
      result: {
        before: { status_counts: {} },
        after: { status_counts: { NO_DATA: 1 } },
        comparison: [{ 测算前状态: 'NO_DATA', 测算后状态: 'NO_DATA', 原文摘录: '缺少评级' }],
      },
    });
    expect(markdown).toContain('检查不完整');
    expect(markdown).not.toContain('🟢 **通过**');
  });

  it('fails closed when counterparty hit is missing', () => {
    expect(formatCounterpartyCheck({})).toContain('无法确认');
    expect(formatCounterpartyCheck({})).not.toContain('未命中');
  });

  it('does not double-count the same new failure across comparison and issues', () => {
    const markdown = formatCalculation({
      status: 'success',
      result: {
        before: { status_counts: { PASS: 1 } },
        after: { status_counts: { FAIL: 1 } },
        comparison: [
          {
            规则类型: '现金约束',
            限制对象: '可用现金',
            测算前状态: 'PASS',
            测算后状态: 'FAIL',
          },
        ],
        issues: [
          {
            code: 'INSUFFICIENT_CASH',
            status: 'FAIL',
            introduced_by_scenario: true,
          },
        ],
      },
    });

    expect(markdown).toContain('引发 1 项新增超限/问题');
    expect(markdown).not.toContain('引发 2 项新增超限/问题');
  });
});
