import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../agent/types';
import { ActiveRuns, type RunHandle } from './active-runs';
import { ProcessPool, type RunPermit } from './process-pool';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';
import type { TaskLedger } from './task-ledger';

/** A channel's policy decision, not a platform SDK message. */
export interface ExecutionPolicy {
  prompt: string;
  cwdRealpath: string;
  expiresAt: number;
  accessMode?: string;
  sandbox?: AgentRunOptions['sandbox'];
  permissionMode?: AgentRunOptions['permissionMode'];
}
export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  taskLedger?: TaskLedger;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
}
export interface SubmitRunInput {
  scopeId: string;
  policy: ExecutionPolicy;
  runId?: string;
  operationId?: string;
  /** Live admission from THIS executor's pool; not an unchecked bypass flag. */
  permit?: RunPermit;
  sessionId?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  observability?: { profile: string; agent: string; source: string; stage: string };
}
export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly ledger?: TaskLedger;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.ledger = deps.taskLedger;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? 2000;
  }
  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    this.assertAllowed(input);
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) throw new RunRejected('run-already-active', 'another run is already active for this scope');
    let runId = input.runId;
    let release: (() => void) | undefined;
    let taskId: string | undefined;
    let run: AgentRun;
    let handle: RunHandle;
    const record = async (state: 'done' | 'failed' | 'interrupted') => {
      if (!taskId || !this.ledger) return;
      try {
        if (state === 'done') await this.ledger.markDone(taskId);
        else if (state === 'interrupted') await this.ledger.markInterrupted(taskId);
        else await this.ledger.markFailed(taskId, 'execution');
      } catch (err) { log.fail('task-ledger', err, { step: 'terminal', taskId }); }
    };
    try {
      if (this.ledger) {
        // Durable queued work needs its identity before admission. Without a
        // ledger, preserve the legacy contract: rejected nowait calls use no ID.
        runId ??= this.createRunId();
        const claim = await this.ledger.claimInbound(input.operationId ?? runId, input.scopeId);
        if (!claim.accepted) throw new RunRejected('duplicate-operation', 'operation was already accepted');
        taskId = claim.task.id;
        await this.ledger.annotate(taskId, { kind: 'agent', label: 'Agent execution' });
      }
      release = input.permit ? this.pool.borrow(input.permit)
        : input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
      if (!release) throw new RunRejected('pool-full', 'process pool is full');
      this.assertAllowed(input);
      runId ??= this.createRunId();
      if (taskId) await this.ledger!.markRunning(taskId);
      const options: AgentRunOptions = {
        runId, prompt: input.policy.prompt, cwd: input.policy.cwdRealpath,
        sessionId: input.sessionId, threadId: input.threadId, model: input.model,
        reasoningEffort: input.reasoningEffort, images: input.images,
        sandbox: input.policy.sandbox, permissionMode: input.policy.permissionMode,
        stopGraceMs: input.stopGraceMs,
      };
      try { await this.agent.prepareRun?.(options); }
      catch (err) {
        if (err instanceof SpawnFailed) throw err;
        throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
      }
      this.assertAllowed(input);
      try { run = this.agent.run(options); }
      catch (err) { throw new SpawnFailed('agent spawn failed', err); }
      try { handle = this.activeRuns.register(input.scopeId, run); }
      catch (err) {
        await run.stop().catch(() => {});
        throw new RunRejected('run-already-active', err instanceof Error ? err.message : 'scope already active');
      }
    } catch (err) {
      release?.(); releaseScope(); await record('failed'); throw err;
    }
    const startedAt = this.now();
    const dimensions = {
      runId, profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id, scope: input.scopeId,
      source: input.observability?.source ?? 'unknown', stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions, queueWaitMs: startedAt - submittedAt, accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox, permissionMode: input.policy.permissionMode,
    });
    let terminal: Extract<AgentEvent, { type: 'done' | 'error' }> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (waitForExit: boolean): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        try {
          if (waitForExit) {
            if (terminal?.type === 'done' && terminal.terminationReason === 'normal') {
              await run.finish?.();
            }
            const exited = await run.waitForExit(this.postDoneExitGraceMs);
            if (!exited) {
              log.warn('run', 'post-done-exit-timeout', { ...dimensions, graceMs: this.postDoneExitGraceMs });
              await run.stop();
            }
          }
        } finally {
          this.activeRuns.unregister(input.scopeId, run);
          releaseScope(); release?.();
          await record(handle.interrupted || terminal?.terminationReason === 'interrupted'
            ? 'interrupted' : terminal?.type === 'done' && terminal.terminationReason === 'normal' ? 'done' : 'failed');
        }
      })();
      return cleanupPromise;
    };
    const clock = this.now;
    const source: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator]() {
        for await (const event of run.events) {
          if (event.type === 'done' || event.type === 'error') {
            terminal = event;
            const fields = { ...dimensions, result: event.terminationReason, durationMs: clock() - startedAt };
            if (event.type === 'done') log.info('run', 'completed', fields);
            else log.warn('run', 'failed', { ...fields, error: event.message });
            yield event; return;
          }
          yield event;
        }
      },
    };
    const fanout = new EventFanout(source, () => cleanup(!handle.interrupted));
    let stopPromise: Promise<void> | undefined;
    return {
      runId, scopeId: input.scopeId, run, handle,
      subscribe: () => fanout.subscribe(),
      stop: () => {
        if (stopPromise) return stopPromise;
        handle.interrupted = true;
        stopPromise = (async () => {
          await record('interrupted');
          try { await run.stop(); await run.waitForExit(this.postDoneExitGraceMs); }
          finally { await cleanup(false); }
        })();
        return stopPromise;
      },
    };
  }
  private assertAllowed(input: SubmitRunInput): void {
    if (Number.isNaN(input.policy.expiresAt) || input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected('reconnect-in-progress', this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused');
    }
  }
}

class EventFanout {
  private readonly buffer: Array<AgentEvent | undefined> = [];
  private bufferOffset = 0;
  private bufferStart = 0;
  private readonly subscribers = new Map<number, number>();
  private nextSubscriberId = 1;
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private hasError = false;
  private error: unknown;
  constructor(private readonly source: AsyncIterable<AgentEvent>, private readonly onDone: () => Promise<void>) {}
  subscribe(): AsyncIterable<AgentEvent> {
    return { [Symbol.asyncIterator]: () => {
      const subscriberId = this.nextSubscriberId++;
      let closed = false;
      // A subscriber joins at the current live edge. Concurrent subscribers
      // created before the next source event still receive the same full stream,
      // while late subscribers no longer force the fanout to retain run history.
      this.subscribers.set(subscriberId, this.liveEnd());
      this.start();
      const close = () => {
        if (closed) return;
        closed = true;
        this.subscribers.delete(subscriberId);
        this.reclaim();
      };
      return {
        next: async (): Promise<IteratorResult<AgentEvent>> => {
          for (;;) {
            if (closed) return { done: true, value: undefined };
            const cursor = this.subscribers.get(subscriberId);
            if (cursor === undefined) return { done: true, value: undefined };
            const offset = this.bufferOffset + cursor - this.bufferStart;
            if (offset >= this.bufferOffset && offset < this.buffer.length) {
              const value = this.buffer[offset];
              if (value === undefined) throw new Error('EventFanout cursor reached reclaimed data');
              this.subscribers.set(subscriberId, cursor + 1);
              this.reclaim();
              return { done: false, value };
            }
            if (this.hasError) {
              close();
              throw this.error;
            }
            if (this.done) {
              close();
              return { done: true, value: undefined };
            }
            await new Promise<void>((resolve) => this.waiters.add(resolve));
          }
        },
        return: async (): Promise<IteratorResult<AgentEvent>> => {
          close();
          return { done: true, value: undefined };
        },
        throw: async (error?: unknown): Promise<IteratorResult<AgentEvent>> => {
          close();
          throw error;
        },
      };
    } };
  }
  private start(): void { if (!this.started) { this.started = true; void this.pump(); } }
  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.reclaim();
        this.wakeAll();
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err) { this.hasError = true; this.error = err; }
    finally {
      try { await this.onDone(); }
      catch (err) { this.hasError = true; this.error = err; }
      finally { this.done = true; this.wakeAll(); }
    }
  }
  private liveEnd(): number {
    return this.bufferStart + (this.buffer.length - this.bufferOffset);
  }
  private reclaim(): void {
    const nextIndex = this.liveEnd();
    const oldestNeeded = this.subscribers.size > 0
      ? Math.min(...this.subscribers.values())
      : nextIndex;
    const removeCount = oldestNeeded - this.bufferStart;
    if (removeCount <= 0) return;
    const nextOffset = this.bufferOffset + removeCount;
    for (let index = this.bufferOffset; index < nextOffset; index++) this.buffer[index] = undefined;
    this.bufferOffset = nextOffset;
    this.bufferStart = oldestNeeded;
    if (this.bufferOffset === this.buffer.length) {
      this.buffer.length = 0;
      this.bufferOffset = 0;
      return;
    }
    // Compact only in batches so a slow consumer catching up does not turn
    // front-removal into repeated O(n) array moves.
    if (this.bufferOffset >= 1024 && this.bufferOffset * 2 >= this.buffer.length) {
      this.buffer.splice(0, this.bufferOffset);
      this.bufferOffset = 0;
    }
  }
  private wakeAll(): void {
    const waiters = [...this.waiters]; this.waiters.clear();
    for (const wake of waiters) wake();
  }
}
