import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import type { SessionEntry } from './session-store';
import type { SessionCatalogEntry } from './session-catalog';
import { bridgeIdentityKey, sessionBindingKey, type BridgeIdentity } from './identity';

export interface ConversationBucket {
  identity: BridgeIdentity;
  preferences: Record<string, SessionEntry>;
  workspaces: Record<string, string>;
  named: Record<string, string>;
  sessions: Record<string, SessionCatalogEntry>;
  /** Old WeCom records have no cwd/policy evidence; never consult these for automatic resume. */
  unverifiedThreads: Record<string, { threadId: string; updatedAt: string }>;
}
interface ConversationDiskState {
  schemaVersion: 2;
  contexts: Record<string, ConversationBucket>;
  migration: { owner: string; sources: Array<{ name: string; sha256: string }> };
}
export interface LegacyConversationFiles {
  sessions?: string;
  catalog?: string;
  workspaces?: string;
  wecomThreads?: string;
}
export interface ConversationStateOptions {
  write?: typeof writeFileAtomic;
}

/**
 * One writer per state file, with independent account/instance views. Platform codecs
 * are used only at the one-time import boundary. Original files are never modified.
 * A runtime must hold its deployment lock before opening this store.
 */
export class ConversationState {
  private data: ConversationDiskState | undefined;
  private saving: Promise<void> = Promise.resolve();
  private writeError: unknown;
  private readonly write: typeof writeFileAtomic;

  constructor(readonly file: string, options: ConversationStateOptions = {}) {
    this.write = options.write ?? writeFileAtomic;
  }

  async load(identity: BridgeIdentity, legacy: LegacyConversationFiles = {}): Promise<void> {
    if (this.data) return;
    const owner = bridgeIdentityKey(identity);
    const existing = await optionalRead(this.file);
    if (existing !== undefined) {
      this.data = validateState(JSON.parse(existing) as unknown);
      return;
    }

    const bucket = emptyBucket(identity);
    const sources: Array<{ name: string; file: string; text: string; sha256: string }> = [];
    for (const [name, file] of Object.entries(legacy)) {
      if (!file) continue;
      const text = await optionalRead(file);
      if (text === undefined) continue;
      const parsed = JSON.parse(text) as unknown;
      importLegacy(bucket, name, parsed);
      sources.push({ name, file, text, sha256: digest(text) });
    }
    const next: ConversationDiskState = {
      schemaVersion: 2,
      contexts: { [owner]: bucket },
      migration: { owner, sources: sources.map(({ name, sha256 }) => ({ name, sha256 })) },
    };
    validateState(next);
    // Validate every input before writing anything. Content-addressed backups make a
    // crash between backup and final commit safe to retry without overwriting a backup.
    for (const source of sources) {
      const backup = `${source.file}.pre-shared-${source.sha256.slice(0, 16)}.json`;
      const previous = await optionalRead(backup);
      if (previous !== undefined && previous !== source.text) {
        throw new Error('Conversation migration backup mismatch; original files preserved');
      }
      if (previous === undefined) await this.write(backup, source.text, { mode: 0o600 });
    }
    await this.write(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.data = next;
  }

  read(identity: BridgeIdentity): ConversationBucket {
    const data = this.requireLoaded();
    return structuredClone(data.contexts[bridgeIdentityKey(identity)] ?? emptyBucket(identity));
  }

  change(identity: BridgeIdentity, update: (bucket: ConversationBucket) => void): void {
    const next = structuredClone(this.requireLoaded());
    const key = bridgeIdentityKey(identity);
    const bucket = next.contexts[key] ?? emptyBucket(identity);
    update(bucket);
    next.contexts[key] = bucket;
    validateState(next);
    this.data = next;
    const payload = `${JSON.stringify(next, null, 2)}\n`;
    // Snapshot at mutation time, not at write time. Keep failures observable through
    // flush(), while allowing a later complete snapshot to repair a transient error.
    this.saving = this.saving.then(async () => {
      try {
        await this.write(this.file, payload, { mode: 0o600 });
        this.writeError = undefined;
      } catch (err) {
        this.writeError = err;
      }
    });
  }

  async flush(): Promise<void> {
    await this.saving;
    if (this.writeError !== undefined) throw this.writeError;
  }

  private requireLoaded(): ConversationDiskState {
    if (!this.data) throw new Error('Conversation state has not been loaded');
    return this.data;
  }
}

export function scopeRecordKey(scopeId: string): string {
  if (!scopeId.trim()) throw new Error('Empty conversation scope');
  return JSON.stringify(scopeId);
}

function emptyBucket(identity: BridgeIdentity): ConversationBucket {
  return { identity: { ...identity }, preferences: {}, workspaces: {}, named: {}, sessions: {}, unverifiedThreads: {} };
}

function importLegacy(bucket: ConversationBucket, name: string, value: unknown): void {
  if (name === 'catalog') {
    if (!Array.isArray(value)) throw damaged();
    for (const raw of value) {
      const entry = validateSession(raw);
      const oldKey = [entry.scopeId, entry.agentId, entry.cwdRealpath, entry.policyFingerprint].join('\x1f');
      if (entry.key !== oldKey && entry.key !== sessionBindingKey(bucket.identity, entry)) throw damaged();
      const key = sessionBindingKey(bucket.identity, entry);
      if (Object.hasOwn(bucket.sessions, key)) throw damaged();
      bucket.sessions[key] = { ...entry, key };
    }
    return;
  }
  const root = object(value);
  if (name === 'sessions') {
    for (const [scope, raw] of Object.entries(root)) {
      const entry = validatePreference(raw);
      bucket.preferences[scopeRecordKey(scope)] = entry;
    }
  } else if (name === 'workspaces') {
    for (const [scope, raw] of Object.entries(object(root.chats ?? {}))) {
      const cwd = object(raw).cwd;
      if (!nonempty(cwd)) throw damaged();
      bucket.workspaces[scopeRecordKey(scope)] = cwd;
    }
    for (const [label, cwd] of Object.entries(object(root.named ?? {}))) {
      if (!nonempty(label) || !nonempty(cwd)) throw damaged();
      bucket.named[scopeRecordKey(label)] = cwd;
    }
  } else if (name === 'wecomThreads') {
    for (const [scope, raw] of Object.entries(root)) {
      const entry = object(raw);
      if (!nonempty(entry.threadId) || !validDate(entry.updatedAt)) throw damaged();
      bucket.unverifiedThreads[scopeRecordKey(scope)] = {
        threadId: entry.threadId, updatedAt: entry.updatedAt as string,
      };
    }
  } else {
    throw new Error('Unknown legacy conversation codec');
  }
}

function validateState(value: unknown): ConversationDiskState {
  const root = object(value);
  if (root.schemaVersion !== 2) throw damaged();
  const migration = object(root.migration);
  if (!nonempty(migration.owner) || !Array.isArray(migration.sources)) throw damaged();
  for (const source of migration.sources) {
    const item = object(source);
    if (!nonempty(item.name) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw damaged();
  }
  const contexts = object(root.contexts);
  for (const [contextKey, raw] of Object.entries(contexts)) {
    const bucket = object(raw);
    const identity = object(bucket.identity) as unknown as BridgeIdentity;
    if (bridgeIdentityKey(identity) !== contextKey) throw damaged();
    for (const [key, entry] of Object.entries(object(bucket.preferences))) {
      validateScopeKey(key);
      validatePreference(entry);
    }
    for (const group of ['workspaces', 'named']) {
      for (const [key, cwd] of Object.entries(object(bucket[group]))) {
        validateScopeKey(key);
        if (!nonempty(cwd)) throw damaged();
      }
    }
    for (const [key, rawSession] of Object.entries(object(bucket.sessions))) {
      const session = validateSession(rawSession);
      if (session.key !== key || sessionBindingKey(identity, session) !== key) throw damaged();
    }
    for (const [key, rawThread] of Object.entries(object(bucket.unverifiedThreads))) {
      validateScopeKey(key);
      const thread = object(rawThread);
      if (!nonempty(thread.threadId) || !validDate(thread.updatedAt)) throw damaged();
    }
  }
  return structuredClone(value) as ConversationDiskState;
}

function validatePreference(value: unknown): SessionEntry {
  const entry = object(value);
  if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt) ||
      (entry.sessionId !== undefined && !nonempty(entry.sessionId)) ||
      (entry.cwd !== undefined && !nonempty(entry.cwd)) ||
      (entry.idleTimeoutMinutes !== undefined &&
       (typeof entry.idleTimeoutMinutes !== 'number' || !Number.isInteger(entry.idleTimeoutMinutes) ||
        entry.idleTimeoutMinutes < 0 || entry.idleTimeoutMinutes > 120))) throw damaged();
  return {
    updatedAt: entry.updatedAt,
    ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
    ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    ...(typeof entry.idleTimeoutMinutes === 'number' ? { idleTimeoutMinutes: entry.idleTimeoutMinutes } : {}),
  };
}

function validateSession(value: unknown): SessionCatalogEntry {
  const entry = object(value);
  if (!nonempty(entry.key) || !nonempty(entry.scopeId) ||
      !['claude', 'codex'].includes(String(entry.agentId)) || !nonempty(entry.cwdRealpath) ||
      !nonempty(entry.policyFingerprint) || !['active', 'archived'].includes(String(entry.status)) ||
      typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt) ||
      (entry.lastSummary !== undefined && typeof entry.lastSummary !== 'string')) throw damaged();
  if (entry.agentId === 'codex' ? !nonempty(entry.threadId) || entry.sessionId !== undefined
      : !nonempty(entry.sessionId) || entry.threadId !== undefined) throw damaged();
  return structuredClone(entry) as unknown as SessionCatalogEntry;
}

function validateScopeKey(key: string): void {
  const scope = JSON.parse(key) as unknown;
  if (!nonempty(scope) || scopeRecordKey(scope) !== key) throw damaged();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw damaged();
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function damaged(): Error {
  return new Error('Invalid conversation state; original files preserved');
}
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
async function optionalRead(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err; }
}
