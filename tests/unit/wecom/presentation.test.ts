import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import {
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state';
import {
  buildWeComControlCard,
  renderWeComAcknowledgement,
  renderWeComMarkdown,
  renderWeComNotice,
  renderWeComRiskOutput,
  truncateUtf8,
} from '../../../src/wecom/presentation';

const meta = {
  workspace: '/Users/test/workspace/web-cli',
  sandbox: 'read-only' as const,
  threadId: 'thread_1234567890abcdef',
};

describe('WeCom rich presentation', () => {
  it('immediately echoes typed text or a selected candidate', () => {
    const input = renderWeComAcknowledgement('input', '  安联 ESG\n纯债 1 号  ');
    expect(input).toContain('### ◇ **WECOM · INPUT**');
    expect(input).toContain('**▌ ○ READY** · **输入已接收**');
    expect(input).toContain('已输入「安联 ESG 纯债 1 号」。');

    const selection = renderWeComAcknowledgement(
      'selection',
      '安联ESG纯债1号资产管理产品',
    );
    expect(selection).toContain('**▌ ○ READY** · **选择已接收**');
    expect(selection).toContain('已选择「安联ESG纯债1号资产管理产品」。');
  });

  it('renders notices and long risk output through the shared TUI surface', () => {
    const progress = renderWeComNotice('⏳ 风险限额查询中', ['正在读取规则和持仓。']);
    expect(progress).toContain('### ⏳ **RISK · WECOM**');
    expect(progress).toContain('**▌ ● RUNNING** · **风险限额查询中**');
    expect(progress).toContain('> └─ 正在读取规则和持仓。');

    const result = renderWeComRiskOutput(
      '🔴 **未通过**：本笔投资引发 1 项新增超限/问题\n\n- 现金不足',
    );
    expect(result).toContain('### ❌ **RISK · WECOM**');
    expect(result).toContain('**▌ × FAILED** · **风险检查未通过**');
    expect(result).toContain('🔴 **未通过**：本笔投资引发 1 项新增超限/问题');
    expect(result).toContain('- 现金不足');

    const selectionResult = renderWeComRiskOutput('请选择匹配的证券。', true);
    expect(selectionResult).toContain('**▌ ! ACTION REQUIRED** · **等待用户操作**');

    const passed = renderWeComRiskOutput('🟢 本笔投资未引发新增超限。');
    expect(passed).toContain('**▌ ✓ COMPLETED** · **风险检查完成**');
  });

  it('preserves headings, lists, quotes, links, bold, inline code, and code fences', () => {
    const source = [
      '# 标题',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '> 引用',
      '',
      '[链接](https://example.com) **粗体** `inline()`',
      '',
      '```ts',
      'const value = "中文🙂";',
      '```',
    ].join('\n');
    const state = reduce(freshState(), { type: 'text', delta: source });

    const markdown = renderWeComMarkdown(state, meta);

    expect(markdown).toContain('# 标题');
    expect(markdown).toContain('- 第一项');
    expect(markdown).toContain('> 引用');
    expect(markdown).toContain('[链接](https://example.com)');
    expect(markdown).toContain('**粗体** `inline()`');
    expect(markdown).toContain('```ts');
    expect(markdown).toContain('中文🙂');
  });

  it('renders agent Markdown with user-facing progress and no runtime details', () => {
    let state: RunState = {
      ...initialState,
      blocks: [],
      reasoning: { ...initialState.reasoning },
    };
    state = reduce(state, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'git status --short' },
    });
    state = reduce(state, {
      type: 'tool_result',
      id: 'tool-1',
      output: 'clean',
      isError: false,
    });
    state = reduce(state, {
      type: 'text',
      delta: '**检查完成**\n\n```text\nclean\n```',
    });

    const markdown = renderWeComMarkdown(state, meta);

    expect(markdown).toContain('### 🤖 **CODEX**');
    expect(markdown).toContain('**▌ ● STREAM**');
    expect(markdown).toContain('└─ ⟳ 正在整理回答…');
    expect(markdown).not.toContain('workspace');
    expect(markdown).not.toContain('session');
    expect(markdown).not.toContain('Bash');
    expect(markdown).not.toContain('git status');
    expect(markdown).toContain('**检查完成**');
    expect(markdown).toContain('```text');
  });

  it('builds a TUI-style interactive control card with stop/new/status actions', () => {
    const card = buildWeComControlCard({
      ...meta,
      taskId: 'codex_123_abc',
      status: 'running',
      prompt: '检查当前仓库状态',
    });

    expect(card.card_type).toBe('button_interaction');
    expect(card.task_id).toBe('codex_123_abc');
    expect(card.source?.desc).toBe('▌ CODEX · WECOM');
    expect(card.main_title?.title).toContain('正在处理');
    expect(card.sub_title_text).toContain('RUNNING');
    expect(card.sub_title_text).toContain('✓ 请求已接收');
    expect(card.sub_title_text).toContain('⟳ 正在处理请求');
    expect(card.horizontal_content_list).toBeUndefined();
    expect(card.button_list?.map((button) => button.key)).toEqual(['stop', 'new', 'status']);
    expect(JSON.stringify(card)).toContain('检查当前仓库状态');
  });

  it('omits stop while idle and keeps a caller-provided task id stable', () => {
    const first = buildWeComControlCard({
      ...meta,
      taskId: 'codex_stable_task',
      status: 'idle',
    });
    const second = buildWeComControlCard({
      ...meta,
      taskId: 'codex_stable_task',
      status: 'idle',
    });

    expect(first.button_list?.map((button) => button.key)).toEqual(['new', 'status']);
    expect(first.sub_title_text).toContain('READY');
    expect(first.task_id).toBe('codex_stable_task');
    expect(second.task_id).toBe(first.task_id);
  });

  it('refreshes the control card from live RunState', () => {
    let state = reduce(freshState(), {
      type: 'tool_use',
      id: 'tool-live',
      name: 'npm run ci',
      input: {},
    });
    let card = buildWeComControlCard({
      ...meta,
      taskId: 'codex_live_task',
      status: 'running',
      prompt: '测试项目',
      runState: state,
    });

    expect(card.main_title?.title).toContain('正在处理');
    expect(card.sub_title_text).toContain('RUNNING');
    expect(card.sub_title_text).toContain('⟳ 正在处理请求');
    expect(JSON.stringify(card)).not.toContain('npm run ci');

    state = reduce(state, {
      type: 'tool_result',
      id: 'tool-live',
      output: 'pass',
      isError: false,
    });
    state = reduce(state, { type: 'done', terminationReason: 'normal' });
    card = buildWeComControlCard({
      ...meta,
      taskId: 'codex_live_task',
      status: 'running',
      prompt: '测试项目',
      runState: state,
    });

    expect(card.main_title?.title).toContain('处理完成');
    expect(card.sub_title_text).toContain('COMPLETED');
    expect(card.button_list?.map((button) => button.key)).toEqual(['new', 'status']);
  });

  it('renders thinking, tool, streaming, and done transitions from the shared RunState', () => {
    let state = reduce(freshState(), { type: 'thinking', delta: '分析中' });
    expect(renderWeComMarkdown(state, meta)).toContain('THINK');

    state = reduce(state, { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} });
    expect(renderWeComMarkdown(state, meta)).toContain('RUNNING');
    expect(renderWeComMarkdown(state, meta)).not.toContain('Read');

    state = reduce(state, { type: 'text', delta: '流式回答' });
    expect(renderWeComMarkdown(state, meta)).toContain('STREAM');

    state = reduce(state, { type: 'done', terminationReason: 'normal' });
    expect(renderWeComMarkdown(state, meta)).toBe('流式回答');
  });

  it('hides tool errors while keeping interrupted and terminal errors user-readable', () => {
    let toolState = reduce(freshState(), {
      type: 'tool_use',
      id: 'tool-error',
      name: 'Bash',
      input: { command: 'false' },
    });
    toolState = reduce(toolState, {
      type: 'tool_result',
      id: 'tool-error',
      output: 'failed',
      isError: true,
    });
    expect(renderWeComMarkdown(toolState, meta)).not.toContain('Bash');
    expect(renderWeComMarkdown(toolState, meta)).not.toContain('false');

    expect(renderWeComMarkdown(markInterrupted(freshState()), meta)).toContain('已中断');

    const failed = reduce(freshState(), {
      type: 'error',
      message: 'boom',
      terminationReason: 'failed',
    });
    const failedMarkdown = renderWeComMarkdown(failed, meta);
    expect(failedMarkdown).toContain('执行失败');
    expect(failedMarkdown).not.toContain('boom');

    const timedOut = reduce(freshState(), {
      type: 'error',
      message: 'idle timeout',
      terminationReason: 'timeout',
    });
    expect(renderWeComMarkdown(timedOut, meta)).toContain('已超时');
  });

  it('sanitizes raw diagnostics from an error RunState before final Markdown rendering', () => {
    const rawDiagnostic =
      '{"error":{"message":"model unsupported","internal":"..."}} stderr stack traceback';
    let state = reduce(freshState(), { type: 'text', delta: rawDiagnostic });
    state = reduce(
      { ...state, finalText: rawDiagnostic },
      { type: 'error', message: rawDiagnostic, terminationReason: 'failed' },
    );

    const markdown = renderWeComMarkdown(state, meta);
    const normalized = markdown.toLowerCase();

    expect(markdown).toContain('❌ Codex 执行失败');
    expect(normalized).not.toContain('error');
    expect(normalized).not.toContain('internal');
    expect(normalized).not.toContain('stderr');
    expect(normalized).not.toContain('stack');
    expect(normalized).not.toContain('traceback');
    expect(markdown).not.toContain('model unsupported');
    expect(markdown).not.toContain('{"');
  });

  it('uses final_text when the stream did not emit text blocks', () => {
    const state: RunState = {
      ...initialState,
      blocks: [],
      reasoning: { ...initialState.reasoning },
      finalText: '最终回答',
      terminal: 'done',
      footer: null,
    };

    expect(renderWeComMarkdown(state, meta)).toContain('最终回答');
  });

  it('does not lose final_text after progress text and tool activity', () => {
    let state = reduce(freshState(), { type: 'text', delta: '先检查仓库。' });
    state = reduce(state, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'git status --short' },
    });
    state = reduce(state, { type: 'final_text', content: '最终结论' });
    state = reduce(state, { type: 'done', terminationReason: 'normal' });

    const markdown = renderWeComMarkdown(state, meta);
    expect(markdown).toContain('先检查仓库。');
    expect(markdown).toContain('最终结论');
  });

  it('does not expose tool inputs or secrets in the user-facing stream', () => {
    const secret = 'do-not-show-this-value';
    const state = reduce(freshState(), {
      type: 'tool_use',
      id: 'tool-secret',
      name: 'Bash',
      input: {
        command: `WECOM_SECRET=${secret} cat ${homedir()}/private/secret.txt`,
      },
    });

    const markdown = renderWeComMarkdown(state, meta);
    expect(markdown).not.toContain(secret);
    expect(markdown).not.toContain(homedir());
    expect(markdown).not.toContain('WECOM_SECRET');
    expect(markdown).not.toContain('private/secret.txt');
    expect(markdown).not.toContain('Bash');
  });

  it('does not include tool output in the compact WeCom Markdown view', () => {
    let state = reduce(freshState(), {
      type: 'tool_use',
      id: 'tool-output',
      name: 'Bash',
      input: { command: 'printf result' },
    });
    state = reduce(state, {
      type: 'tool_result',
      id: 'tool-output',
      output: 'sensitive-output'.repeat(2_000),
      isError: false,
    });

    expect(renderWeComMarkdown(state, meta)).not.toContain('sensitive-output');
  });

  it('truncates by UTF-8 bytes without breaking Chinese or emoji', () => {
    const truncated = truncateUtf8('中文🙂'.repeat(100), 80);

    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(80);
    expect(truncated).toContain('已截断');
    expect(truncated).not.toContain('�');
  });

  it('also respects limits smaller than the truncation marker', () => {
    const truncated = truncateUtf8('中文🙂'.repeat(100), 10);

    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(10);
    expect(truncated).not.toContain('�');
  });

  it('returns no bytes for a non-positive byte budget', () => {
    expect(truncateUtf8('中文🙂', 0)).toBe('');
    expect(Buffer.byteLength(truncateUtf8('中文🙂', 0), 'utf8')).toBe(0);
  });
});

function freshState(): RunState {
  return {
    ...initialState,
    blocks: [],
    reasoning: { ...initialState.reasoning },
  };
}
