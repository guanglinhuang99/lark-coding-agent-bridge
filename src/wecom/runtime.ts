import { ProcessPool, RunCapacityError, type RunPermit } from '../bridge/process-pool';
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

export {
  ConversationQueue as WeComConversationQueue,
  ConversationQueueError as WeComConversationQueueError,
  type ConversationQueueReason as WeComConversationQueueReason,
  type ConversationSubmission as WeComConversationSubmission,
} from '../bridge/conversation-queue';

export class WeComRunCapacityError extends Error {
  override readonly name = 'WeComRunCapacityError';

  constructor(readonly reason: WeComRunCapacityReason) {
    super(capacityMessage(reason));
  }
}

/** WeCom retains its API; the shared pool owns admission. */
export class WeComRunGate {
  readonly pool: ProcessPool;
  constructor(maxConcurrent: number, maxQueued: number, queueTimeoutMs: number) {
    this.pool = new ProcessPool(() => maxConcurrent, { maxQueued, queueTimeoutMs });
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    try { return await this.pool.run(task); }
    catch (err) {
      if (err instanceof RunCapacityError) throw new WeComRunCapacityError(err.reason);
      throw err;
    }
  }
  currentPermit(): RunPermit | undefined { return this.pool.currentPermit(); }
  snapshot(): { active: number; queued: number } {
    const state = this.pool.snapshot();
    return { active: state.active, queued: state.waiting };
  }
  close(): void { this.pool.close(); }
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
