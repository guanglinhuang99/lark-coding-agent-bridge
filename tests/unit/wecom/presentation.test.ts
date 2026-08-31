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
  renderWeComMarkdown,
  truncateUtf8,
} from '../../../src/wecom/presentation';

const meta = {
  workspace: '/Users/test/workspace/web-cli',
  sandbox: 'read-only' as const,
  threadId: 'thread_1234567890abcdef',
};

describe('WeCom rich presentation', () => {
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

  it('renders agent Markdown, tool status, and a card-like status header', () => {
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

    expect(markdown).toContain('### 🤖 Codex');
    expect(markdown).toContain('正在输出');
    expect(markdown).toContain('web-cli');
    expect(markdown).toContain('**Bash**');
    expect(markdown).toContain('**检查完成**');
    expect(markdown).toContain('```text');
  });

  it('builds an interactive control card with stop/new/status actions', () => {
    const card = buildWeComControlCard({
      ...meta,
      taskId: 'codex_123_abc',
      status: 'running',
      prompt: '检查当前仓库状态',
    });

    expect(card.card_type).toBe('button_interaction');
    expect(card.task_id).toBe('codex_123_abc');
    expect(card.main_title?.title).toBe('Codex 会话控制');
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
    expect(first.task_id).toBe('codex_stable_task');
    expect(second.task_id).toBe(first.task_id);
  });

  it('renders thinking, tool, streaming, and done transitions from the shared RunState', () => {
    let state = reduce(freshState(), { type: 'thinking', delta: '分析中' });
    expect(renderWeComMarkdown(state, meta)).toContain('正在思考');

    state = reduce(state, { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} });
    expect(renderWeComMarkdown(state, meta)).toContain('正在调用工具');

    state = reduce(state, { type: 'text', delta: '流式回答' });
    expect(renderWeComMarkdown(state, meta)).toContain('正在输出');

    state = reduce(state, { type: 'done', terminationReason: 'normal' });
    expect(renderWeComMarkdown(state, meta)).toContain('已完成');
  });

  it('shows tool errors, interrupted runs, and terminal errors distinctly', () => {
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
    expect(renderWeComMarkdown(toolState, meta)).toContain('❌ **Bash**');

    expect(renderWeComMarkdown(markInterrupted(freshState()), meta)).toContain('已中断');

    const failed = reduce(freshState(), {
      type: 'error',
      message: 'boom',
      terminationReason: 'failed',
    });
    const failedMarkdown = renderWeComMarkdown(failed, meta);
    expect(failedMarkdown).toContain('执行失败');
    expect(failedMarkdown).toContain('boom');

    const timedOut = reduce(freshState(), {
      type: 'error',
      message: 'idle timeout',
      terminationReason: 'timeout',
    });
    expect(renderWeComMarkdown(timedOut, meta)).toContain('已超时');
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

  it('redacts common secrets and compacts the home path in tool summaries', () => {
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
    expect(markdown).toContain('WECOM_SECRET=[REDACTED]');
    expect(markdown).toContain('~/private/secret.txt');
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
