import { describe, expect, it } from 'vitest';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';
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
});
