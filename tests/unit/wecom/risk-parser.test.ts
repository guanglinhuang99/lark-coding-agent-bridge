import { describe, expect, it } from 'vitest';
import {
  extractAmount,
  isRiskCandidate,
  matchProductCandidates,
  matchProducts,
  parseRiskMessage,
} from '../../../src/wecom/risk/parser';

const products = [
  '安联ESG纯债1号资产管理产品',
  '安联纯债1号资产管理产品',
];

describe('WeCom risk parser', () => {
  it('consumes the complete 亿元 unit and leaves no 元 residue', () => {
    expect(extractAmount('安联ESG纯债1号 买入 0.1亿元 102680271.IB')).toEqual({
      amount: 0.1,
      note: '0.1 亿元',
      source: '0.1亿元',
    });
    expect(
      parseRiskMessage('安联ESG纯债1号 买入 0.1亿元 102680271.IB', products),
    ).toMatchObject({
      kind: 'pretrade_calc',
      amount: 0.1,
      securityQuery: '102680271.IB',
      missing: [],
    });
  });

  it('preserves repo direction, amount, and tenor from the original text', () => {
    expect(
      parseRiskMessage('安联ESG纯债1号 正回购 0.1亿元 7天', products),
    ).toMatchObject({
      kind: 'pretrade_calc',
      action: 'repo',
      amount: 0.1,
      days: 7,
      missing: [],
    });
    expect(
      parseRiskMessage('安联ESG纯债1号 逆回购 0.1亿元 7天', products),
    ).toMatchObject({ action: 'reverse_repo', days: 7 });
  });

  it('routes a risk-limit question to restrictions instead of a security check', () => {
    expect(
      parseRiskMessage('安联ESG纯债1号有哪些风险限额', products),
    ).toMatchObject({
      kind: 'query_restrictions',
      product: '安联ESG纯债1号资产管理产品',
    });
  });

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
    expect(parseRiskMessage('查一下安联ESG纯债1号禁投国债0115吗', products)).toMatchObject({
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

  it('matches product names without Allianz prefixes, spaces, case, or numeral style', () => {
    expect(matchProducts('安联资管 esg 纯债一号', products)).toEqual([
      '安联ESG纯债1号资产管理产品',
    ]);
    expect(matchProducts('安联 esg 纯债 1 号', products)).toEqual([
      '安联ESG纯债1号资产管理产品',
    ]);
    expect(matchProducts('纯债一号', products)).toEqual([
      '安联ESG纯债1号资产管理产品',
      '安联纯债1号资产管理产品',
    ]);
    expect(
      matchProducts('安联资管远见十号', ['安联远见10号资产管理产品']),
    ).toEqual(['安联远见10号资产管理产品']);
    expect(
      matchProducts('稳益买3000万112840.SH', [
        '安联稳益3号资产管理产品',
        '安联稳益7号资产管理产品',
        '安联ESG纯债1号资产管理产品',
      ]),
    ).toEqual(['安联稳益3号资产管理产品', '安联稳益7号资产管理产品']);
  });

  it('keeps generic product names ambiguous until the user chooses one', () => {
    expect(
      matchProductCandidates('安联纯债 买入 0.1亿元 国债', [
        '安联ESG纯债1号资产管理产品',
      ]),
    ).toMatchObject({
      products: ['安联ESG纯债1号资产管理产品'],
      fuzzy: true,
    });
    expect(
      matchProducts('安联纯债 买入 0.1亿元 国债', [
        '安联纯债1号资产管理产品',
        '安联纯债2号资产管理产品',
      ]),
    ).toEqual([
      '安联纯债1号资产管理产品',
      '安联纯债2号资产管理产品',
    ]);
  });

  it('strips a normalized product name before extracting the traded security', () => {
    expect(parseRiskMessage('安联 ESG 纯债 1 号，买 0.1 国债0115', products)).toMatchObject({
      kind: 'pretrade_calc',
      product: '安联ESG纯债1号资产管理产品',
      action: 'buy',
      amount: 0.1,
      securityQuery: '国债0115',
      missing: [],
    });
  });

  it('uses conservative fuzzy matching only when deterministic matching finds nothing', () => {
    expect(matchProducts('安联 ESG 纯在 1 号', products)).toEqual([
      '安联ESG纯债1号资产管理产品',
    ]);
    expect(parseRiskMessage('安联 ESG 纯在 1 号 申购 0.1', products)).toMatchObject({
      kind: 'pretrade_calc',
      product: undefined,
      productCandidates: ['安联ESG纯债1号资产管理产品'],
    });
    expect(matchProducts('完全不同的产品', products)).toEqual([]);
  });
});
