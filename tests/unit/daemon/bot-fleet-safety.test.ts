import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The fleet backend is macOS-only. Keep all fixture paths POSIX on Windows CI
// so identity assertions exercise the same launchd semantics everywhere.
vi.mock('node:path', async (original) => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, ...actual.posix };
});

import { join } from 'node:path';

type Definition = {
  label: string;
  args: string[];
  envFile?: string;
  larkHome?: string;
};
type Job = { pid?: string; state?: string; temporary?: boolean };
type Failure = { status: number | null; stderr?: string; error?: Error; afterBootstrap?: boolean };

const fake = vi.hoisted(() => ({
  files: new Set<string>(),
  dirs: new Set<string>(),
  links: new Set<string>(),
  definitions: new Map<string, Definition>(),
  jobs: new Map<string, Job>(),
  calls: [] as string[][],
  listFailure: undefined as Failure | undefined,
  printFailures: new Map<string, Failure>(),
  enableFailures: new Set<string>(),
  bootstrapFailures: new Set<string>(),
  bootstrapLabels: new Set<string>(),
  bootstrapRaceLabels: new Set<string>(),
  postBootstrapStates: new Map<string, Job>(),
  raceWriteEnv: undefined as string | undefined,
  write: vi.fn(),
  mkdir: vi.fn(),
}));

const fakeNode = '/fake/bin/node';
const otherNode = '/other/bin/node';
const home = '/fake/home';
const root = join(home, '.lark-channel');
const lark = 'ai.lark-channel-bridge.bot.codex';
const wecom = 'ai.wecom-channel-bridge.test';
const wecomA = 'ai.wecom-channel-bridge.a';
const wecomB = 'ai.wecom-channel-bridge.b';
const larkEntry = join('/pkg/bin', 'lark-channel-bridge.mjs');
const wecomEntry = join('/pkg/bin', 'wecom-channel-bridge.mjs');
const larkDistEntry = join('/pkg/dist', 'cli.js');
const wecomDistEntry = join('/pkg/dist', 'wecom.js');
const envA = '/private/a.env';
const envB = '/private/b.env';
const plist = (label: string) => join(home, 'Library', 'LaunchAgents', `${label}.plist`);
const argv1 = process.argv[1];
const originalPlatform = process.platform;
const originalExitCode = process.exitCode;
const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath');

vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(),
  homedir: () => home,
  userInfo: () => ({ uid: 501 }),
}));
vi.mock('../../../src/config/paths', () => ({
  paths: { rootDir: root, profile: 'codex', configFile: `${root}/config.json` },
}));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  existsSync: (path: string) => fake.files.has(path) || fake.dirs.has(path),
  lstatSync: (path: string) => ({
    isFile: () => fake.files.has(path),
    isSymbolicLink: () => fake.links.has(path),
  }),
  realpathSync: (path: string) => {
    if (!fake.files.has(path) && !fake.dirs.has(path)) throw new Error('path unavailable');
    return path;
  },
  readdirSync: () => [...fake.definitions.keys()].map((path) => path.split('/').pop()!),
  mkdirSync: (path: string) => { fake.mkdir(path); fake.dirs.add(path); },
  writeFileSync: (path: string, content: string, options: unknown) => {
    fake.write(path, content, options);
    if (fake.raceWriteEnv) {
      // Another invocation won the exclusive create between our check and
      // write. Leave its canonical definition in place and report EEXIST.
      const winnerEnv = fake.raceWriteEnv;
      fake.raceWriteEnv = undefined;
      fake.files.add(path);
      fake.definitions.set(path, { label: wecom, args: [fakeNode, wecomEntry], envFile: winnerEnv });
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    }
    if (fake.files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    fake.files.add(path);
    const env = /<key>WECOM_ENV_FILE<\/key><string>(.*?)<\/string>/.exec(content)?.[1]
      ?.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"');
    const args = [process.execPath, wecomEntry];
    fake.definitions.set(path, { label: wecom, args, envFile: env });
  },
}));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawnSync: (bin: string, args: string[]) => {
    fake.calls.push([bin, ...args]);
    if (bin === '/usr/bin/plutil') {
      const definition = fake.definitions.get(args[args.length - 1]!);
      const key = args[1];
      const value = key === 'Label' ? definition?.label
        : key === 'ProgramArguments' ? JSON.stringify(definition?.args)
          : key === 'EnvironmentVariables.WECOM_ENV_FILE' ? definition?.envFile
            : key === 'EnvironmentVariables.LARK_CHANNEL_HOME' ? definition?.larkHome
              : undefined;
      return { status: value === undefined ? 1 : 0, stdout: value ?? '', stderr: '' };
    }
    const command = args[0];
    if (command === 'list') {
      if (fake.listFailure) {
        return { status: fake.listFailure.status, stdout: '', stderr: fake.listFailure.stderr ?? '',
          ...(fake.listFailure.error ? { error: fake.listFailure.error } : {}) };
      }
      return { status: 0, stdout: [...fake.jobs].map(([label, job]) => `${job.pid}\t0\t${label}`).join('\n'), stderr: '' };
    }
    const label = args[1]?.replace('gui/501/', '') ?? '';
    if (command === 'print') {
      const failure = fake.printFailures.get(label);
      if (failure && (!failure.afterBootstrap || fake.bootstrapLabels.has(label))) {
        return { status: failure.status, stdout: '', stderr: failure.stderr ?? '', ...(failure.error ? { error: failure.error } : {}) };
      }
      const job = fake.jobs.get(label);
      if (!job) return { status: 113, stdout: '', stderr: '' };
      const displayedJob = fake.postBootstrapStates.get(label) ?? job;
      return {
        status: 0,
        stderr: '',
        stdout: `gui/501/${label} = {\npath = ${displayedJob.temporary ? '(submitted by launchctl[1])' : '/fake/service.plist'}\nstate = ${displayedJob.state ?? 'running'}\n${displayedJob.pid ? `pid = ${displayedJob.pid}\n` : ''}runs = 1\n}`,
      };
    }
    if (command === 'enable') {
      if (fake.enableFailures.has(label)) return { status: 1, stdout: '', stderr: 'enable failed' };
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'bootstrap') {
      const file = args[2]!;
      const definition = fake.definitions.get(file);
      const definitionLabel = definition?.label ?? label;
      fake.bootstrapLabels.add(definitionLabel);
      if (fake.bootstrapFailures.has(definitionLabel)) return { status: 5, stdout: '', stderr: 'bootstrap failed' };
      if (fake.bootstrapRaceLabels.has(definitionLabel)) {
        fake.jobs.set(definitionLabel, { pid: definitionLabel.includes('wecom') ? '200' : '100' });
        fake.bootstrapRaceLabels.delete(definitionLabel);
        return { status: 5, stdout: '', stderr: 'already loaded' };
      }
      if (fake.jobs.has(definitionLabel)) return { status: 5, stdout: '', stderr: 'already loaded' };
      fake.jobs.set(definitionLabel, { pid: definitionLabel.includes('wecom') ? '200' : '100' });
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  },
}));

const { buildWeComServicePlist, runAllServices } = await import('../../../src/daemon/bot-fleet');

function addFile(path: string): void { fake.files.add(path); }
function addDefinition(path: string, definition: Definition): void {
  addFile(path);
  fake.definitions.set(path, definition);
}
function seedLark(entry = larkEntry, larkHome = root, node = process.execPath): void {
  addDefinition(plist(lark), {
    label: lark,
    args: [node, entry, 'run', '--profile', 'codex'],
    larkHome,
  });
}
function seedWeCom(label = wecom, envFile = envA, entry = wecomEntry, node = process.execPath): void {
  addDefinition(plist(label), { label, args: [node, entry], envFile });
}
function effects(): string[][] {
  return fake.calls.filter((call) => call[0] === '/bin/launchctl' && !['print', 'list'].includes(call[1]!));
}
const options = { profile: 'codex', wecomService: wecom };

beforeEach(() => {
  fake.files.clear(); fake.dirs.clear(); fake.links.clear(); fake.definitions.clear(); fake.jobs.clear();
  fake.calls.length = 0; fake.listFailure = undefined; fake.printFailures.clear(); fake.enableFailures.clear(); fake.bootstrapFailures.clear();
  fake.bootstrapLabels.clear(); fake.bootstrapRaceLabels.clear(); fake.postBootstrapStates.clear(); fake.raceWriteEnv = undefined;
  fake.write.mockClear(); fake.mkdir.mockClear();
  Object.defineProperty(process, 'execPath', { ...originalExecPath, value: fakeNode });
  for (const path of [fakeNode, otherNode, larkEntry, wecomEntry, larkDistEntry, wecomDistEntry, envA, envB]) addFile(path);
  for (const path of [home, join(home, 'Library'), join(home, 'Library', 'LaunchAgents'), root]) fake.dirs.add(path);
  process.argv[1] = larkEntry;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.exitCode = originalExitCode;
});

afterEach(() => {
  if (originalExecPath) Object.defineProperty(process, 'execPath', originalExecPath);
  if (argv1 === undefined) process.argv.splice(1, 1);
  else process.argv[1] = argv1;
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  process.exitCode = originalExitCode;
  vi.useRealTimers(); vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('fleet safety boundaries with a fake launchctl backend', () => {
  it.each([
    { status: 1, stderr: 'permission denied' },
    { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { status: 113, error: new Error('spawn failed') },
  ])('fails closed on launchctl print errors and does not enable or bootstrap: %j', async (failure) => {
    seedLark();
    fake.printFailures.set(lark, failure);
    await runAllServices('start', options);
    expect(process.exitCode).toBe(1);
    expect(effects()).toEqual([]);
  });

  it('isolates service discovery failure so the valid Lark service still starts', async () => {
    seedLark();
    fake.listFailure = { status: 1, stderr: 'permission denied' };
    await runAllServices('start', { profile: 'codex' });
    expect(effects()).toContainEqual(['/bin/launchctl', 'bootstrap', 'gui/501', plist(lark)]);
    expect(process.exitCode).toBe(1);
  });

  it('keeps discovery uncertainty distinct from a confirmed stopped status', async () => {
    seedLark();
    fake.listFailure = { status: 1, stderr: 'permission denied' };
    await runAllServices('status', { profile: 'codex' });
    expect(process.exitCode).toBe(1);
    expect(effects()).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('状态未确认'));
  });

  it('does not accept a different env file after a concurrent wx creation race', async () => {
    seedLark();
    fake.raceWriteEnv = envB;
    await runAllServices('start', { ...options, wecomEnvFile: envA });
    expect(fake.write).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(fake.jobs.get(wecom)).toBeUndefined();
    expect(effects()).not.toContainEqual(['/bin/launchctl', 'bootstrap', 'gui/501', plist(wecom)]);
  });

  it('allows concurrent starts with the same env file without duplicate processes', async () => {
    seedLark();
    vi.useFakeTimers();
    const first = runAllServices('start', { ...options, wecomEnvFile: envA });
    const second = runAllServices('start', { ...options, wecomEnvFile: envA });
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(fake.write).toHaveBeenCalledOnce();
    expect(fake.jobs.get(wecom)?.pid).toBe('200');
    expect(fake.calls.filter((call) => call[1] === 'bootstrap' && call[3] === plist(wecom))).toHaveLength(1);
    expect(process.exitCode).not.toBe(1);
  });

  it('accepts the already-loaded winner when bootstrap loses an identical race', async () => {
    seedLark(); seedWeCom();
    fake.bootstrapRaceLabels.add(wecom);
    vi.useFakeTimers();
    const pending = runAllServices('start', options);
    await vi.runAllTimersAsync();
    await pending;
    expect(process.exitCode).not.toBe(1);
    expect(fake.jobs.get(wecom)?.pid).toBe('200');
    expect(effects()).toContainEqual(['/bin/launchctl', 'bootstrap', 'gui/501', plist(wecom)]);
    expect(effects().some((call) => call[1] === 'bootout' || call[1] === 'kill')).toBe(false);
  });

  it('returns nonzero when a bootstrapped process exits before observation', async () => {
    seedLark(); seedWeCom();
    fake.postBootstrapStates.set(wecom, { state: 'spawn scheduled' });
    vi.useFakeTimers();
    const pending = runAllServices('start', options);
    await vi.runAllTimersAsync();
    await pending;
    expect(process.exitCode).toBe(1);
    expect(effects()).toContainEqual(['/bin/launchctl', 'bootstrap', 'gui/501', plist(wecom)]);
    expect(fake.jobs.get(wecom)?.pid).toBe('200');
  });

  it('rejects a same-basename entry from another package and preserves the peer', async () => {
    addFile('/other/bin/lark-channel-bridge.mjs');
    seedLark('/other/bin/lark-channel-bridge.mjs');
    seedWeCom();
    await runAllServices('start', options);
    expect(process.exitCode).toBe(1);
    expect(effects()).toEqual([
      ['/bin/launchctl', 'enable', `gui/501/${wecom}`],
      ['/bin/launchctl', 'bootstrap', 'gui/501', plist(wecom)],
    ]);
  });

  it('rejects a different node executable even when its basename is node', async () => {
    seedLark(larkEntry, root, otherNode);
    seedWeCom();
    await runAllServices('start', options);
    expect(process.exitCode).toBe(1);
    expect(effects()).toEqual([
      ['/bin/launchctl', 'enable', `gui/501/${wecom}`],
      ['/bin/launchctl', 'bootstrap', 'gui/501', plist(wecom)],
    ]);
  });

  it('accepts the exact built dist entry paths alongside source bin paths', async () => {
    seedLark(larkDistEntry);
    seedWeCom(wecom, envA, wecomDistEntry);
    fake.jobs.set(lark, { pid: '100' }); fake.jobs.set(wecom, { pid: '200' });
    await runAllServices('start', options);
    expect(process.exitCode).not.toBe(1);
    expect(effects()).toEqual([]);
  });

  it('rejects a service definition whose Lark state root differs from the active root', async () => {
    seedLark(larkEntry, '/other/state');
    seedWeCom();
    await runAllServices('start', options);
    expect(process.exitCode).toBe(1);
    expect(effects()).toEqual([
      ['/bin/launchctl', 'enable', `gui/501/${wecom}`],
      ['/bin/launchctl', 'bootstrap', 'gui/501', plist(wecom)],
    ]);
  });

  it('keeps caller cwd and runtime env paths without copying secrets into the plist', async () => {
    seedLark();
    vi.spyOn(process, 'cwd').mockReturnValue('/fake/workspace');
    vi.stubEnv('WECOM_WORKSPACE', 'relative-workspace');
    vi.stubEnv('WECOM_STATE_DIR', 'relative-state');
    await runAllServices('start', { ...options, wecomEnvFile: envA });
    const content = fake.write.mock.calls[0]?.[1] as string;
    expect(content).toContain('<key>WorkingDirectory</key><string>/fake/workspace</string>');
    expect(content).toContain('<key>WECOM_ENV_FILE</key><string>/private/a.env</string>');
    expect(content).toContain('<key>WECOM_WORKSPACE</key><string>/fake/workspace/relative-workspace</string>');
    expect(content).toContain('<key>WECOM_STATE_DIR</key><string>/fake/workspace/relative-state</string>');
    expect(content).not.toContain('WECOM_SECRET');
    expect(content).not.toContain('WECOM_BOT_ID');
  });

  it('does not continue after enable, bootstrap, or observation failure', async () => {
    seedLark(); seedWeCom();
    fake.enableFailures.add(lark);
    fake.bootstrapFailures.add(wecom);
    fake.printFailures.set(wecom, { status: 1, stderr: 'observation failed', afterBootstrap: true });
    await runAllServices('start', options);
    expect(process.exitCode).toBe(1);
    expect(effects()).toEqual([
      ['/bin/launchctl', 'enable', `gui/501/${lark}`],
      ['/bin/launchctl', 'enable', `gui/501/${wecom}`],
      ['/bin/launchctl', 'bootstrap', 'gui/501', plist(wecom)],
    ]);
  });

  it('returns nonzero when a successfully bootstrapped job cannot be observed', async () => {
    seedLark(); seedWeCom();
    fake.printFailures.set(wecom, { status: 1, stderr: 'observation failed', afterBootstrap: true });
    await runAllServices('start', options);
    expect(process.exitCode).toBe(1);
    expect(effects()).toContainEqual(['/bin/launchctl', 'bootstrap', 'gui/501', plist(wecom)]);
    expect(fake.jobs.get(wecom)?.pid).toBe('200');
  });

  it('requires an existing env file for an installed WeCom definition', async () => {
    seedLark(); seedWeCom(wecom, '/private/missing.env');
    await runAllServices('start', options);
    expect(process.exitCode).toBe(1);
    expect(effects()).toEqual([
      ['/bin/launchctl', 'enable', `gui/501/${lark}`],
      ['/bin/launchctl', 'bootstrap', 'gui/501', plist(lark)],
    ]);
  });

  it('reports an ambiguous discovered WeCom set while still processing Lark', async () => {
    seedLark();
    fake.jobs.set(wecomA, { pid: '201' }); fake.jobs.set(wecomB, { pid: '202' });
    await runAllServices('start', { profile: 'codex', wecomEnvFile: envA });
    expect(effects()).toContainEqual(['/bin/launchctl', 'bootstrap', 'gui/501', plist(lark)]);
    expect(process.exitCode).toBe(1);
  });
});

describe('WeCom plist input contract', () => {
  it('keeps the caller-provided working directory and only references the env file', () => {
    const content = buildWeComServicePlist({ label: wecom, node: '/fake/bin/node', entry: wecomEntry,
      envFile: envA, cwd: '/workspace/project', envPath: '/bin:/usr/bin', logDir: '/logs' });
    expect(content).toContain('<key>WorkingDirectory</key><string>/workspace/project</string>');
    expect(content).toContain('<key>PATH</key><string>/bin:/usr/bin</string>');
    expect(content).toContain('<key>WECOM_ENV_FILE</key><string>/private/a.env</string>');
    expect(content).not.toContain('WECOM_SECRET');
  });
});
