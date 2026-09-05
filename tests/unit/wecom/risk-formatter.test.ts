import { describe, expect, it } from 'vitest';
import {
  formatCalculation,
  formatCounterpartyCheck,
  formatSecurityCheck,
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

  it('redacts backend Pin, path, and exception details from failures', () => {
    const markdown = formatCalculation({
      status: 'error',
      error: '读取 Pins PTF_SCOPE 失败: /Users/example/private/ledger RuntimeError traceback',
    });

    expect(markdown).toContain('暂时无法完成测算');
    expect(markdown).not.toMatch(/Pins|PTF_SCOPE|RuntimeError|traceback|\/Users\/example/);
  });

  it('does not expose raw blacklist evidence JSON', () => {
    const markdown = formatSecurityCheck({
      hit: true,
      blacklist_matches: [
        {
          pin: 'PTF_SCOPE_INTERNAL',
          path: '/Users/example/private/blacklist.json',
          error: 'RuntimeError: backend detail',
        },
      ],
    });

    expect(markdown).toContain('已匹配 1 项证据');
    expect(markdown).not.toContain('PTF_SCOPE_INTERNAL');
    expect(markdown).not.toContain('/Users/example');
    expect(markdown).not.toContain('RuntimeError');
  });

  it('does not expose an unknown internal issue code', () => {
    const markdown = formatCalculation({
      status: 'success',
      result: {
        before: { status_counts: { PASS: 1 } },
        after: { status_counts: { FAIL: 1 } },
        comparison: [],
        issues: [
          {
            code: 'SQLITE_ERROR_INTERNAL',
            status: 'FAIL',
            introduced_by_scenario: true,
            message: '该笔交易未通过业务规则。',
          },
        ],
      },
    });

    expect(markdown).toContain('该笔交易未通过业务规则');
    expect(markdown).not.toContain('SQLITE_ERROR_INTERNAL');
  });
});
