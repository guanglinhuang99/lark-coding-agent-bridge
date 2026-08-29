import { basename } from 'node:path';
import type { TemplateCard } from '@wecom/aibot-node-sdk';
import { renderText } from '../card/text-renderer';
import type { RunState } from '../card/run-state';
import type { CodexSandboxMode } from '../config/permissions';

export type WeComCardStatus = 'running' | 'idle' | 'stopping' | 'reset' | 'error';

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

  const renderedBody = renderText(state).trim();
  const finalFallback = state.finalText?.trim() ?? '';
  const body = renderedBody || finalFallback || emptyBody(state);

  return [header, body].filter(Boolean).join('\n\n');
}

/** Build the persistent WeCom interaction card displayed beside the stream. */
export function buildWeComControlCard(options: WeComControlCardOptions): TemplateCard {
  const running = options.status === 'running' || options.status === 'stopping';
  const status = cardStatus(options.status);
  const workspaceName = compactWorkspace(options.workspace);
  const thread = options.threadId ? `继续 ${shortThread(options.threadId)}` : '新会话';

  return {
    card_type: 'button_interaction',
    source: {
      desc: 'Codex Bridge',
      desc_color: status.color,
    },
    main_title: {
      title: 'Codex 会话控制',
      desc: clipText(options.notice ?? '企业微信 ↔ 本机 Codex（使用 ChatGPT/Codex 订阅）', 30),
    },
    sub_title_text: clipText(options.prompt?.trim() || '发送消息开始对话；回答主体使用 Markdown 富文本流。', 112),
    horizontal_content_list: [
      { keyname: '状态', value: clipText(status.label, 26) },
      { keyname: '工作区', value: clipText(workspaceName, 26) },
      { keyname: '权限', value: clipText(sandboxLabel(options.sandbox), 26) },
      { keyname: '会话', value: clipText(thread, 26) },
    ],
    button_list: [
      ...(running ? [{ text: '停止', style: 4, key: 'stop' }] : []),
      { text: '新会话', style: 2, key: 'new' },
      { text: '查看状态', style: 1, key: 'status' },
    ],
    task_id: options.taskId,
  };
}

export function renderWeComNotice(title: string, lines: readonly string[]): string {
  const content = lines.filter((line) => line.trim()).map((line) => `> ${line}`).join('\n');
  return [`### ${title}`, content].filter(Boolean).join('\n\n');
}

/**
 * WeCom limits stream content by UTF-8 bytes, not JavaScript characters.
 * Truncate at code-point boundaries so Chinese and emoji are never corrupted.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return text;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const marker = '\n\n…（内容过长，已截断）';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) return takeUtf8Prefix(marker, maxBytes);

  return `${takeUtf8Prefix(text, maxBytes - markerBytes)}${marker}`;
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

function cardStatus(status: WeComCardStatus): { label: string; color: 0 | 1 | 2 | 3 } {
  switch (status) {
    case 'running':
      return { label: '运行中', color: 0 };
    case 'stopping':
      return { label: '停止请求已发送', color: 2 };
    case 'reset':
      return { label: '已创建新会话', color: 3 };
    case 'error':
      return { label: '操作失败', color: 2 };
    case 'idle':
      return { label: '空闲', color: 3 };
  }
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
