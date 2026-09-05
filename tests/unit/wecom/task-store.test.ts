import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WeComTaskStore, hashOperationKey } from '../../../src/wecom/task-store';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function taskFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wecom-task-store-'));
  dirs.push(dir);
  return path.join(dir, 'tasks.json');
}

describe('WeComTaskStore', () => {
  it('persists an idempotency key without storing the raw message id', async () => {
    const file = await taskFile();
    const store = new WeComTaskStore(file);
    const first = await store.claimInbound('sensitive-message-id', 'single:u1');
    expect(first.accepted).toBe(true);
    await store.markRunning(first.task.id);
    await store.markDone(first.task.id);

    const duplicate = await store.claimInbound('sensitive-message-id', 'single:u1');
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.task.status).toBe('done');

    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('sensitive-message-id');
    expect(raw).toContain(hashOperationKey('sensitive-message-id'));
  });

  it('marks in-flight work interrupted on restart and permits one replay', async () => {
    const file = await taskFile();
    const firstStore = new WeComTaskStore(file);
    const first = await firstStore.claimInbound('msg-1', 'group:g1');
    await firstStore.markRunning(first.task.id);
    await firstStore.flush();

    const restarted = new WeComTaskStore(file);
    await restarted.load();
    expect(restarted.snapshot().interrupted).toBe(1);
    expect(restarted.snapshot().recoveredAtStartup).toBe(1);

    const replay = await restarted.claimInbound('msg-1', 'group:g1');
    expect(replay.accepted).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.task.attempts).toBe(2);

    const duplicate = await restarted.claimInbound('msg-1', 'group:g1');
    expect(duplicate.accepted).toBe(false);
  });

  it('keeps only bounded recent records', async () => {
    const file = await taskFile();
    let now = Date.parse('2026-09-05T00:00:00.000Z');
    const store = new WeComTaskStore(file, {
      maxEntries: 2,
      now: () => new Date(now),
    });

    for (const id of ['a', 'b', 'c']) {
      const claim = await store.claimInbound(id, 'single:u1');
      await store.markDone(claim.task.id);
      now += 1_000;
    }

    expect(store.snapshot().total).toBe(2);
    expect(store.recent('single:u1', 10)).toHaveLength(2);
  });
});
