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

  /**
   * Start one live stream with its control card attached to the same WeCom reply.
   * Returns false when a client implementation predates replyStreamWithCard so
   * callers can fall back to a standalone card without breaking tests/adapters.
   */
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
  return {
    ...(eventKey ? { eventKey } : {}),
    ...(taskId ? { taskId } : {}),
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
