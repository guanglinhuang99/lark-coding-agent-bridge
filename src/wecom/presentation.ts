import { homedir } from 'node:os';
import type { TemplateCard } from '@wecom/aibot-node-sdk';
import { renderText } from '../card/text-renderer';
import type { RunState } from '../card/run-state';
import type { CodexSandboxMode } from '../config/permissions';
import { buildRunCardView, type WeComRunCardStatus } from './ui/builders';
import { renderWeComCard } from './ui/renderer';
import { weComUserErrorMarkdown } from './user-error';

export type WeComCardStatus = WeComRunCardStatus;

export interface WeComRenderMeta {
  workspace: string;
  sandbox: CodexSandboxMode;
  threadId?: string;
}

export interface WeComControlCardOptions extends WeComRenderMeta {
  taskId: string;
  status: WeComCardStatus;
  prompt?: string;
  notice?: string;
  runState?: RunState;
}

export type WeComMessageStatus =
  | 'idle'
  | 'thinking'
  | 'running'
  | 'success'
  | 'warning'
  | 'error'
  | 'stopped';

export interface WeComNoticeOptions {
  status?: WeComMessageStatus;
  eyebrow?: string;
}

/**
 * Render the same RunState used by the Feishu card renderer as a structured
 * WeCom Markdown stream. Running states use a concise TUI progress header;
 * completed states expose only the user-facing answer body.
 */
export function renderWeComMarkdown(state: RunState, _meta: WeComRenderMeta): string {
  const body = state.terminal === 'error'
    ? userFacingError(state)
    : (() => {
        const renderedBody = sanitizeSensitiveText(renderText(withoutToolDetails(state))).trim();
        const finalFallback = state.finalText?.trim() ?? '';
        const finalBody = sanitizeSensitiveText(finalFallback);
        return [renderedBody, shouldAppendFinalText(state, finalFallback) ? finalBody : '']
          .filter(Boolean)
          .join('\n\n') || emptyBody(state);
      })();

  if (state.terminal === 'done') return body;
  const header = renderLifecyclePanel(state);
  return [header, body].filter(Boolean).join('\n\n');
}

function userFacingError(state: RunState): string {
  return state.errorMsg === weComUserErrorMarkdown('agent-startup')
    ? weComUserErrorMarkdown('agent-startup')
    : weComUserErrorMarkdown('execution');
}

/** Build the persistent WeCom interaction card displayed beside the stream. */
export function buildWeComControlCard(options: WeComControlCardOptions): TemplateCard {
  return renderWeComCard(buildRunCardView(options));
}

export function renderWeComNotice(
  title: string,
  lines: readonly string[],
  options: WeComNoticeOptions = {},
): string {
  const status = options.status ?? inferMessageStatus(title);
  const visual = messageStatus(status);
  const cleanTitle = sanitizeSensitiveText(stripLeadingStatusIcon(title)).trim() || '状态更新';
  const eyebrow = options.eyebrow ?? inferEyebrow(cleanTitle);
  const body = lines
    .flatMap((line) => sanitizeSensitiveText(line).split('\n'))
    .map((line) => line.trim())
    .filter(Boolean);

  return [
    `### ${visual.icon} **${eyebrow}**`,
    `> **▌ ${visual.glyph} ${visual.label}** · **${cleanTitle}**`,
    ...(body.length > 0
      ? ['>', ...body.map((line, index) => `> ${index === body.length - 1 ? '└─' : '├─'} ${line}`)]
      : []),
  ].join('\n');
}

export function renderWeComAcknowledgement(
  kind: 'input' | 'selection',
  value: string,
): string {
  const compact = sanitizeSensitiveText(value).replace(/\s+/g, ' ').trim();
  const echoed = clipText(compact || '空消息', 120);
  return renderWeComNotice(
    kind === 'selection' ? '选择已接收' : '输入已接收',
    [kind === 'selection' ? `已选择「${echoed}」。` : `已输入「${echoed}」。`],
    { status: 'idle', eyebrow: 'WECOM · INPUT' },
  );
}

/** Add the shared TUI result header while preserving a long Markdown body. */
export function renderWeComRiskOutput(markdown: string, interactive = false): string {
  const content = sanitizeSensitiveText(markdown).trim();
  const status = interactive ? 'warning' : inferRiskOutputStatus(content);
  const title = interactive
    ? '等待用户操作'
    : status === 'error'
      ? '风险检查未通过'
      : status === 'warning'
        ? '风险检查存在待确认项'
        : '风险检查完成';
  const summary = firstMeaningfulLine(content) || '风险限额查询已返回结果。';
  const panel = renderWeComNotice(title, [clipText(stripMarkdown(summary), 100)], {
    status,
    eyebrow: 'RISK · WECOM',
  });
  return [panel, content].filter(Boolean).join('\n\n');
}

/**
 * WeCom limits stream content by UTF-8 bytes, not JavaScript characters.
 * Truncate at code-point boundaries so Chinese and emoji are never corrupted.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const marker = '\n\n…（内容过长，已截断）';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) return takeUtf8Prefix(marker, maxBytes);

  return `${takeUtf8Prefix(text, maxBytes - markerBytes)}${marker}`;
}

function shouldAppendFinalText(state: RunState, finalText: string): boolean {
  if (!finalText) return false;
  return !state.blocks.some(
    (block) => block.kind === 'text' && block.content.trim() === finalText,
  );
}

function withoutToolDetails(state: RunState): RunState {
  return {
    ...state,
    blocks: state.blocks.filter((block) => block.kind !== 'tool'),
  };
}

function sanitizeSensitiveText(value: string): string {
  const home = homedir();
  let output = home && home !== '/' ? value.split(home).join('~') : value;
  output = output.replace(
    /\b((?:WECOM_SECRET|OPENAI_API_KEY|[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s`]+)/gi,
    '$1=[REDACTED]',
  );
  output = output.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1[REDACTED]');
  return output.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

function renderLifecyclePanel(state: RunState): string {
  const status = runStatus(state);
  const steps = lifecycleTextSteps(state);
  return [
    '### 🤖 **CODEX**',
    `> **▌ ${status.icon} ${status.terminal}** · **${status.label}**`,
    ...(steps.length > 0 ? ['>', ...steps.map((step) => `> ${step}`)] : []),
  ].join('\n');
}

function lifecycleTextSteps(state: RunState): string[] {
  if (state.terminal === 'interrupted') return ['└─ ! 任务已停止'];
  if (state.terminal === 'idle_timeout') return ['└─ ! 处理超时'];
  if (state.terminal === 'error') return ['└─ × 处理失败'];
  if (state.footer === 'streaming') return ['└─ ⟳ 正在整理回答…'];
  return ['└─ ⟳ 正在处理，请稍候…'];
}

function runStatus(state: RunState): { icon: string; label: string; terminal: string } {
  if (state.terminal === 'done') return { icon: '✓', label: '已完成', terminal: 'DONE' };
  if (state.terminal === 'interrupted') return { icon: '■', label: '已中断', terminal: 'STOPPED' };
  if (state.terminal === 'idle_timeout') return { icon: '!', label: '已超时', terminal: 'TIMEOUT' };
  if (state.terminal === 'error') return { icon: '×', label: '执行失败', terminal: 'FAILED' };
  if (state.footer === 'tool_running') return { icon: '●', label: '正在处理', terminal: 'RUNNING' };
  if (state.footer === 'streaming') return { icon: '●', label: '正在输出', terminal: 'STREAM' };
  return { icon: '●', label: '正在思考', terminal: 'THINK' };
}

function messageStatus(status: WeComMessageStatus): {
  icon: string;
  glyph: string;
  label: string;
} {
  if (status === 'thinking') return { icon: '🧠', glyph: '●', label: 'THINKING' };
  if (status === 'running') return { icon: '⏳', glyph: '●', label: 'RUNNING' };
  if (status === 'success') return { icon: '✅', glyph: '✓', label: 'COMPLETED' };
  if (status === 'warning') return { icon: '⚠️', glyph: '!', label: 'ACTION REQUIRED' };
  if (status === 'error') return { icon: '❌', glyph: '×', label: 'FAILED' };
  if (status === 'stopped') return { icon: '⏹', glyph: '■', label: 'STOPPED' };
  return { icon: '◇', glyph: '○', label: 'READY' };
}

function inferMessageStatus(title: string): WeComMessageStatus {
  if (/失败|错误|无效|未授权|无法使用|未通过/.test(title)) return 'error';
  if (/已确认|已收到/.test(title)) return 'running';
  if (/补充|修改|选择|确认|缺少|排队|较多|未执行|需要/.test(title)) return 'warning';
  if (/停止|中断/.test(title)) return 'stopped';
  if (/完成|成功|通过/.test(title)) return 'success';
  if (/理解|核对|分析/.test(title)) return 'thinking';
  if (/查询|处理|执行|准备|继续|已确认|收到/.test(title)) return 'running';
  return 'idle';
}

function inferRiskOutputStatus(content: string): WeComMessageStatus {
  if (/🔴|未通过|失败|现金不足/.test(content)) return 'error';
  if (/NO_DATA|NODATA|未知|未检查|待确认|请选择|请补充/.test(content)) return 'warning';
  return 'success';
}

function inferEyebrow(title: string): string {
  return /风险|交易|账户|证券|测算|投资限额/.test(title) ? 'RISK · WECOM' : 'CODEX · WECOM';
}

function stripLeadingStatusIcon(value: string): string {
  return value.replace(/^(?:🕒|⏳|⚠️?|🧠|🔎|✅|❌|🟢|🔴|⏹)\s*/u, '');
}

function firstMeaningfulLine(value: string): string {
  return value.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, '')
    .replace(/[>*_`]/g, '')
    .trim();
}

function emptyBody(state: RunState): string {
  if (state.terminal === 'done') return '_（未返回文本内容）_';
  if (state.terminal === 'running') return '_**▌ Codex 正在工作…**_';
  return '';
}

function clipText(value: string, maxCodePoints: number): string {
  const characters = Array.from(value);
  return characters.length > maxCodePoints
    ? `${characters.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
    : value;
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let output = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}
