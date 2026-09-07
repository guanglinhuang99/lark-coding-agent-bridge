import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskLedger } from '../../../src/bridge/task-ledger';
import { InboundCoordinator } from '../../../src/bridge/inbound-coordinator';
import { writeFileAtomic } from '../../../src/platform/atomic-write';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'shared-inbound-')); dirs.push(dir);
  const file = join(dir, 'tasks.json'); const ledger = new TaskLedger(file, { namespace: 'lark' }); await ledger.load();
  const context = { channel: 'lark' as const, accountId: 'app', instanceId: 'profile' };
  return { file, ledger, context, inbound: new InboundCoordinator(ledger, context) };
}
const a = { chatId: 'chat', messageId: 'message-a' }, b = { chatId: 'chat', messageId: 'message-b' };

async function queue(inbound: InboundCoordinator, message = a) {
  const claim = await inbound.accept(message);
  expect(claim.accepted).toBe(true);
  await inbound.beforeDispatch(message); await inbound.queued(message);
  return claim.task.id;
}

describe('durable source receipts and stable batches', () => {
  it('deduplicates concurrent acceptance and keeps batch identity independent of arrival order', async () => {
    const h = await harness();
    const claims = await Promise.all([h.inbound.accept(a), h.inbound.accept(a)]);
    expect(claims.filter((claim) => claim.accepted)).toHaveLength(1);
    await h.inbound.beforeDispatch(a); await h.inbound.queued(a); await queue(h.inbound, b);
    expect(h.inbound.batchOperationId([a, b])).toBe(h.inbound.batchOperationId([b, a]));
    await h.inbound.startBatch([a, b]);
    expect(h.ledger.snapshot().running).toBe(2);
    await h.inbound.finish([a, b], 'done');
    expect(h.ledger.snapshot().done).toBe(2);
    expect((await h.inbound.accept(a)).accepted).toBe(false);
    const disk = await readFile(h.file, 'utf8'); expect(disk).not.toContain('message-a'); expect(disk).not.toContain('message-b');
  });

  it('accepts the same message id for a different account or bridge instance', async () => {
    const h = await harness(); await h.inbound.accept(a);
    expect((await new InboundCoordinator(h.ledger, { ...h.context, accountId: 'other' }).accept(a)).accepted).toBe(true);
    expect((await new InboundCoordinator(h.ledger, { ...h.context, instanceId: 'other' }).accept(a)).accepted).toBe(true);
  });

  it('allows queued redelivery after restart but never replays a source that reached running', async () => {
    const h = await harness(); await queue(h.inbound, a); await queue(h.inbound, b); await h.inbound.startBatch([b]);
    const reopened = new TaskLedger(h.file, { namespace: 'lark' }); await reopened.load();
    const restarted = new InboundCoordinator(reopened, h.context);
    expect((await restarted.accept(a)).accepted).toBe(true);
    expect((await restarted.accept(b)).accepted).toBe(false);
  });

  it('does not resurrect cancelled pending work after reconnect or process restart', async () => {
    const h = await harness(); await queue(h.inbound); await h.inbound.close();
    await expect(h.inbound.accept(b)).rejects.toThrow('closed');
    const reopened = new TaskLedger(h.file, { namespace: 'lark' }); await reopened.load();
    expect((await new InboundCoordinator(reopened, h.context).accept(a)).accepted).toBe(false);
  });

  it('does not downgrade a completed execution because delivery or a later handler failed', async () => {
    const h = await harness(); const id = await queue(h.inbound); await h.inbound.startBatch([a]);
    await h.ledger.markDone(id); await h.ledger.markFailed(id, 'delivery'); await h.ledger.markInterrupted(id);
    expect(h.ledger.recent()[0]?.status).toBe('done');
    await expect(h.ledger.markRunning(id)).rejects.toThrow('terminal');
  });

  it('rolls back a failed claim before a concurrent retry can observe it as accepted', async () => {
    const h = await harness(); let fail = true;
    const ledger = new TaskLedger(h.file, { write: async (file, data, options) => {
      if (fail) { fail = false; throw new Error('ENOSPC'); }
      await writeFileAtomic(file, data, options);
    } });
    const first = ledger.claimInbound('same-id', 'chat');
    const second = ledger.claimInbound('same-id', 'chat');
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0]?.status).toBe('rejected');
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled', value: { accepted: true, task: { attempts: 1 } } });
    expect(ledger.snapshot().total).toBe(1); await ledger.flush();
  });

  it('atomically rejects a partially invalid batch without changing any queued receipt', async () => {
    const h = await harness(); const id = await queue(h.inbound);
    await expect(h.ledger.markBatchRunning([id, 'missing'])).rejects.toThrow();
    expect(h.ledger.recent()[0]?.status).toBe('queued');
  });

  it('rolls back every source transition when committing a batch fails', async () => {
    const h = await harness(); let fail = false;
    const ledger = new TaskLedger(h.file, { write: async (file, data, options) => {
      if (fail) throw new Error('ENOSPC'); await writeFileAtomic(file, data, options);
    } });
    const one = await ledger.claimInbound('a', 'chat'), two = await ledger.claimInbound('b', 'chat');
    fail = true;
    await expect(ledger.markBatchRunning([one.task.id, two.task.id])).rejects.toThrow('ENOSPC');
    expect(ledger.snapshot()).toMatchObject({ queued: 2, running: 0 });
    await expect(ledger.flush()).rejects.toThrow('ENOSPC');
  });
});
