import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { buildSessionSelectionCardView } from '../../../src/wecom/ui/navigation';
import { renderWeComCard } from '../../../src/wecom/ui/renderer';
import { WeComNavigationCardRegistry } from '../../../src/wecom/ui/navigation-registry';

// Execute the actual CLI handlers without evaluating its top-level robot startup.
const source = ts.createSourceFile('cli.ts', readFileSync(new URL('../../../src/wecom/cli.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function handler(name: string, dependencies: Record<string, unknown>) {
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing CLI handler: ${name}`);
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(`${code}\n${name}`, dependencies) as (...args: unknown[]) => Promise<void>;
}
function harness() {
  const history = vi.fn().mockResolvedValue([{ threadId: 'thread-alpha-secret', name: 'private prompt', cwd: '/private-workspace', updatedAtMs: 1 }]);
  const sessionsFor = vi.fn().mockReturnValue([{ threadId: 'thread-alpha-secret', updatedAt: 1, status: 'active' }]);
  const register = vi.fn();
  const reply = vi.fn().mockResolvedValue(undefined);
  const notice = vi.fn().mockResolvedValue(undefined);
  const workspaceFor = vi.fn().mockReturnValue('/private-workspace');
  const dependencies = {
    sessionStore: { workspaceFor, sessionsFor }, createNavigationTaskId: () => 'session_test',
    operationRunner: { run: (_name: string, fn: () => unknown) => fn() }, listCodexThreadHistory: history,
    process: { env: {} }, stateDir: '/fake-state', path: { basename: () => 'private-workspace' },
    formatRelTime: () => '3m ago', registerNavigationTask: register,
    client: { replyTemplateCard: reply }, replyNoticeCard: notice,
    buildSessionSelectionCardView, renderWeComCard,
    log: { warn: vi.fn() }, redactDiagnosticText: (s: string) => s,
  };
  return { run: handler('replySessionSelection', dependencies), history, sessionsFor, register, reply, notice, workspaceFor };
}
describe('WeCom CLI resume privacy', () => {
  it('restores the registered full ID in private chat and rejects a fingerprint', async () => {
    const registry = new WeComNavigationCardRegistry();
    registry.register({ taskId: 'session_private', purpose: 'session', conversationKey: 'single:u',
      optionLabels: new Map([['thread-alpha-secret', 'private prompt']]), expiresAt: Date.now() + 60_000 });
    const setThread = vi.fn().mockResolvedValue(undefined);
    const invalid = vi.fn().mockResolvedValue(undefined);
    const run = handler('handleNavigationCardEvent', {
      navigationCards: registry, navigationActionForPurpose: () => 'session.resume',
      updateInvalidCallback: invalid, isConversationBusy: () => false,
      sessionStore: { setThread, sessionsFor: () => [{ threadId: 'thread-alpha-secret' }] }, replyNavigationResult: vi.fn().mockResolvedValue(undefined),
    });
    await run({}, 'single:u', 'session_private', 'session', 'session.resume', '#a1b2c3');
    expect(invalid).toHaveBeenCalledOnce();
    expect(setThread).not.toHaveBeenCalled();
    await run({}, 'single:u', 'session_private', 'session', 'session.resume', 'thread-alpha-secret');
    expect(setThread).toHaveBeenCalledOnce();
    expect(setThread).toHaveBeenCalledWith('single:u', 'thread-alpha-secret');
  });
  it('blocks group history before querying, registering or rendering candidates', async () => {
    const h = harness();
    await h.run({ body: { chattype: 'group', chatid: 'g' } }, 'group:g');
    expect(h.history).not.toHaveBeenCalled();
    expect(h.workspaceFor).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.notice).toHaveBeenCalledOnce();
    const text = JSON.stringify(h.notice.mock.calls);
    expect(text).toContain('私聊');
    for (const secret of ['private prompt', 'private-workspace', 'thread-alpha-secret']) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/#[a-f0-9]{6}/);
  });
  it('also blocks an inferred group conversation without chattype', async () => {
    const h = harness();
    await h.run({ body: { chatid: 'g' } }, 'group:g');
    expect(h.history).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.notice).toHaveBeenCalledOnce();
  });
  it('preserves private-chat candidates and full callback IDs', async () => {
    const h = harness();
    await h.run({ body: { chattype: 'single' } }, 'single:u');
    expect(h.history).not.toHaveBeenCalled();
    expect(h.sessionsFor).toHaveBeenCalledWith('single:u');
    expect(h.register).toHaveBeenCalledWith('session_test', 'session', 'single:u', [['thread-alpha-secret', 'Codex 会话 thread-a']]);
    expect(h.reply.mock.calls[0]?.[1].button_selection.option_list[0].id).toBe('thread-alpha-secret');
    expect(h.notice).not.toHaveBeenCalled();
  });
  it('rejects a registered candidate whose ownership no longer matches the current scope', async () => {
    const registry = new WeComNavigationCardRegistry();
    registry.register({ taskId: 'session_stale', purpose: 'session', conversationKey: 'single:u',
      optionLabels: new Map([['someone-elses-thread', 'old entry']]), expiresAt: Date.now() + 60_000 });
    const setThread = vi.fn();
    const invalid = vi.fn();
    const run = handler('handleNavigationCardEvent', {
      navigationCards: registry, navigationActionForPurpose: () => 'session.resume',
      updateInvalidCallback: invalid, isConversationBusy: () => false,
      sessionStore: { setThread, sessionsFor: () => [{ threadId: 'own-thread' }] },
    });
    await run({}, 'single:u', 'session_stale', 'session', 'session.resume', 'someone-elses-thread');
    expect(invalid).toHaveBeenCalledOnce();
    expect(setThread).not.toHaveBeenCalled();
  });
  it('rejects an old group session callback before resolving or consuming it', async () => {
    const invalid = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn();
    const setThread = vi.fn();
    const run = handler('handleNavigationCardEvent', {
      updateInvalidCallback: invalid,
      navigationActionForPurpose: () => 'session.resume',
      navigationCards: { resolve }, sessionStore: { setThread },
    });
    await run({}, 'group:g', 'session_old', 'session', 'session.resume', 'thread-alpha-secret');
    expect(invalid).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(setThread).not.toHaveBeenCalled();
  });
});
