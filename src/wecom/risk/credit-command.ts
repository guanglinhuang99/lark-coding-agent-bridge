import { WECOM_CREDIT_USAGE_LINES } from '../commands';

type RecordValue = Record<string, unknown>;

export function parseCreditQueries(payload: string): string[] {
  return [...new Set(payload.split(/[,，、;；\r\n]+/u).map((item) => item.trim()).filter(Boolean))];
}

const columns = '| 授信主体 | 三方授信 | 三方已用 | 三方剩余 | 集团内授信 | 集团内已用 | 集团内剩余 |';
const separator = '| --- | ---: | ---: | ---: | ---: | ---: | ---: |';
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const cell = (value: unknown): string => String(value ?? '').replace(/[\r\n]+/gu, ' ').replace(/\|/gu, '｜');
const numeric = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const money = (value: unknown, missing = '—'): string => {
  const amount = numeric(value);
  return amount === undefined ? missing : (amount / 10_000).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
};

/** Each page fits the transport byte budget and repeats the seven-column header. */
export function formatCreditPages(data: RecordValue, maxBytes: number): string[] {
  const reports = Array.isArray(data.reports) ? data.reports.map(record) : [];
  if (reports.length && !data.date) throw new Error('Missing credit holding date');
  const heading = `**授信查询**\n持仓日期：${cell(data.date) || '无可用日期'} · 单位：万元`;
  const prefix = `${heading}\n\n${columns}\n${separator}`;
  const pages: string[] = [];
  let page = prefix;
  const append = (line: string) => {
    if (Buffer.byteLength(`${prefix}\n${line}`, 'utf8') > maxBytes) {
      throw new Error('Credit row exceeds message limit');
    }
    if (Buffer.byteLength(`${page}\n${line}`, 'utf8') > maxBytes) {
      pages.push(page);
      page = prefix;
    }
    page += `\n${line}`;
  };
  const notes: string[] = [];
  for (const report of reports) {
    const name = cell(report.entity);
    const values: string[] = [];
    for (const [key, title] of [['third_party', '三方'], ['group_internal', '集团内']] as const) {
      const item = record(report[key]);
      values.push(money(item.credit_limit_yuan, '未配置'), money(item.used_credit_yuan), money(item.remaining_credit_yuan));
      const limit = numeric(item.credit_limit_yuan);
      const used = numeric(item.used_credit_yuan);
      if (limit !== undefined && used !== undefined && used > limit) {
        notes.push(`超额占用：${name} · ${title} · ${money(used - limit)} 万元。`);
      }
    }
    append(`| ${name} | ${values.join(' | ')} |`);
    const queries = Array.isArray(report.matched_queries) ? report.matched_queries.map(cell) : [];
    for (const query of queries.filter((query) => query !== name)) notes.push(`匹配：${query} → ${name}`);
  }
  if (!reports.length) append('未返回可展示的授信主体。');
  for (const query of Array.isArray(data.unmatched) ? data.unmatched : []) {
    notes.push(`未找到：${cell(query)}。`);
  }
  for (const value of Array.isArray(data.errors) ? data.errors : []) {
    const error = record(value);
    notes.push(error.code === 'too_many_matches'
      ? `「${cell(error.query)}」匹配过多，请补充更完整的公司名称。`
      : `「${cell(error.query)}」查询失败，未将失败结果计为零，请稍后重试。`);
  }
  for (const note of notes) append(`\n${note}`);
  pages.push(page);
  return pages;
}

export async function executeCreditCommand(
  payload: string,
  service: {
    getCredit(entity: string): Promise<RecordValue>;
    getCredits(entities: string[]): Promise<RecordValue>;
  } | undefined,
  maxBytes: number,
  finish: (content: string) => Promise<void>,
  send: (content: string) => Promise<void>,
): Promise<void> {
  const queries = parseCreditQueries(payload);
  if (!queries.length) {
    await finish(WECOM_CREDIT_USAGE_LINES.join('\n'));
    return;
  }
  if (queries.length > 50 || queries.some((query) => query.length > 200)) {
    await finish('请每次查询不超过 50 个名称，每个名称不超过 200 字。');
    return;
  }
  if (!service) {
    await finish('授信查询服务暂不可用，请稍后重试。');
    return;
  }
  let pages: string[];
  try {
    const data = queries.length === 1
      ? await service.getCredit(queries[0]!).then((report) => ({
          date: report.date,
          amount_unit: report.amount_unit,
          reports: [report],
        }))
      : await service.getCredits(queries);
    pages = formatCreditPages(data, maxBytes);
  } catch {
    await finish('授信查询失败，未将失败结果计为零。请稍后重试；名称过于宽泛时请缩小查询范围。');
    return;
  }
  await finish(pages[0]!);
  for (const page of pages.slice(1)) await send(page);
}
