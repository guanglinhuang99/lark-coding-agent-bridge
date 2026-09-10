export type ConversationQueueReason =
  | 'queue-full'
  | 'global-queue-full'
  | 'queue-timeout'
  | 'shutting-down';

export class ConversationQueueError extends Error {
  override readonly name = 'ConversationQueueError';

  constructor(readonly reason: ConversationQueueReason) {
    super(`WeCom conversation queue rejected work: ${reason}`);
  }
}

interface ConversationQueueEntry {
  task: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  timer?: NodeJS.Timeout;
  started: boolean;
}

interface ConversationLane {
  active: ConversationQueueEntry;
  queued: ConversationQueueEntry[];
}

export interface ConversationSubmission {
  queued: boolean;
  position: number;
  completion: Promise<void>;
  cancel(reason?: unknown): boolean;
}

export interface ConversationQueueOptions {
  /** Maximum queued follow-ups across all conversations. Active items are not counted. */
  maxQueuedTotal?: number;
}

/** Serialize work per conversation while allowing different conversations to run independently. */
export class ConversationQueue {
  private readonly lanes = new Map<string, ConversationLane>();
  private closed = false;
  private queuedTotal = 0;
  private readonly maxQueuedTotal: number;

  constructor(
    private readonly maxQueuedPerConversation: number,
    private readonly queueTimeoutMs: number,
    options: ConversationQueueOptions = {},
  ) {
    this.maxQueuedTotal = options.maxQueuedTotal ?? Number.POSITIVE_INFINITY;
    if (!(this.maxQueuedTotal >= 0)) {
      throw new RangeError('Conversation global queue limit must be non-negative');
    }
  }

  submit(key: string, task: () => Promise<void>): ConversationSubmission {
    if (this.closed) throw new ConversationQueueError('shutting-down');

    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: ConversationQueueEntry = { task, resolve, reject, started: false };
    const lane = this.lanes.get(key);

    if (!lane) {
      this.lanes.set(key, { active: entry, queued: [] });
      this.start(key, entry);
      return this.submission(key, entry, false, 0, completion);
    }
    if (lane.queued.length >= this.maxQueuedPerConversation) {
      throw new ConversationQueueError('queue-full');
    }
    if (this.queuedTotal >= this.maxQueuedTotal) {
      throw new ConversationQueueError('global-queue-full');
    }

    lane.queued.push(entry);
    this.queuedTotal++;
    const position = lane.queued.length;
    entry.timer = setTimeout(() => {
      if (!this.removeQueued(key, entry)) return;
      entry.reject(new ConversationQueueError('queue-timeout'));
    }, this.queueTimeoutMs);
    entry.timer.unref();
    return this.submission(key, entry, true, position, completion);
  }

  queued(key: string): number {
    return this.lanes.get(key)?.queued.length ?? 0;
  }

  has(key: string): boolean {
    return this.lanes.has(key);
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.lanes.size, queued: this.queuedTotal };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lane of this.lanes.values()) {
      for (const entry of lane.queued.splice(0)) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new ConversationQueueError('shutting-down'));
      }
    }
    this.queuedTotal = 0;
  }

  private submission(
    key: string,
    entry: ConversationQueueEntry,
    queued: boolean,
    position: number,
    completion: Promise<void>,
  ): ConversationSubmission {
    return {
      queued,
      position,
      completion,
      cancel: (reason = new Error('WeCom conversation work cancelled')) => {
        if (!this.removeQueued(key, entry)) return false;
        entry.reject(reason);
        return true;
      },
    };
  }

  private removeQueued(key: string, entry: ConversationQueueEntry): boolean {
    if (entry.started) return false;
    const lane = this.lanes.get(key);
    if (!lane) return false;
    const index = lane.queued.indexOf(entry);
    if (index < 0) return false;
    lane.queued.splice(index, 1);
    this.queuedTotal--;
    if (entry.timer) clearTimeout(entry.timer);
    return true;
  }

  private start(key: string, entry: ConversationQueueEntry): void {
    entry.started = true;
    if (entry.timer) clearTimeout(entry.timer);
    void Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => this.advance(key, entry));
  }

  private advance(key: string, completed: ConversationQueueEntry): void {
    const lane = this.lanes.get(key);
    if (!lane || lane.active !== completed) return;
    const next = lane.queued.shift();
    if (!next) {
      this.lanes.delete(key);
      return;
    }
    this.queuedTotal--;
    lane.active = next;
    this.start(key, next);
  }
}

