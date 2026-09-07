import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationState } from '../../../src/bridge/conversation-state';
import { conversationViews } from '../../../src/bridge/conversation-views';
import { bridgeIdentityKey, sessionBindingKey, canonicalWorkspace, type BridgeIdentity } from '../../../src/bridge/identity';
import { WeComConversationBindings } from '../../../src/wecom/conversation-bindings';
import { acquireStateDirectoryLock } from '../../../src/bridge/state-lock';
import { writeFileAtomic } from '../../../src/platform/atomic-write';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'shared-conversations-')); dirs.push(dir); return dir; }
const lark: BridgeIdentity = { channel: 'lark', accountId: 'app', instanceId: 'profile' };
const wecom: BridgeIdentity = { ...lark, channel: 'wecom' };
const identity = { scopeId: 'same-chat', agentId: 'codex' as const, cwdRealpath: '/repo', policyFingerprint: 'full' };

describe('shared conversation identity and migration', () => {
  it('separates channel, account, instance, cwd, agent and policy, including delimiter-like inputs', async () => {
    const dir = await temp();
    const state = new ConversationState(join(dir, 'state.json')); await state.load(lark);
    const views = conversationViews(state, lark);
    views.sessionCatalog.upsertActive({ ...identity, threadId: 'thread' }); await state.flush();
    expect(views.sessionCatalog.activeFor(identity)?.threadId).toBe('thread');
    for (const other of [wecom, { ...lark, accountId: 'another' }, { ...lark, instanceId: 'another' }]) {
      expect(conversationViews(state, other).sessionCatalog.activeFor(identity)).toBeUndefined();
    }
    for (const other of [{ ...identity, cwdRealpath: '/other' }, { ...identity, policyFingerprint: 'readonly' }, { ...identity, agentId: 'claude' as const }]) {
      expect(views.sessionCatalog.activeFor(other)).toBeUndefined();
    }
    expect(sessionBindingKey(lark, { ...identity, cwdRealpath: '/x\x1fy', policyFingerprint: 'z' }))
      .not.toBe(sessionBindingKey(lark, { ...identity, cwdRealpath: '/x', policyFingerprint: 'y\x1fz' }));
    expect(bridgeIdentityKey({ ...lark, accountId: 'a:b', instanceId: 'c' }))
      .not.toBe(bridgeIdentityKey({ ...lark, accountId: 'a', instanceId: 'b:c' }));
  });

  it('imports Lark catalog, workspace and idle preferences once without changing the originals', async () => {
    const dir = await temp(); const files = { sessions: join(dir, 'sessions.json'), catalog: join(dir, 'catalog.json'), workspaces: join(dir, 'workspaces.json') };
    const texts = {
      sessions: JSON.stringify({ chat: { sessionId: 'legacy', cwd: '/repo', updatedAt: 100, idleTimeoutMinutes: 7 } }),
      catalog: JSON.stringify([{ ...identity, key: ['same-chat', 'codex', '/repo', 'full'].join('\x1f'), threadId: 'known', status: 'active', updatedAt: 100 }]),
      workspaces: JSON.stringify({ chats: { chat: { cwd: '/repo' } }, named: { work: '/repo' } }),
    };
    for (const name of Object.keys(files) as Array<keyof typeof files>) await writeFile(files[name], texts[name]);
    const state = new ConversationState(join(dir, 'state.json')); await state.load(lark, files);
    const view = conversationViews(state, lark);
    expect(view.sessions.getIdleTimeoutMinutes('chat')).toBe(7);
    expect(view.sessions.resumeFor('chat', '/repo')).toBeUndefined();
    expect(view.sessionCatalog.activeFor(identity)?.threadId).toBe('known');
    expect(view.workspaces.cwdFor('chat')).toBe('/repo');
    expect(view.workspaces.getNamed('work')).toBe('/repo');
    view.sessions.clear('chat'); await view.sessions.flush();
    expect(view.sessions.getIdleTimeoutMinutes('chat')).toBe(7);
    for (const name of Object.keys(files) as Array<keyof typeof files>) expect(await readFile(files[name], 'utf8')).toBe(texts[name]);
    expect((await readdir(dir)).filter((name) => name.includes('pre-shared-'))).toHaveLength(3);
    const reopened = new ConversationState(join(dir, 'state.json')); await reopened.load(wecom, files);
    expect(conversationViews(reopened, wecom).workspaces.listNamed()).toEqual({});
    expect(conversationViews(reopened, lark).sessionCatalog.activeFor(identity)?.threadId).toBe('known');
  });

  it('rejects damaged legacy data without creating a new state or overwriting the source', async () => {
    const dir = await temp(); const source = join(dir, 'sessions.json'); await writeFile(source, '{broken');
    const state = new ConversationState(join(dir, 'v2.json'));
    await expect(state.load(wecom, { wecomThreads: source })).rejects.toThrow();
    expect(await readFile(source, 'utf8')).toBe('{broken');
    expect(await readdir(dir)).toEqual(['sessions.json']);
  });

  it('retries a migration interrupted after backup and before the final atomic commit', async () => {
    const dir = await temp(); const source = join(dir, 'sessions.json'); const target = join(dir, 'v2.json');
    const text = JSON.stringify({ chat: { threadId: 'legacy', updatedAt: new Date().toISOString() } });
    await writeFile(source, text);
    const broken = new ConversationState(target, { write: async (file, payload, opts) => {
      if (file === target) throw new Error('disk unavailable');
      await writeFileAtomic(file, payload, opts);
    } });
    await expect(broken.load(wecom, { wecomThreads: source })).rejects.toThrow('disk unavailable');
    const recovered = new ConversationState(target); await recovered.load(wecom, { wecomThreads: source });
    expect(await readFile(source, 'utf8')).toBe(text);
    expect((await readdir(dir)).filter((name) => name.includes('pre-shared-'))).toHaveLength(1);
    expect(conversationViews(recovered, wecom).sessionCatalog.entries()).toEqual([]);
  });

  it('keeps failed writes visible to flush and repairs them with a later complete snapshot', async () => {
    const dir = await temp(); let fail = false;
    const state = new ConversationState(join(dir, 'state.json'), { write: async (file, data, options) => {
      if (fail) throw new Error('ENOSPC'); await writeFileAtomic(file, data, options);
    } });
    await state.load(lark); const views = conversationViews(state, lark);
    fail = true; views.workspaces.setCwd('chat', '/a'); await expect(state.flush()).rejects.toThrow('ENOSPC');
    fail = false; views.workspaces.setCwd('chat', '/b'); await state.flush();
    const again = new ConversationState(state.file); await again.load(lark);
    expect(conversationViews(again, lark).workspaces.cwdFor('chat')).toBe('/b');
  });

  it('serializes changes from concurrent account views without losing either namespace', async () => {
    const dir = await temp(); const state = new ConversationState(join(dir, 'state.json')); await state.load(lark);
    const a = conversationViews(state, lark), b = conversationViews(state, wecom);
    a.workspaces.setCwd('__proto__', '/a'); b.workspaces.setCwd('__proto__', '/b');
    a.sessions.setIdleTimeoutMinutes('chat', 4); b.sessions.setIdleTimeoutMinutes('chat', 8);
    await Promise.all([a.workspaces.flush(), b.sessions.flush()]);
    const reopened = new ConversationState(state.file); await reopened.load(lark);
    expect(conversationViews(reopened, lark).workspaces.cwdFor('__proto__')).toBe('/a');
    expect(conversationViews(reopened, wecom).workspaces.cwdFor('__proto__')).toBe('/b');
    expect(conversationViews(reopened, lark).sessions.getIdleTimeoutMinutes('chat')).toBe(4);
    expect(conversationViews(reopened, wecom).sessions.getIdleTimeoutMinutes('chat')).toBe(8);
  });

  it('rejects a corrupted v2 file instead of importing old files over it', async () => {
    const dir = await temp(); const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 2, contexts: {}, migration: null }));
    const before = await readFile(file, 'utf8');
    await expect(new ConversationState(file).load(lark)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

describe('WeCom binding facade', () => {
  it('archives unverified legacy threads and resumes only a verified workspace/policy binding', async () => {
    const dir = await temp(); const file = join(dir, 'sessions.json');
    await writeFile(file, JSON.stringify({ chat: { threadId: 'unverified', updatedAt: new Date().toISOString() } }));
    const opts = { identity: wecom, workspace: dir, policyFingerprint: 'full' };
    const store = new WeComConversationBindings(file, opts); await store.load();
    expect(store.threadId('chat')).toBeUndefined();
    await store.setThread('chat', 'verified'); expect(store.threadId('chat')).toBe('verified');
    const changed = new WeComConversationBindings(file, { ...opts, policyFingerprint: 'readonly' }); await changed.load();
    expect(changed.threadId('chat')).toBeUndefined();
    await changed.clear('chat');
    const restarted = new WeComConversationBindings(file, opts); await restarted.load();
    expect(restarted.threadId('chat')).toBeUndefined();
  });

  it('does not let a late completion attach the old thread to a newly bound workspace', async () => {
    const dir = await temp(); const other = join(dir, 'other'); await mkdir(other);
    const store = new WeComConversationBindings(join(dir, 'sessions.json'), { identity: wecom, workspace: dir, policyFingerprint: 'policy' });
    await store.load(); const captured = store.bindingFor('chat');
    await store.bindWorkspace('chat', other); await store.setThread('chat', 'old-thread', captured);
    expect(store.threadId('chat')).toBeUndefined();
    await store.bindWorkspace('chat', dir); expect(store.threadId('chat')).toBe('old-thread');
  });

  it.skipIf(process.platform === 'win32')('uses canonical workspace identity rather than a mutable symlink', async () => {
    const dir = await temp(); const a = join(dir, 'a'), b = join(dir, 'b'), link = join(dir, 'link');
    await mkdir(a); await mkdir(b); await symlink(a, link);
    const store = new WeComConversationBindings(join(dir, 'sessions.json'), { identity: wecom, workspace: link, policyFingerprint: 'policy' });
    await store.load(); await store.setThread('chat', 'thread-a');
    expect(store.bindingFor('chat').cwdRealpath).toBe(canonicalWorkspace(a));
    await rm(link); await symlink(b, link);
    expect(store.threadId('chat')).toBeUndefined();
  });

  it('prevents two live writers from owning the same state directory', async () => {
    const dir = await temp(); const release = await acquireStateDirectoryLock(dir);
    try { await expect(acquireStateDirectoryLock(dir)).rejects.toThrow(); }
    finally { await release(); await release(); }
    const again = await acquireStateDirectoryLock(dir); await again();
  });
});
