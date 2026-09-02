import { describe, expect, it } from 'vitest';
import {
  extractAmount,
  isRiskCandidate,
  parseRiskMessage,
} from '../../../src/wecom/risk/parser';

const products = [
  '安联ESG纯债1号资产管理产品',
  '安联纯债1号资产管理产品',
];

describe('WeCom risk parser', () => {
  it('defaults a unitless amount immediately after the action to 亿元', () => {
    expect(extractAmount('安联ESG纯债1号 申购 0.1')).toEqual({
      amount: 0.1,
      note: '0.1 亿元（未写单位，按亿元）',
      source: '0.1',
    });

    const parsed = parseRiskMessage('安联ESG纯债1号 申购 0.1', products);
    expect(parsed).toMatchObject({
      kind: 'pretrade_calc',
      product: '安联ESG纯债1号资产管理产品',
      action: 'subscription',
      amount: 0.1,
      missing: [],
    });
  });

  it('converts 万元 and extracts the traded security', () => {
    const parsed = parseRiskMessage('安联ESG纯债1号 买 1000万 国债0115', products);
    expect(parsed).toMatchObject({
      kind: 'pretrade_calc',
      action: 'buy',
      amount: 0.1,
      securityQuery: '国债0115',
      missing: [],
    });

    expect(parseRiskMessage('安联ESG纯债1号 买 国债0115 0.2', products)).toMatchObject({
      kind: 'pretrade_calc',
      amount: 0.2,
      securityQuery: '国债0115',
      missing: [],
    });
  });

  it('keeps a unitless buy amount when a security code follows', () => {
    expect(extractAmount('安联ESG纯债1号 买 0.1 100115.SZ')).toEqual({
      amount: 0.1,
      note: '0.1 亿元（未写单位，按亿元）',
      source: '0.1',
    });
  });

  it('routes explicit restricted-security checks before buy parsing', () => {
    expect(parseRiskMessage('安联ESG纯债1号 能不能买 国债0115', products)).toMatchObject({
      kind: 'check_security',
      product: '安联ESG纯债1号资产管理产品',
      securityQuery: '国债0115',
    });
  });

  it('does not intercept an unrelated use of 买', () => {
    expect(isRiskCandidate('帮我买一本书')).toBe(false);
    expect(isRiskCandidate('安联ESG纯债1号 申购 0.1')).toBe(true);
    expect(extractAmount('安联ESG纯债1号 买 019115.SH')).toBeUndefined();
    expect(extractAmount('安联ESG纯债1号 买 5 年期国债')).toBeUndefined();
  });
});
