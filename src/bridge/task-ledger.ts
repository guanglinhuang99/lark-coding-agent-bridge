import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'interrupted';

export type TaskKind =
  | 'agent'
  | 'message'
  | 'command'
  | 'codex'
  | 'risk'
  | 'attachment';

export interface TaskRecord {
  id: string;
  operationKey: string;
  conversationKey: string;
  kind: TaskKind;
  status: TaskStatus;
  label: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  errorKind?: string;
  recoveryReason?: 'process-restart';
  recoveryFrom?: 'queued' | 'running';
  replayedAfterRestart?: boolean;
}

interface TaskDiskState {
  schemaVersion: 1;
  tasks: Record<string, TaskRecord>;
  operations: Record<string, string>;
}

export interface TaskLedgerOptions {
  write?: typeof writeFileAtomic;
  namespace?: string;
  canReplayRunning?: (task: Readonly<TaskRecord>) => boolean;
  maxAgeMs?: number;
  maxEntries?: number;
  now?: () => Date;
}

export interface TaskClaim {
  accepted: boolean;
  replayed: boolean;
  task: TaskRecord;
}

export interface TaskLedgerSnapshot {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  interrupted: number;
  recoveredAtStartup: number;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2_000;

export class TaskLedger {
  private tasks: Record<string, TaskRecord> = {};
  private operations: Record<string, string> = {};
  private saving: Promise<void> = Promise.resolve();
  private mutations: Promise<void> = Promise.resolve();
  private writeError: unknown;

  private transaction<T>(mutate: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(async () => {
      const before = structuredClone({ tasks: this.tasks, operations: this.operations });
      try { return await mutate(); }
      catch (err) {
        this.tasks = before.tasks;
        this.operations = before.operations;
        throw err;
      }
    });
    this.mutations = next.then(() => {}, () => {});
    return next;
  }

  async claimInbound(messageId: string, conversationKey: string): Promise<TaskClaim> {
    if (!messageId.trim() || !conversationKey.trim()) throw new Error('Missing task identity');
    return this.transaction(() => this.claimInboundUncommitted(messageId, conversationKey));
  }

  async annotate(taskId: string, patch: Partial<Pick<TaskRecord, 'kind' | 'label'>>): Promise<void> {
    return this.transaction(() => this.annotateUncommitted(taskId, patch));
  }

  async prune(): Promise<number> { return this.transaction(() => this.pruneUncommitted()); }

  private updateStatus(taskId: string, status: TaskStatus, errorKind?: string): Promise<void> {
    return this.transaction(() => this.updateStatusUncommitted(taskId, status, errorKind));
  }

  /** Dispatcher-only transition: it has confirmed that no command was executed. */
  async markQueued(taskId: string): Promise<void> {
    return this.transaction(async () => {
      const task = this.tasks[taskId];
      if (!task || task.status !== 'running' || task.kind !== 'message') {
        throw new Error('Only an unexecuted inbound message can return to the queue');
      }
      task.status = 'queued';
      task.updatedAt = this.now().toISOString();
      await this.persist();
    });
  }

  /** Atomic transition of every source receipt before a batch can cause effects. */
  async markBatchRunning(taskIds: readonly string[]): Promise<void> {
    return this.transaction(async () => {
      if (!taskIds.length || new Set(taskIds).size !== taskIds.length) throw new Error('Invalid task batch');
      for (const id of taskIds) {
        if (this.tasks[id]?.status !== 'queued') throw new Error('Task batch is not wholly queued');
      }
      for (const id of taskIds) {
        const task = this.tasks[id]!;
        task.status = 'running';
        task.updatedAt = this.now().toISOString();
        task.recoveryFrom = undefined;
        task.recoveryReason = undefined;
      }
      await this.persist();
    });
  }
  private recoveredAtStartup = 0;
  private readonly write: typeof writeFileAtomic;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private readonly namespace?: string;
  private readonly canReplayRunning: (task: Readonly<TaskRecord>) => boolean;

  constructor(
    private readonly file: string,
    options: TaskLedgerOptions = {},
  ) {
    this.write = options.write ?? writeFileAtomic;
    this.maxAgeMs = positiveInt(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
    this.maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? (() => new Date());
    this.namespace = options.namespace;
    this.canReplayRunning = options.canReplayRunning ?? (() => false);
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err: unknown) {
      throw new Error(
        `Invalid bridge task store ${this.file}: JSON is damaged; the original file was preserved`,
        { cause: err },
      );
    }

    const state = validateState(parsed, this.file);
    this.tasks = state.tasks;
    this.operations = state.operations;

    const now = this.now().toISOString();
    let changed = false;
    for (const task of Object.values(this.tasks)) {
      if (task.status !== 'queued' && task.status !== 'running') continue;
      const recoveryFrom = task.status;
      task.status = 'interrupted';
      task.recoveryReason = 'process-restart';
      task.recoveryFrom = recoveryFrom;
      task.updatedAt = now;
      this.recoveredAtStartup++;
      changed = true;
    }
    if (this.pruneInMemory() > 0) changed = true;
    if (changed) await this.persist();
  }

  private async claimInboundUncommitted(messageId: string, conversationKey: string): Promise<TaskClaim> {
    const operationKey = hashOperationKey(this.namespace
      ? JSON.stringify([this.namespace, conversationKey, messageId]) : messageId);
    const existingId = this.operations[operationKey];
    const existing = existingId ? this.tasks[existingId] : undefined;
    if (existing) {
      const safeToReplay = existing.recoveryFrom === 'queued' || this.canReplayRunning(existing);
      if (
        existing.status === 'interrupted' &&
        existing.recoveryReason === 'process-restart' &&
        !existing.replayedAfterRestart &&
        safeToReplay
      ) {
        existing.status = 'queued';
        existing.attempts += 1;
        existing.replayedAfterRestart = true;
        existing.errorKind = undefined;
        existing.updatedAt = this.now().toISOString();
        await this.persist();
        return { accepted: true, replayed: true, task: cloneTask(existing) };
      }
      return { accepted: false, replayed: false, task: cloneTask(existing) };
    }
    if (existingId) delete this.operations[operationKey];

    const timestamp = this.now().toISOString();
    const id = createTaskId(this.now().getTime());
    const task: TaskRecord = {
      id,
      operationKey,
      conversationKey,
      kind: 'message',
      status: 'queued',
      label: '消息处理',
      attempts: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.tasks[id] = task;
    this.operations[operationKey] = id;
    this.pruneInMemory();
    await this.persist();
    return { accepted: true, replayed: false, task: cloneTask(task) };
  }

  private async annotateUncommitted(
    taskId: string,
    patch: Partial<Pick<TaskRecord, 'kind' | 'label'>>,
  ): Promise<void> {
    const task = this.tasks[taskId];
    if (!task) return;
    if (patch.kind) task.kind = patch.kind;
    if (patch.label?.trim()) task.label = patch.label.trim().slice(0, 80);
    task.updatedAt = this.now().toISOString();
    await this.persist();
  }

  async markRunning(taskId: string): Promise<void> {
    await this.updateStatus(taskId, 'running');
  }

  async markDone(taskId: string): Promise<void> {
    await this.updateStatus(taskId, 'done');
  }

  async markFailed(taskId: string, errorKind?: string): Promise<void> {
    await this.updateStatus(taskId, 'failed', errorKind);
  }

  async markInterrupted(taskId: string): Promise<void> {
    await this.updateStatus(taskId, 'interrupted');
  }

  recent(conversationKey?: string, limit = 5): TaskRecord[] {
    return Object.values(this.tasks)
      .filter((task) => !conversationKey || task.conversationKey === conversationKey)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(0, limit))
      .map(cloneTask);
  }

  active(conversationKey: string): TaskRecord | undefined {
    return this.recent(conversationKey, this.maxEntries).find(
      (task) => task.status === 'running' || task.status === 'queued',
    );
  }

  snapshot(): TaskLedgerSnapshot {
    const records = Object.values(this.tasks);
    const count = (status: TaskStatus) => records.filter((task) => task.status === status).length;
    return {
      total: records.length,
      queued: count('queued'),
      running: count('running'),
      done: count('done'),
      failed: count('failed'),
      interrupted: count('interrupted'),
      recoveredAtStartup: this.recoveredAtStartup,
    };
  }

  private async pruneUncommitted(): Promise<number> {
    const removed = this.pruneInMemory();
    if (removed > 0) await this.persist();
    return removed;
  }

  async flush(): Promise<void> {
    await this.mutations;
    await this.saving;
    if (this.writeError !== undefined) throw this.writeError;
  }

  private async updateStatusUncommitted(
    taskId: string,
    status: TaskStatus,
    errorKind?: string,
  ): Promise<void> {
    const task = this.tasks[taskId];
    if (!task) return;
    const terminal = task.status === 'done' || task.status === 'failed' || task.status === 'interrupted';
    if (terminal) {
      if (status === 'running') throw new Error('Cannot start a terminal task');
      return;
    }
    task.status = status;
    task.updatedAt = this.now().toISOString();
    task.errorKind = errorKind;
    if (status !== 'interrupted') {
      task.recoveryReason = undefined;
      task.recoveryFrom = undefined;
    }
    await this.persist();
  }

  private persist(): Promise<void> {
    const state: TaskDiskState = {
      schemaVersion: 1,
      tasks: this.tasks,
      operations: this.operations,
    };
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const next = this.saving.then(() => this.write(this.file, payload, { mode: 0o600 }));
    this.saving = next.then(
      () => { this.writeError = undefined; },
      (err: unknown) => { this.writeError = err; },
    );
    return next;
  }

  private pruneInMemory(): number {
    const cutoff = this.now().getTime() - this.maxAgeMs;
    const ordered = Object.values(this.tasks).sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
    const keep = new Set(
      ordered
        .filter((task) => Date.parse(task.updatedAt) >= cutoff)
        .slice(0, this.maxEntries)
        .map((task) => task.id),
    );

    for (const task of ordered) {
      if (task.status === 'queued' || task.status === 'running') keep.add(task.id);
    }
    let removed = 0;
    for (const taskId of Object.keys(this.tasks)) {
      if (keep.has(taskId)) continue;
      delete this.tasks[taskId];
      removed++;
    }
    for (const [operationKey, taskId] of Object.entries(this.operations)) {
      if (this.tasks[taskId]) continue;
      delete this.operations[operationKey];
    }
    return removed;
  }
}

export function hashOperationKey(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex');
}

function createTaskId(nowMs: number): string {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  return `task_${nowMs}_${suffix}`;
}

function validateState(value: unknown, file: string): TaskDiskState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw damaged(file);
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1) throw damaged(file);
  if (!root.tasks || typeof root.tasks !== 'object' || Array.isArray(root.tasks)) throw damaged(file);
  if (!root.operations || typeof root.operations !== 'object' || Array.isArray(root.operations)) {
    throw damaged(file);
  }

  const tasks: Record<string, TaskRecord> = {};
  for (const [taskId, raw] of Object.entries(root.tasks as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw damaged(file, taskId);
    const item = raw as Record<string, unknown>;
    const kind = item.kind;
    const status = item.status;
    if (
      item.id !== taskId ||
      typeof item.operationKey !== 'string' ||
      typeof item.conversationKey !== 'string' ||
      !isTaskKind(kind) ||
      !isTaskStatus(status) ||
      typeof item.label !== 'string' ||
      !Number.isInteger(item.attempts) ||
      (item.attempts as number) <= 0 ||
      typeof item.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      typeof item.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.updatedAt)) ||
      (item.recoveryFrom !== undefined &&
        item.recoveryFrom !== 'queued' &&
        item.recoveryFrom !== 'running')
    ) {
      throw damaged(file, taskId);
    }
    tasks[taskId] = {
      id: taskId,
      operationKey: item.operationKey,
      conversationKey: item.conversationKey,
      kind,
      status,
      label: item.label,
      attempts: item.attempts as number,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(typeof item.errorKind === 'string' ? { errorKind: item.errorKind } : {}),
      ...(item.recoveryReason === 'process-restart'
        ? { recoveryReason: 'process-restart' as const }
        : {}),
      ...(item.recoveryFrom === 'queued' || item.recoveryFrom === 'running'
        ? { recoveryFrom: item.recoveryFrom }
        : {}),
      ...(typeof item.replayedAfterRestart === 'boolean'
        ? { replayedAfterRestart: item.replayedAfterRestart }
        : {}),
    };
  }

  const operations: Record<string, string> = {};
  for (const [operationKey, taskId] of Object.entries(root.operations as Record<string, unknown>)) {
    if (typeof taskId !== 'string') throw damaged(file, operationKey);
    if (!tasks[taskId] || tasks[taskId]!.operationKey !== operationKey) throw damaged(file);
    operations[operationKey] = taskId;
  }
  for (const task of Object.values(tasks)) {
    if (operations[task.operationKey] !== task.id) throw damaged(file);
  }
  return { schemaVersion: 1, tasks, operations };
}

function damaged(file: string, key?: string): Error {
  return new Error(
    `Invalid bridge task store ${file}${key ? `: damaged entry ${JSON.stringify(key)}` : ''}; the original file was preserved`,
  );
}

function cloneTask(task: TaskRecord): TaskRecord {
  return { ...task };
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'failed' || value === 'interrupted';
}

function isTaskKind(value: unknown): value is TaskKind {
  return value === 'agent' || value === 'message' || value === 'command' || value === 'codex' || value === 'risk' || value === 'attachment';
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.floor(value as number);
}
