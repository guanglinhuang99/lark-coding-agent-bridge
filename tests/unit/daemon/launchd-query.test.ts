import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mock.spawn }));
vi.mock('node:os', () => ({ userInfo: () => ({ uid: 501 }), homedir: () => '/fake/home' }));
const { inspectService, isLoaded, waitUntilUnloaded } = await import('../../../src/daemon/launchd');

beforeEach(() => { mock.spawn.mockReset(); });

describe('launchd query uncertainty', () => {
  it.each([
    { status: null, error: Object.assign(new Error('private details'), { code: 'ETIMEDOUT' }) },
    { status: 1, stderr: 'permission denied private details' },
    { status: 113, error: new Error('spawn failed private details') },
  ])('does not treat a failed query as an absent job: %j', async (result) => {
    mock.spawn.mockReturnValue(result);
    expect(() => inspectService('test')).toThrow('状态');
    expect(() => isLoaded('test')).toThrow('状态');
    await expect(waitUntilUnloaded('test')).rejects.toThrow('状态');
    try { inspectService('test'); } catch (err) { expect(String(err)).not.toContain('private details'); }
  });
  it('recognizes the explicit service-not-found exit status', async () => {
    mock.spawn.mockReturnValue({ status: 113, stdout: '', stderr: '' });
    expect(inspectService('test')).toEqual({ loaded: false, running: false });
    expect(isLoaded('test')).toBe(false);
    expect(await waitUntilUnloaded('test')).toBe(true);
  });
  it('keeps a loaded job distinct from a running process and bounds the query', () => {
    mock.spawn.mockReturnValue({ status: 0, stdout: 'job = {\nstate = spawn scheduled\n}', stderr: '' });
    expect(isLoaded('test')).toBe(true);
    expect(inspectService('test')).toMatchObject({ loaded: true, running: false });
    expect(mock.spawn).toHaveBeenLastCalledWith('launchctl', ['print', 'gui/501/ai.lark-channel-bridge.bot.test'], expect.objectContaining({ timeout: 5000 }));
  });
});
