import { basename } from 'node:path';
import { homedir } from 'node:os';
import type { TemplateCard } from '@wecom/aibot-node-sdk';
import { renderText } from '../card/text-renderer';
import type { RunState } from '../card/run-state';
import type { CodexSandboxMode } from '../config/permissions';
import { buildRunCardView, type WeComRunCardStatus } from './ui/builders';
import { renderWeComCard } from './ui/renderer';

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
}

/**
 * Render the same RunState used by the Feishu card renderer as a structured
 * WeCom Markdown stream. The body keeps the agent's Markdown intact while the
 * header and footer provide a card-like status surface.
 */
export function renderWeComMarkdown(state: RunState, meta: WeComRenderMeta): string {
  const status = runStatus(state);
  const thread = meta.threadId ? `\`${escapeInlineCode(shortThread(meta.threadId))}\`` : '`new`';
  const header = [
    '### 🤖 Codex',
    `> ${status.icon} **${status.label}**`,
    `> 工作区：\`${escapeInlineCode(compactWorkspace(meta.workspace))}\` · 权限：\`${sandboxLabel(meta.sandbox)}\` · 会话：${thread}`,
  ].join('\n');

  const renderedBody = sanitizeSensitiveText(renderText(sanitizeToolInputs(state))).trim();
  const finalFallback = state.finalText?.trim() ?? '';
  const finalBody = sanitizeSensitiveText(finalFallback);
  const body = [renderedBody, shouldAppendFinalText(state, finalFallback) ? finalBody : '']
    .filter(Boolean)
    .join('\n\n') || emptyBody(state);

  return [header, body].filter(Boolean).join('\n\n');
}

/** Build the persistent WeCom interaction card displayed beside the stream. */
export function buildWeComControlCard(options: WeComControlCardOptions): TemplateCard {
  return renderWeComCard(buildRunCardView(options));
}

export function renderWeComNotice(title: string, lines: readonly string[]): string {
  const content = lines.filter((line) => line.trim()).map((line) => `> ${line}`).join('\n');
  return [`### ${title}`, content].filter(Boolean).join('\n\n');
}

export function renderWeComAcknowledgement(
  kind: 'input' | 'selection',
  value: string,
): string {
  const compact = sanitizeSensitiveText(value).replace(/\s+/g, ' ').trim();
  const echoed = clipText(compact || '空消息', 120);
  return kind === 'selection'
    ? `收到，您选择了「${echoed}」。`
    : `收到，您输入了「${echoed}」。`;
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

function sanitizeToolInputs(state: RunState): RunState {
  return {
    ...state,
    blocks: state.blocks.map((block) => {
      if (block.kind !== 'tool') return block;
      return {
        ...block,
        tool: {
          ...block.tool,
          input: sanitizeUnknown(block.tool.input),
        },
      };
    }),
  };
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, sanitizeUnknown(nested)]),
  );
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

function runStatus(state: RunState): { icon: string; label: string } {
  if (state.terminal === 'done') return { icon: '✅', label: '已完成' };
  if (state.terminal === 'interrupted') return { icon: '⏹', label: '已中断' };
  if (state.terminal === 'idle_timeout') return { icon: '⏱', label: '已超时' };
  if (state.terminal === 'error') return { icon: '⚠️', label: '执行失败' };
  if (state.footer === 'tool_running') return { icon: '🧰', label: '正在调用工具' };
  if (state.footer === 'streaming') return { icon: '✍️', label: '正在输出' };
  return { icon: '🧠', label: '正在思考' };
}

function sandboxLabel(sandbox: CodexSandboxMode): string {
  if (sandbox === 'workspace-write') return '工作区可写';
  if (sandbox === 'danger-full-access') return '完全访问';
  return '只读';
}

function compactWorkspace(workspace: string): string {
  const name = basename(workspace);
  return clipText(name || workspace, 40);
}

function shortThread(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 12)}…` : threadId;
}

function emptyBody(state: RunState): string {
  if (state.terminal === 'done') return '_（未返回文本内容）_';
  if (state.terminal === 'running') return '_🧠 正在思考…_';
  return '';
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '′');
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
