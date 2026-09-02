import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WeComSessionStore } from '../../../src/wecom/session-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WeCom session store', () => {
  it('initializes a missing file and keeps single/group threads isolated', async () => {
    const file = await sessionPath();
    const store = new WeComSessionStore(file);
    await store.load();

    await store.setThread('single:user-a', 'thread-single');
    await store.setThread('group:chat-a', 'thread-group');
    expect(store.threadId('single:user-a')).toBe('thread-single');
    expect(store.threadId('group:chat-a')).toBe('thread-group');

    await store.clear('single:user-a');
    expect(store.threadId('single:user-a')).toBeUndefined();
    expect(store.threadId('group:chat-a')).toBe('thread-group');

    const reloaded = new WeComSessionStore(file);
    await reloaded.load();
    expect(reloaded.threadId('single:user-a')).toBeUndefined();
    expect(reloaded.threadId('group:chat-a')).toBe('thread-group');
  });

  it('serializes concurrent writes without losing either conversation', async () => {
    const file = await sessionPath();
    const store = new WeComSessionStore(file);
    await store.load();

    await Promise.all([
      store.setThread('single:user-a', 'thread-a'),
      store.setThread('single:user-b', 'thread-b'),
    ]);

    const reloaded = new WeComSessionStore(file);
    await reloaded.load();
    expect(reloaded.threadId('single:user-a')).toBe('thread-a');
    expect(reloaded.threadId('single:user-b')).toBe('thread-b');
  });

  it('fails clearly on damaged JSON and preserves the original file', async () => {
    const file = await sessionPath();
    const damaged = '{"single:user-a":';
    await writeFile(file, damaged, 'utf8');

    const store = new WeComSessionStore(file);
    await expect(store.load()).rejects.toThrow('JSON is damaged; the original file was preserved');
    expect(await readFile(file, 'utf8')).toBe(damaged);
  });

  it('rejects structurally invalid entries instead of silently replacing them', async () => {
    const file = await sessionPath();
    const damaged = JSON.stringify({ 'single:user-a': { threadId: 42 } });
    await writeFile(file, damaged, 'utf8');

    const store = new WeComSessionStore(file);
    await expect(store.load()).rejects.toThrow('damaged entry');
    expect(await readFile(file, 'utf8')).toBe(damaged);
  });

  it('prunes expired sessions and retains only the most recently updated entries', async () => {
    const file = await sessionPath();
    await writeFile(
      file,
      JSON.stringify({
        expired: { threadId: 'thread-old', updatedAt: '2026-01-01T00:00:00.000Z' },
        recent: { threadId: 'thread-recent', updatedAt: '2026-08-30T00:00:00.000Z' },
        newest: { threadId: 'thread-newest', updatedAt: '2026-08-31T00:00:00.000Z' },
      }),
    );
    const store = new WeComSessionStore(file, {
      maxAgeMs: 90 * 24 * 60 * 60 * 1000,
      maxEntries: 1,
      now: () => new Date('2026-08-31T12:00:00.000Z'),
    });

    await store.load();
    expect(store.threadId('expired')).toBeUndefined();
    expect(store.threadId('recent')).toBeUndefined();
    expect(store.threadId('newest')).toBe('thread-newest');

    const persisted = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(persisted)).toEqual(['newest']);
  });

  it('supports periodic pruning after the store has loaded', async () => {
    const file = await sessionPath();
    let now = new Date('2026-08-31T00:00:00.000Z');
    const store = new WeComSessionStore(file, {
      maxAgeMs: 100,
      maxEntries: 10,
      now: () => now,
    });
    await store.load();
    await store.setThread('single:user-a', 'thread-a');

    now = new Date(now.getTime() + 101);
    await expect(store.prune()).resolves.toBe(1);
    expect(store.threadId('single:user-a')).toBeUndefined();
  });

  it('enforces the entry ceiling when a new conversation is persisted', async () => {
    const file = await sessionPath();
    let now = new Date('2026-08-31T00:00:00.000Z');
    const store = new WeComSessionStore(file, { maxEntries: 1, now: () => now });
    await store.load();
    await store.setThread('single:user-a', 'thread-a');

    now = new Date(now.getTime() + 1);
    await store.setThread('single:user-b', 'thread-b');
    expect(store.threadId('single:user-a')).toBeUndefined();
    expect(store.threadId('single:user-b')).toBe('thread-b');
  });
});

async function sessionPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wecom-session-store-'));
  roots.push(root);
  return join(root, 'sessions.json');
}
