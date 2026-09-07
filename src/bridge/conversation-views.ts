import { ConversationState, scopeRecordKey, type ConversationBucket } from './conversation-state';
import { sessionBindingKey, type BridgeIdentity } from './identity';
import { SessionStore, type SessionEntry } from './session-store';
import {
  SessionCatalog, type SessionCatalogIdentity, type SessionCatalogEntry,
  type UpsertSessionCatalogInput, type ArchiveSessionCatalogInput, type SessionCatalogGcOptions,
} from './session-catalog';
import { WorkspaceStore } from './workspace-store';

/** Compatibility views; all three APIs persist through ONE shared, namespaced writer. */
export function conversationViews(state: ConversationState, identity: BridgeIdentity) {
  const context = Object.freeze({ ...identity });
  return {
    sessions: new PreferenceView(state, context),
    sessionCatalog: new CatalogView(state, context),
    workspaces: new WorkspaceView(state, context),
  };
}

class PreferenceView extends SessionStore {
  constructor(private readonly state: ConversationState, private readonly context: BridgeIdentity) { super(state.file); }
  override async load(): Promise<void> { /* The owner loads/migrates the shared writer. */ }
  override async flush(): Promise<void> { await this.state.flush(); }
  // Legacy session records carry no permission fingerprint. Only CatalogView can
  // authorize automatic resume; exposing a cwd-only fallback would defeat isolation.
  override resumeFor(_scope: string, _cwd: string): string | undefined { return undefined; }
  override getRaw(scope: string): SessionEntry | undefined {
    return this.state.read(this.context).preferences[scopeRecordKey(scope)];
  }
  override set(scope: string, sessionId: string, cwd: string): void {
    this.state.change(this.context, (bucket) => {
      const key = scopeRecordKey(scope);
      bucket.preferences[key] = { ...bucket.preferences[key], sessionId, cwd, updatedAt: Date.now() };
    });
  }
  override clear(scope: string): void {
    this.state.change(this.context, (bucket) => {
      const key = scopeRecordKey(scope);
      const minutes = bucket.preferences[key]?.idleTimeoutMinutes;
      if (minutes === undefined) delete bucket.preferences[key];
      else bucket.preferences[key] = { idleTimeoutMinutes: minutes, updatedAt: Date.now() };
    });
  }
  override getIdleTimeoutMinutes(scope: string): number | undefined { return this.getRaw(scope)?.idleTimeoutMinutes; }
  override setIdleTimeoutMinutes(scope: string, minutes: number): void {
    if (!Number.isFinite(minutes)) throw new Error('Invalid idle timeout');
    this.state.change(this.context, (bucket) => {
      const key = scopeRecordKey(scope);
      bucket.preferences[key] = {
        ...bucket.preferences[key], updatedAt: Date.now(),
        idleTimeoutMinutes: Math.min(Math.max(Math.floor(minutes), 0), 120),
      };
    });
  }
  override clearIdleTimeoutOverride(scope: string): boolean {
    if (this.getRaw(scope)?.idleTimeoutMinutes === undefined) return false;
    this.state.change(this.context, (bucket) => {
      delete bucket.preferences[scopeRecordKey(scope)]!.idleTimeoutMinutes;
    });
    return true;
  }
}

class CatalogView extends SessionCatalog {
  constructor(private readonly state: ConversationState, private readonly context: BridgeIdentity) { super(state.file); }
  override async load(): Promise<void> {}
  override async flush(): Promise<void> { await this.state.flush(); }
  override entries(): SessionCatalogEntry[] { return Object.values(this.state.read(this.context).sessions); }
  override activeFor(input: SessionCatalogIdentity): SessionCatalogEntry | undefined {
    const entry = this.state.read(this.context).sessions[sessionBindingKey(this.context, input)];
    return entry?.status === 'active' ? entry : undefined;
  }
  override upsertActive(input: UpsertSessionCatalogInput): SessionCatalogEntry {
    const key = sessionBindingKey(this.context, input);
    const entry: SessionCatalogEntry = {
      key, scopeId: input.scopeId, agentId: input.agentId, cwdRealpath: input.cwdRealpath,
      policyFingerprint: input.policyFingerprint, status: 'active', updatedAt: input.now ?? Date.now(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.lastSummary ? { lastSummary: input.lastSummary } : {}),
    };
    this.state.change(this.context, (bucket) => { bucket.sessions[key] = entry; });
    return { ...entry };
  }
  override archiveActive(input: ArchiveSessionCatalogInput): boolean {
    const entry = this.activeFor(input);
    if (!entry) return false;
    this.state.change(this.context, (bucket) => {
      bucket.sessions[entry.key] = { ...entry, status: 'archived', updatedAt: input.now ?? Date.now() };
    });
    return true;
  }
  override gc(options: SessionCatalogGcOptions = {}): void {
    this.state.change(this.context, (bucket) => {
      const now = options.now ?? Date.now();
      const maxAge = options.maxArchivedAgeMs ?? 90 * 24 * 60 * 60 * 1000;
      for (const entry of Object.values(bucket.sessions)) {
        if (entry.status === 'archived' && now - entry.updatedAt > maxAge) delete bucket.sessions[entry.key];
      }
      const newest = Object.values(bucket.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
      const counts = new Map<string, number>();
      let retained = 0;
      for (const entry of newest) {
        const count = counts.get(entry.scopeId) ?? 0;
        if (entry.status === 'archived' &&
            (count >= (options.maxEntriesPerScope ?? 20) || retained >= (options.maxEntriesPerProfile ?? 1000))) {
          delete bucket.sessions[entry.key];
        } else {
          counts.set(entry.scopeId, count + 1);
          retained++;
        }
      }
    });
  }
  override async replaceForTest(entries: SessionCatalogEntry[]): Promise<void> {
    this.state.change(this.context, (bucket) => {
      bucket.sessions = Object.fromEntries(entries.map((entry) => {
        const key = sessionBindingKey(this.context, entry);
        return [key, { ...entry, key }];
      }));
    });
    await this.flush();
  }
}

class WorkspaceView extends WorkspaceStore {
  constructor(private readonly state: ConversationState, private readonly context: BridgeIdentity) { super(state.file); }
  override async load(): Promise<void> {}
  override async flush(): Promise<void> { await this.state.flush(); }
  override cwdFor(scope: string): string | undefined { return this.state.read(this.context).workspaces[scopeRecordKey(scope)]; }
  override setCwd(scope: string, cwd: string): void {
    this.state.change(this.context, (bucket) => { bucket.workspaces[scopeRecordKey(scope)] = cwd; });
  }
  override removeCwd(scope: string): boolean { return this.remove('workspaces', scope); }
  override listCwds(prefix?: string): Record<string, string> {
    return Object.fromEntries(Object.entries(this.state.read(this.context).workspaces)
      .map(([key, cwd]) => [JSON.parse(key) as string, cwd])
      .filter(([scope]) => !prefix || scope!.startsWith(prefix)));
  }
  override listNamed(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.state.read(this.context).named)
      .map(([key, cwd]) => [JSON.parse(key) as string, cwd]));
  }
  override getNamed(name: string): string | undefined { return this.state.read(this.context).named[scopeRecordKey(name)]; }
  override saveNamed(name: string, cwd: string): void {
    this.state.change(this.context, (bucket) => { bucket.named[scopeRecordKey(name)] = cwd; });
  }
  override removeNamed(name: string): boolean { return this.remove('named', name); }
  private remove(group: 'named' | 'workspaces', name: string): boolean {
    const key = scopeRecordKey(name);
    if (!Object.hasOwn(this.state.read(this.context)[group], key)) return false;
    this.state.change(this.context, (bucket: ConversationBucket) => { delete bucket[group][key]; });
    return true;
  }
}

const larkWriters = new WeakMap<SessionStore, { file: string; loaded: Promise<ConversationState> }>();

/** Reconnects share the writer, but take a fresh immutable account/instance view. */
export async function openLarkConversationViews(
  owner: SessionStore,
  files: { sessionsFile: string; workspacesFile: string },
  identity: BridgeIdentity,
): Promise<ReturnType<typeof conversationViews>> {
  const file = `${files.sessionsFile}.bridge-v2.json`;
  let cached = larkWriters.get(owner);
  if (cached && cached.file !== file) throw new Error('Conversation state path changed during reconnect');
  if (!cached) {
    const state = new ConversationState(file);
    const loaded = state.load(identity, {
      sessions: files.sessionsFile, catalog: `${files.sessionsFile}.catalog.json`, workspaces: files.workspacesFile,
    }).then(() => state);
    cached = { file, loaded };
    larkWriters.set(owner, cached);
    void loaded.catch(() => { if (larkWriters.get(owner) === cached) larkWriters.delete(owner); });
  }
  return conversationViews(await cached.loaded, identity);
}
