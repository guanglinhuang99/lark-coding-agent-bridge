import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export interface WeComSessionRecord {
  threadId: string;
  updatedAt: string;
}

type WeComSessionMap = Record<string, WeComSessionRecord>;

export interface WeComSessionStoreOptions {
  maxAgeMs?: number;
  maxEntries?: number;
  now?: () => Date;
}

export class WeComSessionStore {
  private data: WeComSessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(
    private readonly file: string,
    options: WeComSessionStoreOptions = {},
  ) {
    this.maxAgeMs = positiveInt(options.maxAgeMs, 90 * 24 * 60 * 60 * 1000);
    this.maxEntries = positiveInt(options.maxEntries, 2_000);
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        this.data = {};
        return;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err: unknown) {
      throw new Error(
        `Invalid WeCom sessions file ${this.file}: JSON is damaged; the original file was preserved`,
        { cause: err },
      );
    }
    this.data = validateSessions(parsed, this.file);
    if (this.pruneInMemory() > 0) await this.persist();
  }

  threadId(key: string): string | undefined {
    return this.data[key]?.threadId;
  }

  async setThread(key: string, threadId: string): Promise<void> {
    this.data[key] = { threadId, updatedAt: this.now().toISOString() };
    if (Object.keys(this.data).length > this.maxEntries) this.pruneInMemory();
    await this.persist();
  }

  async clear(key: string): Promise<void> {
    if (!(key in this.data)) return;
    delete this.data[key];
    await this.persist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  async prune(): Promise<number> {
    const removed = this.pruneInMemory();
    if (removed > 0) await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    const next = this.saving.then(() => writeFileAtomic(this.file, payload, { mode: 0o600 }));
    // Keep later writes usable after a caller has observed a failed write.
    this.saving = next.catch(() => {});
    return next;
  }

  private pruneInMemory(): number {
    const cutoff = this.now().getTime() - this.maxAgeMs;
    let removed = 0;
    for (const [key, record] of Object.entries(this.data)) {
      if (Date.parse(record.updatedAt) >= cutoff) continue;
      delete this.data[key];
      removed++;
    }

    const newestFirst = Object.entries(this.data).sort(
      ([, left], [, right]) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
    for (const [key] of newestFirst.slice(this.maxEntries)) {
      delete this.data[key];
      removed++;
    }
    return removed;
  }
}

function validateSessions(value: unknown, file: string): WeComSessionMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Invalid WeCom sessions file ${file}: expected an object; the original file was preserved`,
    );
  }

  const sessions: WeComSessionMap = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw damagedEntry(file, key);
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.threadId !== 'string' ||
      !record.threadId.trim() ||
      typeof record.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(record.updatedAt))
    ) {
      throw damagedEntry(file, key);
    }
    sessions[key] = { threadId: record.threadId, updatedAt: record.updatedAt };
  }
  return sessions;
}

function damagedEntry(file: string, key: string): Error {
  return new Error(
    `Invalid WeCom sessions file ${file}: damaged entry ${JSON.stringify(key)}; the original file was preserved`,
  );
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.floor(value as number);
}
