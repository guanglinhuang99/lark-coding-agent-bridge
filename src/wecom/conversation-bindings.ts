import { ConversationState, scopeRecordKey } from '../bridge/conversation-state';
import { conversationViews } from '../bridge/conversation-views';
import {
  canonicalWorkspace, type BridgeIdentity, type SessionBindingIdentity,
} from '../bridge/identity';
import type { ThreadSessionStoreOptions } from '../bridge/thread-session-store';

export interface WeComConversationBindingOptions extends ThreadSessionStoreOptions {
  identity: BridgeIdentity;
  workspace: string;
  policyFingerprint: string;
}

/** WeCom compatibility surface over the same session/workspace backend as Lark. */
export class WeComConversationBindings {
  private readonly state: ConversationState;
  private readonly views: ReturnType<typeof conversationViews>;
  constructor(private readonly legacyFile: string, private readonly options: WeComConversationBindingOptions) {
    this.state = new ConversationState(`${legacyFile}.bridge-v2.json`);
    this.views = conversationViews(this.state, options.identity);
  }
  async load(): Promise<void> {
    await this.state.load(this.options.identity, { wecomThreads: this.legacyFile });
    await this.prune();
  }
  /** Capture at ingress, before any await or queue admission. Runtime registries
   * use this key; persisted sessions retain their original conversation scope. */
  captureScope(scope: string, cwd?: string): string {
    if (decodeScope(scope) && cwd === undefined) return scope;
    scope = this.conversationScope(scope);
    const prefix = scope.startsWith('group:') ? 'group:' : 'single:';
    return `${prefix}workspace-v1:${JSON.stringify([scope, canonicalWorkspace(cwd ?? this.workspaceFor(scope))])}`;
  }
  conversationScope(scope: string): string { return decodeScope(scope)?.[0] ?? scope; }
  workspaceFor(scope: string): string {
    return decodeScope(scope)?.[1] ?? this.views.workspaces.cwdFor(scope) ?? this.options.workspace;
  }
  bindingFor(scope: string): SessionBindingIdentity {
    return {
      scopeId: this.conversationScope(scope), agentId: 'codex', cwdRealpath: canonicalWorkspace(this.workspaceFor(scope)),
      policyFingerprint: this.options.policyFingerprint,
    };
  }
  threadId(scope: string): string | undefined {
    let binding: SessionBindingIdentity;
    try { binding = this.bindingFor(scope); } catch { return undefined; }
    const entry = this.views.sessionCatalog.activeFor(binding);
    const maxAge = this.options.maxAgeMs ?? 90 * 24 * 60 * 60 * 1000;
    return entry && this.now() - entry.updatedAt <= maxAge ? entry.threadId : undefined;
  }
  /** Only this conversation's verified threads may appear in /resume. A cwd-only
   * Codex history listing can include threads belonging to other users. */
  sessionsFor(scope: string): Array<{ threadId: string; updatedAt: number; status: 'active' | 'archived' }> {
    const binding = this.bindingFor(scope);
    const maxAge = this.options.maxAgeMs ?? 90 * 24 * 60 * 60 * 1000;
    const seen = new Set<string>();
    return this.views.sessionCatalog.entries()
      .filter(entry => entry.scopeId === binding.scopeId && entry.cwdRealpath === binding.cwdRealpath &&
        entry.policyFingerprint === binding.policyFingerprint && entry.threadId && this.now() - entry.updatedAt <= maxAge)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(entry => !seen.has(entry.threadId!) && Boolean(seen.add(entry.threadId!)))
      .map(entry => ({ threadId: entry.threadId!, updatedAt: entry.updatedAt, status: entry.status }));
  }
  async setThread(scope: string, threadId: string, binding = this.bindingFor(scope)): Promise<void> {
    const captured = decodeScope(scope);
    if (this.conversationScope(scope) !== binding.scopeId || binding.agentId !== 'codex' ||
        (captured && captured[1] !== binding.cwdRealpath)) throw new Error('Session scope mismatch');
    // A late result remains bound to the workspace/policy captured at run start;
    // it cannot overwrite the newly selected workspace's session.
    this.views.sessionCatalog.upsertActive({ ...binding, threadId, now: this.now() });
    await this.state.flush();
  }
  async clear(scope: string): Promise<void> {
    const binding = this.bindingFor(scope);
    for (const entry of this.views.sessionCatalog.entries()) {
      if (entry.scopeId === binding.scopeId && entry.cwdRealpath === binding.cwdRealpath) {
        this.views.sessionCatalog.archiveActive(entry);
      }
    }
    this.state.change(this.options.identity, (bucket) => { delete bucket.unverifiedThreads[scopeRecordKey(this.conversationScope(scope))]; });
    await this.state.flush();
  }
  async bindWorkspace(scope: string, cwd: string): Promise<void> {
    scope = this.conversationScope(scope);
    const canonical = canonicalWorkspace(cwd);
    const previous = this.views.workspaces.cwdFor(scope);
    this.views.workspaces.setCwd(scope, canonical);
    try {
      await this.state.flush();
    } catch (error) {
      // Restore only our own selection; a newer switch must not be rolled back.
      if (this.views.workspaces.cwdFor(scope) === canonical) {
        if (previous === undefined) this.views.workspaces.removeCwd(scope);
        else this.views.workspaces.setCwd(scope, previous);
        await this.state.flush().catch(() => {});
      }
      throw error;
    }
  }
  async prune(): Promise<number> {
    let removed = 0;
    this.state.change(this.options.identity, (bucket) => {
      const cutoff = this.now() - (this.options.maxAgeMs ?? 90 * 24 * 60 * 60 * 1000);
      const entries = Object.values(bucket.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const [index, entry] of entries.entries()) {
        if (entry.updatedAt < cutoff || index >= (this.options.maxEntries ?? 2000)) {
          delete bucket.sessions[entry.key]; removed++;
        }
      }
      for (const [key, entry] of Object.entries(bucket.unverifiedThreads)) {
        if (Date.parse(entry.updatedAt) < cutoff) { delete bucket.unverifiedThreads[key]; removed++; }
      }
    });
    await this.state.flush();
    return removed;
  }
  async flush(): Promise<void> { await this.state.flush(); }
  private now(): number { return this.options.now?.().getTime() ?? Date.now(); }
}

function decodeScope(scope: string): [string, string] | undefined {
  const prefix = /^(?:group|single):workspace-v1:/.exec(scope)?.[0];
  if (!prefix) return undefined;
  const value: unknown = JSON.parse(scope.slice(prefix.length));
  if (!Array.isArray(value) || value.length !== 2 ||
      !value.every(item => typeof item === 'string' && item.length > 0)) {
    throw new Error('Invalid workspace conversation scope');
  }
  return value as [string, string];
}
