import { describe, expect, it } from 'vitest';
import {
  parseWeComCommand,
  shouldUseRiskFastPath,
  WECOM_HELP_LINES,
  WECOM_RISK_USAGE_LINES,
} from '../../../src/wecom/commands';

describe('WeCom command gate', () => {
  it('parses an explicit risk command and keeps its payload', () => {
    expect(parseWeComCommand('  /测算  安联ESG纯债1号 买入 0.1亿元 019115.SH  ')).toEqual({
      kind: 'risk-measurement',
      payload: '安联ESG纯债1号 买入 0.1亿元 019115.SH',
    });
  });

  it('recognizes an empty risk command without treating it as a flow entry', () => {
    const command = parseWeComCommand('/测算');
    expect(command).toEqual({ kind: 'risk-measurement', payload: '' });
    expect(shouldUseRiskFastPath(command, false, false)).toBe(false);
    expect(WECOM_RISK_USAGE_LINES.join('\n')).toContain('/测算 <交易或查询文本>');
  });

  it('keeps ordinary risk-looking text on the normal path', () => {
    const command = parseWeComCommand('安联ESG纯债1号 买入 0.1亿元 019115.SH');
    expect(command).toEqual({ kind: 'other' });
    expect(shouldUseRiskFastPath(command, false, false)).toBe(false);
    expect(shouldUseRiskFastPath(command, true, false)).toBe(true);
  });

  it('supports help discovery and rejects lookalike commands', () => {
    expect(parseWeComCommand('/HELP')).toEqual({ kind: 'help' });
    expect(parseWeComCommand('/测算foo')).toEqual({ kind: 'other' });
    expect(WECOM_HELP_LINES.join('\n')).toContain('/测算 <交易或查询文本>');
    expect(WECOM_HELP_LINES.join('\n')).toContain('/help');
  });
});
