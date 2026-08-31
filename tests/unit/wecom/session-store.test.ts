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
});

async function sessionPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wecom-session-store-'));
  roots.push(root);
  return join(root, 'sessions.json');
}
