import { basename } from 'node:path';
import { homedir } from 'node:os';
import type { TemplateCard } from '@wecom/aibot-node-sdk';
import { taskCard } from '../card-ui/cards';
import { renderWeComAgentCard } from '../card-ui/wecom-renderer';
import type { CardStatus, CardStep, CardTone } from '../card-ui/types';
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
  runState?: RunState;
}

/**
 * Render the same RunState used by the Feishu card renderer as a structured
 * WeCom Markdown stream. The body keeps the agent's Markdown intact while the
 * header behaves like a live Claude-Code-style TUI status panel.
 */
export function renderWeComMarkdown(state: RunState, meta: WeComRenderMeta): string {
  const header = renderLifecyclePanel(state, meta);
  const renderedBody = sanitizeSensitiveText(renderText(sanitizeToolInputs(state))).trim();
  const finalFallback = state.finalText?.trim() ?? '';
  const finalBody = sanitizeSensitiveText(finalFallback);
  const body = [renderedBody, shouldAppendFinalText(state, finalFallback) ? finalBody : '']
    .filter(Boolean)
    .join('\n\n') || emptyBody(state);

  return [header, body].filter(Boolean).join('\n\n');
}

/** Build the persistent WeCom interaction card displayed beside the live stream. */
export function buildWeComControlCard(options: WeComControlCardOptions): TemplateCard {
  const visual = options.runState ? runCardStatus(options.runState) : cardStatus(options.status);
  const running = options.runState
    ? options.runState.terminal === 'running'
    : options.status === 'running' || options.status === 'stopping';
  const workspaceName = compactWorkspace(options.workspace);
  const thread = options.threadId ? `continue ${shortThread(options.threadId)}` : 'new';

  return renderWeComAgentCard(
    taskCard({
      taskId: options.taskId,
      status: visual.semantic,
      tone: visual.tone,
      eyebrow: 'CODEX · WECOM',
      title: options.runState ? visual.title : 'Codex 会话控制',
      subtitle: options.notice ?? (options.runState ? visual.label : '企业微信 ↔ 本机 Codex'),
      body: sanitizeSensitiveText(
        options.prompt?.trim() || '发送消息开始任务；运行状态会持续更新。',
      ),
      fields: [
        { label: 'status', value: visual.label },
        { label: 'workspace', value: workspaceName },
        { label: 'mode', value: sandboxLabel(options.sandbox) },
        { label: 'session', value: thread },
      ],
      steps: options.runState ? lifecycleCardSteps(options.runState) : controlSteps(options.status),
      actions: [
        ...(running ? [{ key: 'stop', label: '停止', tone: 'danger' as const }] : []),
        { key: 'new', label: '新会话', tone: 'secondary' as const },
        { key: 'status', label: '刷新状态', tone: 'primary' as const },
      ],
    }),
  );
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
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const marker = '\n\n…（内容过长，已截断）';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) return takeUtf8Prefix(marker, maxBytes);

  return `${takeUtf8Prefix(text, maxBytes - markerBytes)}${marker}`;
}

function renderLifecyclePanel(state: RunState, meta: WeComRenderMeta): string {
  const status = runStatus(state);
  const thread = meta.threadId ? `\`${escapeInlineCode(shortThread(meta.threadId))}\`` : '`new`';
  const steps = lifecycleTextSteps(state);
  return [
    '### 🤖 **CODEX**',
    `> **▌ ${status.icon} ${status.terminal}** · **${status.label}**`,
    `> **workspace** \`${escapeInlineCode(compactWorkspace(meta.workspace))}\` · **mode** \`${sandboxLabel(meta.sandbox)}\` · **session** ${thread}`,
    ...(steps.length > 0 ? ['>', ...steps.map((step) => `> ${step}`)] : []),
  ].join('\n');
}

function lifecycleTextSteps(state: RunState): string[] {
  const steps: string[] = ['├─ ✓ Runtime connected'];
  const tools = state.blocks.filter((block) => block.kind === 'tool').slice(-3);
  for (const block of tools) {
    if (block.kind !== 'tool') continue;
    const glyph = block.tool.status === 'done' ? '✓' : block.tool.status === 'error' ? '×' : '⟳';
    steps.push(`├─ ${glyph} ${clipText(block.tool.name, 42)}`);
  }

  if (state.terminal === 'done') steps.push('└─ ✓ Task complete');
  else if (state.terminal === 'interrupted') steps.push('└─ ! Task stopped');
  else if (state.terminal === 'idle_timeout') steps.push('└─ ! Idle timeout');
  else if (state.terminal === 'error') steps.push('└─ × Task failed');
  else if (state.footer === 'tool_running') steps.push('└─ ⟳ Tool executing');
  else if (state.footer === 'streaming') steps.push('└─ ⟳ Response streaming');
  else steps.push('└─ ⟳ Reasoning');

  return steps.slice(-5);
}

function lifecycleCardSteps(state: RunState): readonly CardStep[] {
  const steps: CardStep[] = [{ label: 'Runtime connected', status: 'done' }];
  const tools = state.blocks.filter((block) => block.kind === 'tool').slice(-2);
  for (const block of tools) {
    if (block.kind !== 'tool') continue;
    steps.push({ label: clipText(block.tool.name, 48), status: block.tool.status });
  }

  if (state.terminal === 'done') steps.push({ label: 'Task complete', status: 'done' });
  else if (state.terminal === 'interrupted') steps.push({ label: 'Task stopped', status: 'error' });
  else if (state.terminal === 'idle_timeout') steps.push({ label: 'Idle timeout', status: 'error' });
  else if (state.terminal === 'error') steps.push({ label: 'Task failed', status: 'error' });
  else if (state.footer === 'tool_running') steps.push({ label: 'Tool executing', status: 'running' });
  else if (state.footer === 'streaming') steps.push({ label: 'Response streaming', status: 'running' });
  else steps.push({ label: 'Reasoning', status: 'running' });

  return steps.slice(-4);
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

function runStatus(state: RunState): { icon: string; label: string; terminal: string } {
  if (state.terminal === 'done') return { icon: '✓', label: '已完成', terminal: 'DONE' };
  if (state.terminal === 'interrupted') return { icon: '■', label: '已中断', terminal: 'STOPPED' };
  if (state.terminal === 'idle_timeout') return { icon: '!', label: '已超时', terminal: 'TIMEOUT' };
  if (state.terminal === 'error') return { icon: '×', label: '执行失败', terminal: 'FAILED' };
  if (state.footer === 'tool_running') return { icon: '●', label: '正在调用工具', terminal: 'TOOL' };
  if (state.footer === 'streaming') return { icon: '●', label: '正在输出', terminal: 'STREAM' };
  return { icon: '●', label: '正在思考', terminal: 'THINK' };
}

function runCardStatus(state: RunState): {
  title: string;
  label: string;
  semantic: CardStatus;
  tone: CardTone;
} {
  if (state.terminal === 'done') {
    return { title: 'Codex 任务完成', label: 'DONE · 已完成', semantic: 'success', tone: 'success' };
  }
  if (state.terminal === 'interrupted') {
    return { title: 'Codex 任务已停止', label: 'STOPPED · 已中断', semantic: 'warning', tone: 'warning' };
  }
  if (state.terminal === 'idle_timeout') {
    return { title: 'Codex 响应超时', label: 'TIMEOUT · 已超时', semantic: 'warning', tone: 'warning' };
  }
  if (state.terminal === 'error') {
    return { title: 'Codex 执行失败', label: 'FAILED · 执行失败', semantic: 'error', tone: 'danger' };
  }
  if (state.footer === 'tool_running') {
    return { title: 'Codex 正在执行工具', label: 'TOOL · 工具执行中', semantic: 'running', tone: 'info' };
  }
  if (state.footer === 'streaming') {
    return { title: 'Codex 正在输出', label: 'STREAM · 生成回答', semantic: 'running', tone: 'info' };
  }
  return { title: 'Codex 正在思考', label: 'THINK · 推理中', semantic: 'thinking', tone: 'info' };
}

function cardStatus(status: WeComCardStatus): {
  title: string;
  label: string;
  semantic: CardStatus;
  tone: CardTone;
} {
  switch (status) {
    case 'running':
      return { title: 'Codex 会话控制', label: '运行中', semantic: 'running', tone: 'info' };
    case 'stopping':
      return { title: 'Codex 会话控制', label: '停止请求已发送', semantic: 'stopping', tone: 'warning' };
    case 'reset':
      return { title: 'Codex 会话控制', label: '已创建新会话', semantic: 'success', tone: 'success' };
    case 'error':
      return { title: 'Codex 会话控制', label: '操作失败', semantic: 'error', tone: 'danger' };
    case 'idle':
      return { title: 'Codex 会话控制', label: '空闲', semantic: 'idle', tone: 'neutral' };
  }
}

function controlSteps(status: WeComCardStatus): readonly CardStep[] {
  if (status === 'running') {
    return [
      { label: 'Codex runtime connected', status: 'done' },
      { label: 'Agent task executing', status: 'running' },
    ];
  }
  if (status === 'stopping') {
    return [
      { label: 'Stop signal sent', status: 'done' },
      { label: 'Waiting for process exit', status: 'running' },
    ];
  }
  if (status === 'error') return [{ label: 'Action failed', status: 'error' }];
  if (status === 'reset') return [{ label: 'Fresh session ready', status: 'done' }];
  return [{ label: 'Ready for next task', status: 'pending' }];
}

function sandboxLabel(sandbox: CodexSandboxMode): string {
  if (sandbox === 'workspace-write') return 'workspace-write';
  if (sandbox === 'danger-full-access') return 'full-access';
  return 'read-only';
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
  if (state.terminal === 'running') return '_**▌ Codex 正在工作…**_';
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
