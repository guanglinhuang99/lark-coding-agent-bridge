import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writePlist: vi.fn(async () => {}),
  plistExists: vi.fn(() => true),
  isLoaded: vi.fn(() => true),
  enable: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
  bootstrap: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
  bootout: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
  disable: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
  waitUntilUnloaded: vi.fn(async () => true),
  deletePlist: vi.fn(async () => {}),
  describeService: vi.fn(() => ''),
}));

vi.mock('../../../src/daemon/launchd', () => ({
  writePlist: mocks.writePlist,
  plistExists: mocks.plistExists,
  isLoaded: mocks.isLoaded,
  enable: mocks.enable,
  bootstrap: mocks.bootstrap,
  bootout: mocks.bootout,
  disable: mocks.disable,
  waitUntilUnloaded: mocks.waitUntilUnloaded,
  deletePlist: mocks.deletePlist,
  describeService: mocks.describeService,
}));

const { getServiceAdapter } = await import('../../../src/daemon/service-adapter');

const realPlatform = process.platform;
function forcePlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('launchd restart reload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forcePlatform('darwin');
    mocks.writePlist.mockResolvedValue(undefined);
    mocks.bootout.mockReturnValue({ ok: true, stdout: '', stderr: '' });
    mocks.waitUntilUnloaded.mockResolvedValue(true);
    mocks.enable.mockReturnValue({ ok: true, stdout: '', stderr: '' });
    mocks.bootstrap.mockReturnValue({ ok: true, stdout: '', stderr: '' });
  });

  afterAll(() => {
    forcePlatform(realPlatform);
  });

  it('rewrites the canonical plist and reloads the launchd job before restart', async () => {
    const runArgs = ['run', '--profile', 'codex'];
    const adapter = getServiceAdapter('codex', runArgs);

    const result = await adapter?.restart();

    expect(result).toMatchObject({ ok: true });
    expect(mocks.writePlist).toHaveBeenCalledWith('codex', runArgs);
    expect(mocks.bootout).toHaveBeenCalledWith('codex');
    expect(mocks.waitUntilUnloaded).toHaveBeenCalledWith('codex');
    expect(mocks.enable).toHaveBeenCalledWith('codex');
    expect(mocks.bootstrap).toHaveBeenCalledWith('codex');

    expect(mocks.writePlist.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bootout.mock.invocationCallOrder[0]!,
    );
    expect(mocks.bootout.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bootstrap.mock.invocationCallOrder[0]!,
    );
  });

  it('does not bootstrap a new job when the old launchd job cannot unload', async () => {
    mocks.waitUntilUnloaded.mockResolvedValue(false);
    const adapter = getServiceAdapter('codex', ['run', '--profile', 'codex']);

    const result = await adapter?.restart();

    expect(result).toEqual({
      ok: false,
      stderr: 'launchd job did not unload before restart',
    });
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });
});
