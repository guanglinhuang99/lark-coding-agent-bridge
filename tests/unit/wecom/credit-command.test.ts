import { describe, expect, it, vi } from 'vitest';
import { executeCreditCommand, formatCreditPages, parseCreditQueries } from '../../../src/wecom/risk/credit-command';
import { parseWeComCommand, shouldUseRiskFastPath } from '../../../src/wecom/commands';

const category = { credit_limit_yuan: 100_000, used_credit_yuan: 120_000, remaining_credit_yuan: 0 };
const report = (entity: string) => ({ entity, group_internal: category,
  third_party: { credit_limit_yuan: null, used_credit_yuan: 0, remaining_credit_yuan: null } });

describe('/授信', () => {
  it('preserves company wording and parses explicit separators, not company spaces', () => {
    expect(parseWeComCommand('/授信 公司甲、公司乙')).toEqual({ kind: 'credit-query', payload: '公司甲、公司乙' });
    expect(parseWeComCommand('/授信foo')).toEqual({ kind: 'other' });
    expect(parseCreditQueries('公司甲，公司乙;公司甲；公司丙\nABC Limited、公司丁')).toEqual([
      '公司甲', '公司乙', '公司丙', 'ABC Limited', '公司丁',
    ]);
    expect(shouldUseRiskFastPath(parseWeComCommand('/授信 公司甲'), true, true)).toBe(true);
    expect(shouldUseRiskFastPath(parseWeComCommand('/授信'), false, false)).toBe(false);
  });

  it('uses seven columns and one row per subject, with missing limits and excess explicit', () => {
    const pages = formatCreditPages({ date: '2026-09-08', reports: [report('公司甲'), report('公司乙')] }, 10_000);
    const rows = pages[0]!.split('\n').filter((line) => line.startsWith('| 公司'));
    expect(rows).toHaveLength(2);
    expect(rows.every((line) => line.split('|').length === 9)).toBe(true);
    expect(rows[0]).toBe('| 公司甲 | 10.00 | 12.00 | 0.00 | 未配置 | 0.00 | — |');
    expect(pages[0]).toContain('2026-09-08 · 单位：万元');
    expect(pages[0]).toContain('超额占用：公司甲 · 集团内 · 2.00 万元');
  });

  it('does not truncate any table rows when paging by UTF-8 bytes', () => {
    const reports = Array.from({ length: 50 }, (_, index) => report(`公司第${index}号`));
    const pages = formatCreditPages({ date: '2026-09-08', reports }, 1200);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => Buffer.byteLength(page) <= 1200)).toBe(true);
    const rows = pages.join('\n').split('\n').filter((line) => line.startsWith('| 公司第'));
    expect(rows).toHaveLength(50);
    expect(new Set(rows).size).toBe(50);
    expect(pages.every((page) => page.includes('| 授信主体 |'))).toBe(true);
  });

  it('retains successes alongside unknown subjects and errors without exposing raw exceptions', () => {
    const result = formatCreditPages({ date: '2026-09-08', reports: [{ ...report('公司甲'), matched_queries: ['甲'] }],
      unmatched: ['公司乙'], errors: [{ query: '公司丙', message: '/private/secret traceback' },
        { query: '银行', code: 'too_many_matches', count: 100 }],
    }, 10_000).join('\n');
    expect(result).toContain('匹配：甲 → 公司甲');
    expect(result).toContain('未找到：公司乙');
    expect(result).toContain('匹配过多');
    expect(result).toContain('公司丙」查询失败');
    expect(result).not.toContain('traceback');
  });

  it('uses one batch request and delivers every page in order', async () => {
    const data = { date: '2026-09-08', reports: Array.from({ length: 12 }, (_, i) => report(`公司${i}`)) };
    const service = { getCredits: vi.fn(async () => data) };
    const delivered: string[] = [];
    const finish = vi.fn(async (value: string) => { delivered.push(value); });
    const send = vi.fn(async (value: string) => { delivered.push(value); });
    await executeCreditCommand('甲、乙、甲', service, 1200, finish, send);
    expect(service.getCredits).toHaveBeenCalledOnce();
    expect(service.getCredits).toHaveBeenCalledWith(['甲', '乙']);
    expect(finish).toHaveBeenCalledOnce();
    expect(delivered).toEqual(formatCreditPages(data, 1200));
  });

  it('shows usage for empty input and fails closed when backend is unavailable', async () => {
    const finish = vi.fn(async (_value: string) => {});
    const send = vi.fn(async (_value: string) => {});
    await executeCreditCommand('、', undefined, 4000, finish, send);
    expect(finish.mock.calls[0]![0]).toContain('/授信 <公司名称>');
    await executeCreditCommand('甲', undefined, 4000, finish, send);
    expect(finish.mock.calls[1]![0]).toContain('服务暂不可用');
    await executeCreditCommand('甲', { getCredits: async () => { throw new Error('secret'); } }, 4000, finish, send);
    expect(finish.mock.calls[2]![0]).toContain('未将失败结果计为零');
    expect(finish.mock.calls[2]![0]).not.toContain('secret');
    expect(send).not.toHaveBeenCalled();
  });
});
