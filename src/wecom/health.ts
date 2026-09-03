import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export type WeComHealthPhase =
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error'
  | 'stopping';

export interface WeComHealthSnapshot {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  phase: WeComHealthPhase;
  connected: boolean;
  activeRuns: number;
  startingRuns: number;
  reconnectAttempt?: number;
  lastError?: string;
  riskFastPath?: {
    enabled: boolean;
    serviceDirConfigured: boolean;
    pythonConfigured: boolean;
    reason?: string;
  };
}

export interface WeComHealthInspection {
  healthy: boolean;
  reason: 'ok' | 'missing' | 'invalid' | 'stale' | 'not-connected' | 'process-dead';
  ageMs?: number;
  snapshot?: WeComHealthSnapshot;
}

export class WeComHealthStore {
  private readonly startedAt: string;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly pid: number = process.pid,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.startedAt = this.now().toISOString();
  }

  update(
    state: Omit<WeComHealthSnapshot, 'schemaVersion' | 'pid' | 'startedAt' | 'updatedAt'>,
  ): Promise<void> {
    const snapshot: WeComHealthSnapshot = {
      schemaVersion: 1,
      pid: this.pid,
      startedAt: this.startedAt,
      updatedAt: this.now().toISOString(),
      ...state,
    };
    const next = this.saving.then(() =>
      writeFileAtomic(this.file, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 }),
    );
    this.saving = next.catch(() => {});
    return next;
  }

  flush(): Promise<void> {
    return this.saving;
  }
}

export async function inspectWeComHealth(
  file: string,
  options: {
    staleAfterMs: number;
    now?: () => Date;
    isProcessAlive?: (pid: number) => boolean;
  },
): Promise<WeComHealthInspection> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { healthy: false, reason: 'missing' };
    }
    return { healthy: false, reason: 'invalid' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { healthy: false, reason: 'invalid' };
  }
  if (!isHealthSnapshot(parsed)) return { healthy: false, reason: 'invalid' };

  const now = options.now?.() ?? new Date();
  const ageMs = now.getTime() - Date.parse(parsed.updatedAt);
  if (!Number.isFinite(ageMs) || ageMs > options.staleAfterMs) {
    return { healthy: false, reason: 'stale', ageMs, snapshot: parsed };
  }
  const isAlive = options.isProcessAlive ?? processIsAlive;
  if (!isAlive(parsed.pid)) {
    return { healthy: false, reason: 'process-dead', ageMs, snapshot: parsed };
  }
  if (!parsed.connected || parsed.phase !== 'connected') {
    return { healthy: false, reason: 'not-connected', ageMs, snapshot: parsed };
  }
  return { healthy: true, reason: 'ok', ageMs, snapshot: parsed };
}

function isHealthSnapshot(value: unknown): value is WeComHealthSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.schemaVersion === 1 &&
    typeof item.pid === 'number' &&
    Number.isInteger(item.pid) &&
    item.pid > 0 &&
    typeof item.startedAt === 'string' &&
    Number.isFinite(Date.parse(item.startedAt)) &&
    typeof item.updatedAt === 'string' &&
    Number.isFinite(Date.parse(item.updatedAt)) &&
    isHealthPhase(item.phase) &&
    typeof item.connected === 'boolean' &&
    typeof item.activeRuns === 'number' &&
    Number.isInteger(item.activeRuns) &&
    item.activeRuns >= 0 &&
    typeof item.startingRuns === 'number' &&
    Number.isInteger(item.startingRuns) &&
    item.startingRuns >= 0
  );
}

function isHealthPhase(value: unknown): value is WeComHealthPhase {
  return (
    value === 'starting' ||
    value === 'connected' ||
    value === 'reconnecting' ||
    value === 'disconnected' ||
    value === 'error' ||
    value === 'stopping'
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
