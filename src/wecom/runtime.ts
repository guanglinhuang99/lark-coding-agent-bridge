import type { TemplateCard, WsFrameHeaders } from '@wecom/aibot-node-sdk';
import type { CodexSandboxMode } from '../config/permissions';

export interface ConversationBody {
  chattype?: 'single' | 'group';
  chatid?: string;
  from?: { userid?: string };
}

export type WeComCardAction = 'stop' | 'new' | 'status' | 'unknown';

export interface WeComTemplateCardEventDetails {
  eventKey?: string;
  taskId?: string;
  selectedId?: string;
}

export interface WeComStreamClient {
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
  replyStreamWithCard?(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
    options?: { templateCard?: TemplateCard },
  ): Promise<unknown>;
}

export interface WeComControlCardClient {
  sendMessage(
    target: string,
    body: { msgtype: 'template_card'; template_card: TemplateCard },
  ): Promise<unknown>;
}

export type WeComRunCapacityReason = 'queue-full' | 'queue-timeout' | 'shutting-down';

export type WeComConversationQueueReason = 'queue-full' | 'queue-timeout' | 'shutting-down';

export class WeComConversationQueueError extends Error {
  override readonly name = 'WeComConversationQueueError';

  constructor(readonly reason: WeComConversationQueueReason) {
    super(`WeCom conversation queue rejected work: ${reason}`);
  }
}

interface WeComConversationQueueEntry {
  task: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  timer?: NodeJS.Timeout;
  started: boolean;
}

interface WeComConversationLane {
  active: WeComConversationQueueEntry;
  queued: WeComConversationQueueEntry[];
}

export interface WeComConversationSubmission {
  queued: boolean;
  position: number;
  completion: Promise<void>;
  cancel(reason?: unknown): boolean;
}

/** Serialize work per conversation while allowing different conversations to run independently. */
export class WeComConversationQueue {
  private readonly lanes = new Map<string, WeComConversationLane>();
  private closed = false;

  constructor(
    private readonly maxQueuedPerConversation: number,
    private readonly queueTimeoutMs: number,
  ) {}

  submit(key: string, task: () => Promise<void>): WeComConversationSubmission {
    if (this.closed) throw new WeComConversationQueueError('shutting-down');

    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: WeComConversationQueueEntry = { task, resolve, reject, started: false };
    const lane = this.lanes.get(key);

    if (!lane) {
      this.lanes.set(key, { active: entry, queued: [] });
      this.start(key, entry);
      return this.submission(key, entry, false, 0, completion);
    }
    if (lane.queued.length >= this.maxQueuedPerConversation) {
      throw new WeComConversationQueueError('queue-full');
    }

    lane.queued.push(entry);
    const position = lane.queued.length;
    entry.timer = setTimeout(() => {
      if (!this.removeQueued(key, entry)) return;
      entry.reject(new WeComConversationQueueError('queue-timeout'));
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
    let queued = 0;
    for (const lane of this.lanes.values()) queued += lane.queued.length;
    return { active: this.lanes.size, queued };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lane of this.lanes.values()) {
      for (const entry of lane.queued.splice(0)) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new WeComConversationQueueError('shutting-down'));
      }
    }
  }

  private submission(
    key: string,
    entry: WeComConversationQueueEntry,
    queued: boolean,
    position: number,
    completion: Promise<void>,
  ): WeComConversationSubmission {
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

  private removeQueued(key: string, entry: WeComConversationQueueEntry): boolean {
    if (entry.started) return false;
    const lane = this.lanes.get(key);
    if (!lane) return false;
    const index = lane.queued.indexOf(entry);
    if (index < 0) return false;
    lane.queued.splice(index, 1);
    if (entry.timer) clearTimeout(entry.timer);
    return true;
  }

  private start(key: string, entry: WeComConversationQueueEntry): void {
    entry.started = true;
    if (entry.timer) clearTimeout(entry.timer);
    void Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => this.advance(key, entry));
  }

  private advance(key: string, completed: WeComConversationQueueEntry): void {
    const lane = this.lanes.get(key);
    if (!lane || lane.active !== completed) return;
    const next = lane.queued.shift();
    if (!next) {
      this.lanes.delete(key);
      return;
    }
    lane.active = next;
    this.start(key, next);
  }
}

export class WeComRunCapacityError extends Error {
  override readonly name = 'WeComRunCapacityError';

  constructor(readonly reason: WeComRunCapacityReason) {
    super(capacityMessage(reason));
  }
}

interface WeComRunWaiter {
  resolve: () => void;
  reject: (err: WeComRunCapacityError) => void;
  timer: NodeJS.Timeout;
}

/** Bound process-wide work while preserving FIFO admission for a short queue. */
export class WeComRunGate {
  private active = 0;
  private closed = false;
  private readonly queue: WeComRunWaiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
    private readonly queueTimeoutMs: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new WeComRunCapacityError('shutting-down'));
    }
  }

  private acquire(): Promise<void> {
    if (this.closed) return Promise.reject(new WeComRunCapacityError('shutting-down'));
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new WeComRunCapacityError('queue-full'));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: WeComRunWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(new WeComRunCapacityError('queue-timeout'));
        }, this.queueTimeoutMs),
      };
      waiter.timer.unref();
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const waiter = this.queue.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.active++;
    waiter.resolve();
  }
}

function capacityMessage(reason: WeComRunCapacityReason): string {
  if (reason === 'queue-full') return 'WeCom run queue is full';
  if (reason === 'queue-timeout') return 'WeCom run queue wait timed out';
  return 'WeCom run gate is shutting down';
}

/** Claim message ids once for a bounded period so callback retries cannot rerun Codex. */
export class WeComMessageDeduplicator {
  private readonly expiresAt = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  claim(messageId: string): boolean {
    const now = this.now();
    this.pruneExpired(now);
    const existing = this.expiresAt.get(messageId);
    if (existing !== undefined && existing > now) return false;
    this.expiresAt.delete(messageId);

    while (this.expiresAt.size >= this.maxEntries) {
      const oldest = this.expiresAt.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.expiresAt.delete(oldest);
    }
    this.expiresAt.set(messageId, now + this.ttlMs);
    return true;
  }

  private pruneExpired(now: number): void {
    for (const [messageId, expiry] of this.expiresAt) {
      if (expiry > now) break;
      this.expiresAt.delete(messageId);
    }
  }
}

const DEFAULT_STREAM_MAX_BYTES = 20_000;

/** Keep every send on one stream ID and make stream finalization idempotent. */
export class WeComStreamReply {
  private started = false;
  private finished = false;

  constructor(
    private readonly client: WeComStreamClient,
    private readonly frame: WsFrameHeaders,
    private readonly streamId: string,
  ) {}

  async start(content: string): Promise<void> {
    if (this.started) throw new Error('WeCom stream already started');
    this.started = true;
    await this.client.replyStream(this.frame, this.streamId, content, false);
  }

  /** Start one live stream with its control card attached to the same WeCom reply. */
  async startWithCard(content: string, card: TemplateCard): Promise<boolean> {
    if (this.started) throw new Error('WeCom stream already started');
    this.started = true;
    if (!this.client.replyStreamWithCard) {
      await this.client.replyStream(this.frame, this.streamId, content, false);
      return false;
    }
    await this.client.replyStreamWithCard(this.frame, this.streamId, content, false, {
      templateCard: card,
    });
    return true;
  }

  async update(content: string): Promise<boolean> {
    if (!this.started) throw new Error('WeCom stream has not started');
    if (this.finished) return false;
    await this.client.replyStream(this.frame, this.streamId, content, false);
    return true;
  }

  async finish(content: string): Promise<boolean> {
    if (this.finished) return false;
    this.started = true;
    // Claim finalization before awaiting the transport. A rejected final send
    // must not make an error handler finish the same protocol stream twice.
    this.finished = true;
    await this.client.replyStream(this.frame, this.streamId, content, true);
    return true;
  }
}

export interface WeComStreamUpdateTarget {
  update(content: string): Promise<boolean>;
  finish(content: string): Promise<boolean>;
}

/** Send at most one progress update at a time and retain only the latest pending view. */
export class WeComStreamUpdatePump {
  private pending: string | undefined;
  private inFlight: Promise<void> | undefined;
  private finishing = false;
  private sent = 0;
  private coalesced = 0;
  private failures = 0;

  constructor(private readonly target: WeComStreamUpdateTarget) {}

  update(content: string): boolean {
    if (this.finishing) return false;
    if (this.pending !== undefined) this.coalesced++;
    this.pending = content;
    this.drain();
    return true;
  }

  async flush(): Promise<void> {
    while (this.inFlight || this.pending !== undefined) {
      this.drain();
      const current = this.inFlight;
      if (current) await current;
    }
  }

  async finish(content: string): Promise<boolean> {
    if (this.finishing) return false;
    this.finishing = true;
    this.pending = undefined;
    if (this.inFlight) await this.inFlight;
    return this.target.finish(content);
  }

  snapshot(): { sent: number; coalesced: number; failures: number } {
    return { sent: this.sent, coalesced: this.coalesced, failures: this.failures };
  }

  private drain(): void {
    if (this.finishing || this.inFlight || this.pending === undefined) return;
    const content = this.pending;
    this.pending = undefined;
    this.inFlight = Promise.resolve()
      .then(() => this.target.update(content))
      .then(
        () => {
          this.sent++;
        },
        () => {
          // A transient progress failure must not abort the Codex run. The final
          // send is still attempted after the in-flight request settles.
          this.failures++;
        },
      )
      .finally(() => {
        this.inFlight = undefined;
        this.drain();
      });
  }
}

/** Resolve false when cleanup exceeds its deadline; settlement errors count as completed. */
export async function waitForCompletion(
  task: PromiseLike<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = Promise.resolve(task).then(
    () => true,
    () => true,
  );
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function messageTarget(body: ConversationBody): string {
  if (body.chattype === 'group' || (body.chatid && body.chattype !== 'single')) {
    if (!body.chatid) throw new Error('WeCom group message missing chatid');
    return body.chatid;
  }
  const userid = body.from?.userid;
  if (!userid) throw new Error('WeCom message missing sender userid');
  return userid;
}

export async function sendControlCard(
  client: WeComControlCardClient,
  body: ConversationBody,
  card: TemplateCard,
): Promise<void> {
  await client.sendMessage(messageTarget(body), {
    msgtype: 'template_card',
    template_card: card,
  });
}

export function conversationKey(body: ConversationBody): string {
  if (body.chattype === 'group') {
    if (!body.chatid) throw new Error('WeCom group message missing chatid');
    return `group:${body.chatid}`;
  }
  if (body.chatid && body.chattype !== 'single') return `group:${body.chatid}`;
  const userid = body.from?.userid;
  if (!userid) throw new Error('WeCom message missing sender userid');
  return `single:${userid}`;
}

export function normalizeCardAction(value: string | undefined): WeComCardAction {
  if (value === 'stop' || value === 'new' || value === 'status') return value;
  return 'unknown';
}

export function templateCardEventDetails(event: unknown): WeComTemplateCardEventDetails {
  if (!event || typeof event !== 'object') return {};
  const root = event as Record<string, unknown>;
  const nestedValue = root.template_card_event;
  const nested =
    nestedValue && typeof nestedValue === 'object'
      ? (nestedValue as Record<string, unknown>)
      : undefined;
  const eventKey = stringValue(nested?.event_key) ?? stringValue(root.event_key);
  const taskId = stringValue(nested?.task_id) ?? stringValue(root.task_id);
  const selectedId = firstSelectedOptionId(
    nested?.selected_items ??
      nested?.selected_item ??
      root.selected_items ??
      root.selected_item,
  );
  return {
    ...(eventKey ? { eventKey } : {}),
    ...(taskId ? { taskId } : {}),
    ...(selectedId ? { selectedId } : {}),
  };
}

export function normalizeIncomingText(
  content: string,
  chattype: ConversationBody['chattype'],
): string {
  const trimmed = content.trim();
  if (chattype !== 'group') return trimmed;
  return trimmed.replace(/^@\S+(?:\s+|$)/u, '').trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function firstSelectedOptionId(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  const direct = stringValue(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const selected = firstSelectedOptionId(item, depth + 1);
      if (selected) return selected;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['option_id', 'option_ids', 'selected_item']) {
    const selected = firstSelectedOptionId(record[key], depth + 1);
    if (selected) return selected;
  }
  return undefined;
}

export function readSandbox(value: string | undefined): CodexSandboxMode {
  if (!value) return 'read-only';
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }
  throw new Error(`Invalid WECOM_CODEX_SANDBOX: ${value}`);
}

export function readStreamMaxBytes(value: string | undefined): number {
  const parsed = value ? Number(value) : DEFAULT_STREAM_MAX_BYTES;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STREAM_MAX_BYTES;
  // WeCom's hard limit is 20480 bytes. Always retain 480 bytes of protocol
  // headroom, even when an operator configures a larger value.
  return Math.min(Math.floor(parsed), DEFAULT_STREAM_MAX_BYTES);
}

export async function withActiveRun<K, V, T>(
  runs: Map<K, V>,
  key: K,
  value: V,
  task: () => Promise<T>,
): Promise<T> {
  if (runs.has(key)) throw new Error('WeCom conversation already has an active run');
  runs.set(key, value);
  try {
    return await task();
  } finally {
    if (runs.get(key) === value) runs.delete(key);
  }
}

export async function withReservation<K, T>(
  reservations: Set<K>,
  key: K,
  task: () => Promise<T>,
): Promise<T> {
  if (reservations.has(key)) throw new Error('WeCom conversation is already reserved');
  reservations.add(key);
  try {
    return await task();
  } finally {
    reservations.delete(key);
  }
}
