import { describe, expect, it, vi } from 'vitest';
import { buildWeComServicePlist, controlBotFleet, selectWeComLabel, type BotServiceState, type FleetService } from '../../../src/daemon/bot-fleet';

function fake(name: string, initial: BotServiceState): FleetService {
  let state = initial;
  return { name, label: name, prepare: vi.fn(async () => {}), inspect: vi.fn(() => state),
    start: vi.fn(async () => { state = { loaded: true, running: true, pid: '123' }; }) };
}

describe('independent bot fleet start', () => {
  it('keeps both already-running processes, without a second start', async () => {
    const services = ['lark', 'wecom'].map((name) => fake(name, { loaded: true, running: true, pid: '123' }));
    const result = await controlBotFleet('start', services);
    expect(result.map((r) => r.outcome)).toEqual(['already-running', 'already-running']);
    services.forEach((s) => expect(s.start).not.toHaveBeenCalled());
  });
  it('starts both stopped services, then makes another invocation idempotent', async () => {
    const services = ['lark', 'wecom'].map((name) => fake(name, { loaded: false, running: false }));
    expect((await controlBotFleet('start', services)).every((r) => r.ok && r.outcome === 'started')).toBe(true);
    expect((await controlBotFleet('start', services)).every((r) => r.outcome === 'already-running')).toBe(true);
    services.forEach((s) => expect(s.start).toHaveBeenCalledTimes(1));
  });
  it('does not duplicate a loaded crash loop, while still starting the other platform', async () => {
    const broken = fake('lark', { loaded: true, running: false, state: 'spawn scheduled', lastExit: '1' });
    const good = fake('wecom', { loaded: false, running: false });
    const result = await controlBotFleet('start', [broken, good]);
    expect(result.map((r) => r.ok)).toEqual([false, true]);
    expect(broken.start).not.toHaveBeenCalled();
    expect(good.start).toHaveBeenCalledOnce();
  });
  it('isolates preparation failure and does not leak raw exceptions or roll back the other bot', async () => {
    const broken = fake('lark', { loaded: false, running: false });
    const good = fake('wecom', { loaded: false, running: false });
    broken.prepare = vi.fn(async () => { throw new Error('app-secret=DO-NOT-PRINT'); });
    const result = await controlBotFleet('start', [broken, good]);
    expect(result.map((r) => r.ok)).toEqual([false, true]);
    expect(JSON.stringify(result)).not.toContain('DO-NOT-PRINT');
    expect(broken.start).not.toHaveBeenCalled();
  });
  it('does not report success merely because the start command returned', async () => {
    const service = fake('wecom', { loaded: false, running: false });
    service.start = vi.fn(async () => {});
    expect((await controlBotFleet('start', [service]))[0]?.ok).toBe(false);
  });
  it('makes status strictly non-mutating, including no installation', async () => {
    const service = fake('wecom', { loaded: true, running: false });
    expect((await controlBotFleet('status', [service]))[0]?.ok).toBe(false);
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
  });
});

describe('WeCom service selection and definition', () => {
  it('deduplicates loaded/installed labels and rejects ambiguous or unrelated targets', () => {
    const a = 'ai.wecom-channel-bridge.a';
    const b = 'ai.wecom-channel-bridge.b';
    expect(selectWeComLabel([a, a, 'unrelated.job'])).toBe(a);
    expect(() => selectWeComLabel([a, b])).toThrow('多个');
    expect(selectWeComLabel([a, b], b)).toBe(b);
    expect(() => selectWeComLabel([], 'unrelated.job')).toThrow();
    expect(() => selectWeComLabel([], 'ai.wecom-channel-bridge.x/../../bad')).toThrow();
    expect(selectWeComLabel([])).toBe('ai.wecom-channel-bridge.bot');
  });
  it('stores only an env-file reference, one entrypoint and bounded launchd retry rate', () => {
    const plist = buildWeComServicePlist({ label: 'ai.wecom-channel-bridge.test', node: '/node',
      entry: '/pkg/bin/wecom-channel-bridge.mjs', envFile: '/private/a&b.env', cwd: '/pkg',
      envPath: '/bin:/usr/bin', logDir: '/logs' });
    expect(plist).toContain('<key>ProgramArguments</key><array><string>/node</string><string>/pkg/bin/wecom-channel-bridge.mjs</string></array>');
    expect(plist).toContain('/private/a&amp;b.env');
    expect(plist).toContain('<key>WECOM_ENV_FILE</key>');
    expect(plist).not.toContain('WECOM_SECRET');
    expect(plist).not.toContain('WECOM_BOT_ID');
    expect(plist).not.toContain('/bin/zsh');
    expect(plist).toContain('<key>ThrottleInterval</key><integer>30</integer>');
    expect(plist).toContain('/logs/stderr.log');
  });
});
