import { ConversationState, scopeRecordKey } from '../bridge/conversation-state';
import { conversationViews } from '../bridge/conversation-views';
import {
  canonicalWorkspace, sessionBindingKey, type BridgeIdentity, type SessionBindingIdentity,
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
  workspaceFor(scope: string): string { return this.views.workspaces.cwdFor(scope) ?? this.options.workspace; }
  bindingFor(scope: string): SessionBindingIdentity {
    return {
      scopeId: scope, agentId: 'codex', cwdRealpath: canonicalWorkspace(this.workspaceFor(scope)),
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
  async setThread(scope: string, threadId: string, binding = this.bindingFor(scope)): Promise<void> {
    if (scope !== binding.scopeId || binding.agentId !== 'codex') throw new Error('Session scope mismatch');
    // A late result remains bound to the workspace/policy captured at run start;
    // it cannot overwrite the newly selected workspace's session.
    this.views.sessionCatalog.upsertActive({ ...binding, threadId, now: this.now() });
    await this.state.flush();
  }
  async clear(scope: string): Promise<void> {
    for (const entry of this.views.sessionCatalog.entries()) {
      if (entry.scopeId === scope) this.views.sessionCatalog.archiveActive(entry);
    }
    this.state.change(this.options.identity, (bucket) => { delete bucket.unverifiedThreads[scopeRecordKey(scope)]; });
    await this.state.flush();
  }
  async bindWorkspace(scope: string, cwd: string): Promise<void> {
    const canonical = canonicalWorkspace(cwd);
    this.views.workspaces.setCwd(scope, canonical);
    await this.state.flush();
  }
  async prune(): Promise<number> {
    let removed = 0;
    this.state.change(this.options.identity, (bucket) => {
      const cutoff = this.now() - (this.options.maxAgeMs ?? 90 * 24 * 60 * 60 * 1000);
      const entries = Object.values(bucket.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const [index, entry] of entries.entries()) {
        if (entry.updatedAt < cutoff || index >= (this.options.maxEntries ?? 2000)) {
          delete bucket.sessions[sessionBindingKey(this.options.identity, entry)]; removed++;
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
