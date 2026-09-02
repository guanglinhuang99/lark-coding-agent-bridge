import { isRecord, stringValue } from './client';

const STATUS_ORDER = ['FAIL', 'WARN', 'NO_DATA', 'UNSUPPORTED', 'EXPIRED', 'N/A', 'PASS'];
const UNKNOWN_STATUSES = new Set(['NO_DATA', 'UNSUPPORTED', 'EXPIRED', 'N/A', 'NA', 'UNKNOWN']);

export function formatCalculation(data: Record<string, unknown>, amountNote?: string): string {
  if (data.status === 'error') {
    return `⚠️ **测算失败**：${friendlyError(stringValue(data.error))}`;
  }
  const result = isRecord(data.result) ? data.result : {};
  const before = isRecord(result.before) ? result.before : {};
  const after = isRecord(result.after) ? result.after : {};
  const beforeCounts = isRecord(before.status_counts) ? before.status_counts : {};
  const afterCounts = isRecord(after.status_counts) ? after.status_counts : {};
  const comparison = recordArray(result.comparison);
  const issues = recordArray(result.issues);

  const newFails = comparison.filter(
    (item) => item['测算后状态'] === 'FAIL' && item['测算前状态'] !== 'FAIL',
  );
  const existingFails = comparison.filter(
    (item) => item['测算后状态'] === 'FAIL' && item['测算前状态'] === 'FAIL',
  );
  const warnings = comparison.filter((item) => item['测算后状态'] === 'WARN');
  const unknown = comparison.filter((item) => UNKNOWN_STATUSES.has(stringValue(item['测算后状态'])));
  const introducedIssues = issues.filter(
    (item) => item.status === 'FAIL' && item.introduced_by_scenario === true,
  );
  const unavailableIssues = issues.filter((item) =>
    UNKNOWN_STATUSES.has(stringValue(item.status)),
  );

  const lines: string[] = [];
  if (newFails.length > 0 || introducedIssues.length > 0) {
    const issueCount = Math.max(newFails.length, introducedIssues.length);
    lines.push(`🔴 **未通过**：本笔投资引发 ${issueCount} 项新增超限/问题`);
  } else if (unknown.length > 0 || unavailableIssues.length > 0) {
    lines.push('🟡 **未发现新增超限，但检查不完整**：存在无数据或未支持项目，不能视为完整通过');
  } else if (existingFails.length > 0) {
    lines.push(`🟡 **本笔未新增超限**：产品当前仍有 ${existingFails.length} 项既有超限`);
  } else if (warnings.length > 0) {
    lines.push(`🟡 **本笔未新增超限**：测算后仍有 ${warnings.length} 项预警`);
  } else {
    lines.push('🟢 **通过**：本笔投资未引发新增超限');
  }

  const product = stringValue(data.product) || stringValue(result.product);
  const date = stringValue(data.date) || stringValue(result.date);
  if (product) lines.push('', `**${escapeCell(product)}**${date ? `（测算日 ${date}）` : ''}`);
  if (amountNote) lines.push('', `> 金额口径：${amountNote}`);
  lines.push('', `> 测算前 ${formatCounts(beforeCounts)} → 测算后 ${formatCounts(afterCounts)}`);

  if (comparison.length > 0) {
    lines.push('', '**检查清单**', '', '| 检查项 | 结果 | 投前值 | 投后值 |', '| --- | --- | --- | --- |');
    for (const item of comparison) {
      const status = stringValue(item['测算后状态']) || 'UNKNOWN';
      const beforeStatus = stringValue(item['测算前状态']);
      const label = statusLabel(status, beforeStatus);
      const rule = [stringValue(item['规则类型']), stringValue(item['限制对象'])]
        .filter(Boolean)
        .join(' · ') || stringValue(item['检查对象']) || '检查项';
      const threshold = [stringValue(item['比较符']), displayValue(item['阈值'])].filter(Boolean).join(' ');
      const denominator = stringValue(item['分母口径']);
      const afterValue = displayValue(item['测算后实际值']) || '—';
      const detail = [threshold ? `要求 ${threshold}` : '', denominator].filter(Boolean).join('；');
      lines.push(
        `| ${escapeCell(rule)} | ${label} | ${escapeCell(displayValue(item['测算前实际值']) || '—')} | ${escapeCell(afterValue)}${detail ? `（${escapeCell(detail)}）` : ''} |`,
      );
    }
  }

  if (introducedIssues.length > 0) {
    lines.push('', '**本次引发的问题**');
    for (const item of introducedIssues) lines.push(`- 🔴 ${formatIssue(item)}`);
  }

  const unavailable = [...unknown, ...unavailableIssues];
  if (unavailable.length > 0) {
    lines.push('', '**未检查/未知项**');
    for (const item of unavailable) {
      const message = stringValue(item.message) || stringValue(item.code) || stringValue(item['原文摘录']) || '未取得数据';
      lines.push(`- ❓ ${message}`);
    }
  }

  return truncate(lines.join('\n'), 20_000);
}

export function formatSecurityCheck(data: Record<string, unknown>): string {
  if (data.hit === true) {
    const evidence = Array.isArray(data.blacklist_matches) ? data.blacklist_matches : [];
    return truncate(
      ['🚫 **命中关联方禁投 / 禁投证券**', evidence.length ? `证据：${JSON.stringify(evidence)}` : '']
        .filter(Boolean)
        .join('\n'),
      4_000,
    );
  }
  if (data.hit === false) {
    const candidate = recordArray(data.candidates)[0];
    const located = candidate
      ? [stringValue(candidate.security_name), stringValue(candidate.security_code) || stringValue(candidate.security_id)]
          .filter(Boolean)
          .join('（')
      : '';
    return `✅ **未命中关联方禁投或禁投证券**${located ? `\n定位证券：${located}${located.includes('（') ? '）' : ''}` : ''}`;
  }
  return '🟡 **无法确认是否禁投**：riskservice 未返回明确的 `hit=true/false`，请勿据此放行。';
}

export function formatCounterpartyCheck(data: Record<string, unknown>): string {
  if (data.hit === true) return '🚫 **该交易对手命中关联方禁投**';
  if (data.hit === false) return '✅ **该交易对手未命中关联方禁投**';
  return '🟡 **无法确认交易对手是否为关联方**：riskservice 未返回明确的 `hit=true/false`，请勿据此放行。';
}

export function formatHoldings(data: Record<string, unknown>): string {
  const product = stringValue(data.product) || stringValue(data.requested_product);
  const date = stringValue(data.date);
  const holdings = recordArray(data.holdings);
  if (holdings.length === 0) return `「${product || '该产品'}」暂无持仓数据。`;
  const lines = [`**${escapeCell(product)}**${date ? `（持仓日 ${date}）` : ''}`, '', `共 ${holdings.length} 项持仓。`, '', '| 证券名称 | 代码 | 类型 | 市值 |', '| --- | --- | --- | --- |'];
  for (const item of holdings.slice(0, 50)) {
    lines.push(
      `| ${escapeCell(stringValue(item.security_name) || '—')} | ${escapeCell(stringValue(item.security_code) || '—')} | ${escapeCell(stringValue(item.security_type) || '—')} | ${escapeCell(formatMoney(item.market_value))} |`,
    );
  }
  if (holdings.length > 50) lines.push('', `…另有 ${holdings.length - 50} 项未展示`);
  return truncate(lines.join('\n'), 6_000);
}

export function formatRestrictions(data: Record<string, unknown>): string {
  const product = stringValue(data.product) || stringValue(data.requested_product);
  const restrictions = recordArray(data.investment_restrictions);
  if (restrictions.length === 0) return `「${product || '该产品'}」暂未取到投资限制明细。`;
  const lines = [`**${escapeCell(product)}** 投资限制`, '', '| 规则类型 | 限制对象 | 限制条件 | 分母口径 |', '| --- | --- | --- | --- |'];
  for (const item of restrictions) {
    const threshold =
      displayValue(item['上限值']) || displayValue(item['下限值']) || displayValue(item['数值']);
    const condition = [stringValue(item['比较符']), threshold, stringValue(item['数值单位'])]
      .filter(Boolean)
      .join(' ');
    lines.push(
      `| ${escapeCell(stringValue(item['规则类型']) || '—')} | ${escapeCell(stringValue(item['限制对象']) || '—')} | ${escapeCell(condition || '—')} | ${escapeCell(stringValue(item['分母口径']) || '—')} |`,
    );
  }
  return truncate(lines.join('\n'), 6_000);
}

export function formatCredit(data: Record<string, unknown>): string {
  const entity = stringValue(data.entity) || stringValue(data.requested_entity);
  const date = stringValue(data.date);
  const lines = [`**${escapeCell(entity)}**${date ? `（授信日 ${date}）` : ''}`, '', '| 授信类型 | 授信额度 | 已用授信 | 剩余授信 | 使用率 |', '| --- | --- | --- | --- | --- |'];
  for (const [title, key] of [
    ['集团内授信', 'group_internal'],
    ['三方授信', 'third_party'],
    ['合计', 'total'],
  ] as const) {
    const item = isRecord(data[key]) ? data[key] : undefined;
    if (!item) continue;
    const rate = numberValue(item.usage_rate);
    lines.push(
      `| ${title} | ${formatMoney(item.credit_limit_yuan)} | ${formatMoney(item.used_credit_yuan)} | ${formatMoney(item.remaining_credit_yuan)} | ${rate === undefined ? '—' : `${(rate * 100).toFixed(2)}%`} |`,
    );
  }
  if (lines.length === 4) return `「${entity || '该主体'}」暂未取到授信数据。`;
  return truncate(lines.join('\n'), 4_000);
}

function formatCounts(counts: Record<string, unknown>): string {
  const parts = STATUS_ORDER.flatMap((status) => {
    const count = numberValue(counts[status]);
    return count === undefined || count === 0 ? [] : [`${status} ${count}`];
  });
  return parts.length > 0 ? parts.join(' / ') : '无状态统计';
}

function statusLabel(status: string, beforeStatus: string): string {
  if (status === 'FAIL') return beforeStatus === 'FAIL' ? '⚠️ 既有超限' : '🔴 新增超限';
  if (status === 'WARN') return '🟡 预警';
  if (status === 'PASS') return '✅ 通过';
  if (UNKNOWN_STATUSES.has(status)) return `❓ ${status}`;
  return `❓ ${status}`;
}

function formatIssue(item: Record<string, unknown>): string {
  const code = stringValue(item.code);
  if (code === 'INSUFFICIENT_CASH') {
    const cash = numberValue(item.available_cash);
    return cash === undefined ? '现金不足' : `现金不足：可用现金仅 ${(cash / 10_000).toFixed(2)} 万元`;
  }
  return [code, stringValue(item.message)].filter(Boolean).join('：') || '未知问题';
}

function friendlyError(message: string): string {
  if (/未找到存续产品|存续产品/.test(message)) return '指定产品不在存续产品台账中，无法测算。';
  if (/参考价格/.test(message)) return '证券在测算日缺少参考价格，无法完成换算。';
  if (/必须填写证券名称或代码/.test(message)) return '买入/卖出需要证券名称或代码。';
  if (/相近候选/.test(message)) return '证券名称有多个相近候选，请提供更精确的证券代码。';
  return message || '未知错误';
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatMoney(value: unknown): string {
  const amount = numberValue(value);
  if (amount === undefined) return '—';
  if (Math.abs(amount) >= 1e8) return `${(amount / 1e8).toFixed(2)} 亿`;
  if (Math.abs(amount) >= 1e4) return `${(amount / 1e4).toFixed(2)} 万`;
  return amount.toFixed(2);
}

function escapeCell(value: string): string {
  return value.replaceAll('|', ' ').replaceAll('\n', ' ');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…（内容过长已截断）`;
}
