import { createHash } from 'node:crypto';
import { TaskLedger, type TaskClaim, type TaskStatus } from './task-ledger';
import { bridgeIdentityKey, conversationIdentityKey, type BridgeIdentity } from './identity';
import type { SessionStore } from './session-store';

export type InboundTerminal = Extract<TaskStatus, 'done' | 'failed' | 'interrupted'>;
export interface InboundMessageRef { messageId: string; chatId: string }

/** Durable source receipts are separate from agent-batch execution receipts. */
export class InboundCoordinator {
  private readonly tickets = new Map<string, string>();
  private readonly pending = new Set<string>();
  private closed = false;
  constructor(readonly ledger: TaskLedger, private readonly identity: BridgeIdentity) {}

  async accept(message: InboundMessageRef): Promise<TaskClaim> {
    if (this.closed) throw new Error('Inbound coordinator is closed');
    if (!message.messageId?.trim() || !message.chatId?.trim()) throw new Error('Missing inbound message identity');
    // Use the stable parent chat, NOT a best-effort topic lookup, for deduplication.
    const claim = await this.ledger.claimInbound(
      JSON.stringify(['inbound', bridgeIdentityKey(this.identity), message.messageId]),
      conversationIdentityKey(this.identity, message.chatId),
    );
    if (claim.accepted) this.tickets.set(this.key(message), claim.task.id);
    return claim;
  }

  async beforeDispatch(message: InboundMessageRef): Promise<void> {
    if (this.closed) throw new Error('Inbound coordinator is closed');
    await this.ledger.markRunning(this.requireTicket(message));
  }

  /** Called only after the command dispatcher confirms it performed no command. */
  async queued(message: InboundMessageRef): Promise<void> {
    if (this.closed) throw new Error('Inbound coordinator is closed');
    await this.ledger.markQueued(this.requireTicket(message));
    this.pending.add(this.key(message));
  }

  async startBatch(messages: readonly InboundMessageRef[]): Promise<string> {
    if (this.closed) throw new Error('Inbound coordinator is closed');
    const ids = messages.map((message) => this.requireTicket(message));
    await this.ledger.markBatchRunning(ids);
    for (const message of messages) this.pending.delete(this.key(message));
    return this.batchOperationId(messages);
  }

  batchOperationId(messages: readonly InboundMessageRef[]): string {
    const members = [...new Set(messages.map((message) => this.key(message)))].sort();
    if (members.length === 0 || members.length !== messages.length) throw new Error('Invalid inbound batch membership');
    return `batch:${createHash('sha256').update(JSON.stringify([bridgeIdentityKey(this.identity), members])).digest('hex')}`;
  }

  async finish(messages: readonly InboundMessageRef[], status: InboundTerminal): Promise<void> {
    for (const message of messages) {
      const key = this.key(message);
      const id = this.tickets.get(key);
      if (!id) continue;
      if (status === 'done') await this.ledger.markDone(id);
      else if (status === 'interrupted') await this.ledger.markInterrupted(id);
      else await this.ledger.markFailed(id, 'inbound-execution');
      this.pending.delete(key);
      this.tickets.delete(key);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const key of this.pending) {
      const id = this.tickets.get(key);
      if (id) await this.ledger.markInterrupted(id);
      this.tickets.delete(key);
    }
    this.pending.clear();
    await this.ledger.flush();
  }

  private key(message: InboundMessageRef): string { return JSON.stringify([message.chatId, message.messageId]); }
  private requireTicket(message: InboundMessageRef): string {
    const id = this.tickets.get(this.key(message));
    if (!id) throw new Error('Inbound message was not durably accepted');
    return id;
  }
}

const writers = new WeakMap<SessionStore, Promise<TaskLedger>>();
/** Foreground and supervisor paths both get a durable ledger; reconnect reuses it. */
export async function openLarkTaskLedger(owner: SessionStore, sessionsFile: string): Promise<TaskLedger> {
  let loaded = writers.get(owner);
  if (!loaded) {
    const ledger = new TaskLedger(`${sessionsFile}.tasks.json`, { namespace: 'lark' });
    loaded = ledger.load().then(() => ledger);
    writers.set(owner, loaded);
    void loaded.catch(() => { if (writers.get(owner) === loaded) writers.delete(owner); });
  }
  return loaded;
}
