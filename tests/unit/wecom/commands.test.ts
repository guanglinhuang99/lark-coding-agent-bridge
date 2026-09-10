import { describe, expect, it } from 'vitest';
import {
  parseWeComCommand,
  isRiskIntentFlowRequired,
  shouldFallbackRiskCommandToIntent,
  shouldUseRiskFastPath,
  WECOM_COMMAND_HINT,
  WECOM_HELP_LINES,
  WECOM_RISK_USAGE_LINES,
} from '../../../src/wecom/commands';

describe('WeCom command gate', () => {
  it('parses an explicit risk command and keeps its payload', () => {
    expect(parseWeComCommand('  /测算  安联ESG纯债1号 买入 0.1亿元 019115.SH  ')).toEqual({
      kind: 'risk-measurement',
      payload: '安联ESG纯债1号 买入 0.1亿元 019115.SH',
    });
    expect(parseWeComCommand('测算\nESG1号拟投资26粤铁建MTN005 4000万')).toEqual({
      kind: 'risk-measurement',
      payload: 'ESG1号拟投资26粤铁建MTN005 4000万',
    });
  });

  it('recognizes an empty risk command as a mandatory risk-flow entry', () => {
    const command = parseWeComCommand('/测算');
    expect(command).toEqual({ kind: 'risk-measurement', payload: '' });
    expect(shouldUseRiskFastPath(command, false, false)).toBe(true);
    expect(isRiskIntentFlowRequired(command, false)).toBe(true);
    expect(WECOM_RISK_USAGE_LINES.join('\n')).toContain('/测算 <交易或查询文本>');
  });

  it('keeps ordinary risk-looking text on the normal path', () => {
    const command = parseWeComCommand('安联ESG纯债1号 买入 0.1亿元 019115.SH');
    expect(command).toEqual({ kind: 'other' });
    expect(shouldUseRiskFastPath(command, false, false)).toBe(false);
    expect(shouldUseRiskFastPath(command, true, false)).toBe(true);
  });

  it('keeps explicit commands and natural-language trades out of ordinary chat', () => {
    expect(isRiskIntentFlowRequired(parseWeComCommand('测算 模糊交易描述'), false)).toBe(true);
    expect(isRiskIntentFlowRequired(parseWeComCommand('ESG1号拟投一只债'), true)).toBe(true);
    expect(shouldUseRiskFastPath(parseWeComCommand('ESG1号投债券'), false, false, true)).toBe(true);
    expect(shouldFallbackRiskCommandToIntent(
      true,
      { handled: true, intent: 'unknown-risk' },
    )).toBe(true);
  });

  it('supports help discovery and reliability shortcuts', () => {
    expect(parseWeComCommand('/HELP')).toEqual({ kind: 'help' });
    expect(parseWeComCommand('/测算foo')).toEqual({ kind: 'other' });
    expect(WECOM_HELP_LINES.join('\n')).toContain('/测算 <交易或查询文本>');
    expect(WECOM_HELP_LINES.join('\n')).toContain('/doctor');
    expect(WECOM_HELP_LINES.join('\n')).toContain('/runs');
    expect(WECOM_COMMAND_HINT).toContain('/doctor');
    expect(WECOM_COMMAND_HINT).toContain('/runs');
  });
});
