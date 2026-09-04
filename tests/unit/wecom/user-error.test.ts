import { describe, expect, it } from 'vitest';
import { containsBackendDiagnostic, weComUserErrorMarkdown } from '../../../src/wecom/user-error';

describe('WeCom user-facing errors', () => {
  it('uses concise startup and execution failure copy', () => {
    expect(weComUserErrorMarkdown('agent-startup')).toContain('启动失败');
    expect(weComUserErrorMarkdown('execution')).toContain('执行失败');
  });

  it('never embeds raw backend diagnostics in the canned user copy', () => {
    for (const kind of ['agent-startup', 'execution'] as const) {
      const text = weComUserErrorMarkdown(kind);
      expect(containsBackendDiagnostic(text)).toBe(false);
      expect(text.length).toBeLessThan(80);
    }
  });

  it('detects representative raw diagnostic payloads', () => {
    expect(containsBackendDiagnostic('{"error":{"message":"model unsupported"}}')).toBe(true);
    expect(containsBackendDiagnostic('stderr: process exited 1')).toBe(true);
    expect(containsBackendDiagnostic('Traceback (most recent call last)')).toBe(true);
  });
});
