export type WeComUserErrorKind = 'agent-startup' | 'execution';

/**
 * User-facing failure copy for WeCom streams. Raw stderr, backend JSON and
 * stack diagnostics must stay in structured/local logs and never be copied into
 * the Markdown response.
 */
export function weComUserErrorMarkdown(kind: WeComUserErrorKind): string {
  return kind === 'agent-startup'
    ? '❌ Codex 启动失败，请稍后重试或查看错误卡片。'
    : '❌ Codex 执行失败，请稍后重试或查看错误卡片。';
}

export function containsBackendDiagnostic(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('stderr') ||
    normalized.includes('stack') ||
    normalized.includes('traceback') ||
    normalized.includes('"error"') ||
    normalized.includes('{"')
  );
}
