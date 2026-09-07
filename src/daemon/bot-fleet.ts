import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { paths } from '../config/paths';
import { loadRootConfig, readActiveProfile } from '../config/profile-store';
import { launchAgentLabel, launchAgentPlistPath } from './paths';
import { inspectLaunchdStatus, type LaunchdStatus } from './launchd-status';

export interface FleetOptions {
  profile?: string;
  wecomService?: string;
  /** A path, never a secret. Required only when installing a missing definition. */
  wecomEnvFile?: string;
}
export interface BotServiceState extends LaunchdStatus {
  persistent?: boolean;
  temporary?: boolean;
}
export interface FleetService {
  name: string;
  label: string;
  prepare?(): Promise<void>;
  inspect(): BotServiceState;
  start(): Promise<void>;
}
export interface FleetResult {
  name: string;
  label: string;
  ok: boolean;
  outcome: 'already-running' | 'started' | 'status' | 'failed';
  status?: BotServiceState;
  error?: string;
}

/** No supervisor process: each OS-owned service retains its own failure boundary. */
export async function controlBotFleet(
  action: 'start' | 'status',
  services: FleetService[],
): Promise<FleetResult[]> {
  return Promise.all(services.map(async (service): Promise<FleetResult> => {
    const base = { name: service.name, label: service.label };
    try {
      if (action === 'start') await service.prepare?.();
      const before = service.inspect();
      if (action === 'status') return { ...base, ok: before.running, outcome: 'status', status: before };
      if (before.running) return { ...base, ok: true, outcome: 'already-running', status: before };
      // A loaded but unhealthy job may already be respawning. Do not add another process.
      if (before.loaded) return { ...base, ok: false, outcome: 'failed', status: before,
        error: 'job 已加载但进程未运行；请先诊断或显式重启，未重复启动' };
      await service.start();
      const after = service.inspect();
      return { ...base, ok: after.running, outcome: after.running ? 'started' : 'failed', status: after,
        ...(after.running ? {} : { error: '启动后未观察到存活进程' }) };
    } catch (err) {
      return { ...base, ok: false, outcome: 'failed',
        error: err instanceof FleetError ? err.message : '服务操作失败；请检查目标服务日志（未输出原始异常）' };
    }
  }));
}

class FleetError extends Error {}
const WECOM_PREFIX = 'ai.wecom-channel-bridge.';

interface LaunchctlResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function launchctl(args: string[]): LaunchctlResult {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  // Never include launchctl's raw environment / arguments in diagnostics.
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}
function requireLaunchctl(args: string[]): void {
  const result = launchctl(args);
  if (!result.ok) throw new FleetError(`launchctl ${args[0]} 失败（exit=${result.status ?? 'unknown'}）`);
}
function validWeComLabel(label: string): boolean {
  return /^ai\.wecom-channel-bridge\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label);
}

/** `launchctl print` uses 113 for a service that is not loaded. A spawn
 * failure, timeout, permission error, or any other status is uncertainty and
 * must not be treated as permission to bootstrap a second service. */
function isMissingLaunchctlService(result: LaunchctlResult): boolean {
  return !result.ok && !result.error && result.status === 113;
}

export function selectWeComLabel(labels: string[], explicit?: string): string {
  if (explicit) {
    if (!validWeComLabel(explicit)) throw new FleetError('--wecom-service 必须是 ai.wecom-channel-bridge.* 服务名');
    return explicit;
  }
  const candidates = [...new Set(labels.filter(validWeComLabel))];
  if (candidates.length > 1) throw new FleetError('发现多个企业微信服务；请用 --wecom-service 明确指定，不自动选择');
  return candidates[0] ?? `${WECOM_PREFIX}bot`;
}

function discoverWeComLabel(explicit?: string): string {
  if (explicit) return selectWeComLabel([], explicit);
  const listed = launchctl(['list']);
  if (!listed.ok) throw new FleetError('无法列出当前用户服务；未尝试新建机器人连接');
  const loaded = listed.stdout.split('\n').map((line) => line.trim().split(/\s+/)[2] ?? '');
  const folder = join(homedir(), 'Library', 'LaunchAgents');
  const installed = existsSync(folder)
    ? readdirSync(folder).filter((name) => name.endsWith('.plist')).map((name) => name.slice(0, -6)) : [];
  return selectWeComLabel([...loaded, ...installed]);
}

function discoveryFailureService(label: string, error: unknown): FleetService {
  const message = error instanceof FleetError ? error.message : '无法确定企业微信服务；未尝试新建机器人连接';
  return {
    name: '企业微信',
    label,
    prepare: async () => { throw new FleetError(message); },
    inspect: () => { throw new FleetError(message); },
    start: async () => {},
  };
}

function plistField(file: string, key: string, format: 'raw' | 'json'): string {
  const result = spawnSync('/usr/bin/plutil', ['-extract', key, format, '-o', '-', file],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 });
  if (result.status !== 0 || result.error) throw new FleetError('无法读取目标 plist 的必要字段；未修改现有定义');
  return result.stdout.trim();
}

function canonicalPath(file: string): string | undefined {
  if (!isAbsolute(file) || !existsSync(file)) return undefined;
  try {
    const resolved = realpathSync(resolve(file));
    return lstatSync(resolved).isFile() ? resolved : undefined;
  }
  catch { return undefined; }
}

function samePath(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  try { return realpathSync(leftResolved) === realpathSync(rightResolved); }
  catch { return leftResolved === rightResolved; }
}

/**
 * The daemon can be invoked from a source checkout (`bin/*.mjs`) or directly
 * from a packed/built tree (`dist/{cli,wecom}.js`). Accept those exact package
 * paths, but never an unrelated file that merely has the same basename.
 */
function canonicalEntryPaths(kind: 'lark' | 'wecom'): string[] {
  const current = canonicalPath(process.argv[1] ?? '');
  if (!current) return [];
  const currentName = basename(current);
  const packageRoot = ['bin', 'dist'].includes(basename(dirname(current)))
    ? dirname(dirname(current)) : undefined;
  const candidates: string[] = [];
  const allowedCurrent = kind === 'lark'
    ? ['lark-channel-bridge', 'lark-channel-bridge.mjs', 'cli.js']
    : ['wecom-channel-bridge', 'wecom-channel-bridge.mjs', 'wecom.js'];
  if (allowedCurrent.includes(currentName)) candidates.push(current);
  if (packageRoot) {
    candidates.push(kind === 'lark'
      ? join(packageRoot, 'bin', 'lark-channel-bridge.mjs')
      : join(packageRoot, 'bin', 'wecom-channel-bridge.mjs'));
    candidates.push(kind === 'lark'
      ? join(packageRoot, 'dist', 'cli.js')
      : join(packageRoot, 'dist', 'wecom.js'));
  }
  return [...new Set(candidates.map(canonicalPath).filter((value): value is string => Boolean(value)))];
}

function assertWeComEnvReference(file: string, expectedEnvFile: string): void {
  let actual: string;
  try { actual = plistField(file, 'EnvironmentVariables.WECOM_ENV_FILE', 'raw'); }
  catch { throw new FleetError('无法读取目标企业微信 env 文件引用；未修改现有定义'); }
  const actualPath = canonicalPath(actual);
  const expectedPath = canonicalPath(resolve(expectedEnvFile));
  if (!actualPath || !expectedPath || actualPath !== expectedPath) {
    throw new FleetError('指定的 env 文件与已安装企业微信服务不同；未覆盖配置或重启，请单独完成配置变更');
  }
}

function assertWeComEnvReferenceExists(file: string): void {
  let actual: string;
  try { actual = plistField(file, 'EnvironmentVariables.WECOM_ENV_FILE', 'raw'); }
  catch { throw new FleetError('无法读取目标企业微信 env 文件引用；未修改现有定义'); }
  if (!canonicalPath(actual)) {
    throw new FleetError('目标企业微信 env 文件不存在或不是常规文件；未启动该定义');
  }
}

/** Refuse unrelated files, wrappers and the legacy extra-script-argument shape. */
function validateDefinition(file: string, label: string, kind: 'lark' | 'wecom', profile?: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new FleetError('服务定义必须是常规文件，不能是符号链接');
  if (plistField(file, 'Label', 'raw') !== label) throw new FleetError('服务定义的 Label 不匹配；未启动或覆盖该文件');
  let args: unknown;
  try { args = JSON.parse(plistField(file, 'ProgramArguments', 'json')); }
  catch { throw new FleetError('服务参数无效；请用单平台命令修复该定义'); }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new FleetError('服务参数必须是字符串数组');
  const argv = args as string[];
  const nodePath = canonicalPath(argv[0] ?? '');
  const expectedNodePath = canonicalPath(process.execPath);
  const entryPath = canonicalPath(argv[1] ?? '');
  const expectedEntryPaths = canonicalEntryPaths(kind);
  const valid = kind === 'lark'
    ? argv.length === 5 && expectedEntryPaths.includes(entryPath ?? '')
      && argv[2] === 'run' && argv[3] === '--profile' && argv[4] === profile
    : argv.length === 2 && expectedEntryPaths.includes(entryPath ?? '');
  if (!valid || nodePath === undefined || expectedNodePath === undefined || nodePath !== expectedNodePath) {
    throw new FleetError('服务参数不是 canonical 入口；请先单独修复，统一启动不会执行 shell 包装器');
  }
  if (kind === 'lark') {
    const configuredRoot = plistField(file, 'EnvironmentVariables.LARK_CHANNEL_HOME', 'raw');
    if (!isAbsolute(configuredRoot) || !samePath(configuredRoot, paths.rootDir)) {
      throw new FleetError('服务定义的 LARK_CHANNEL_HOME 与当前 profile 状态目录不同；未启动该定义');
    }
  } else {
    assertWeComEnvReferenceExists(file);
  }
}

export function buildWeComServicePlist(input: {
  label: string; node: string; entry: string; envFile: string; cwd: string; envPath: string; logDir: string;
  runtimePaths?: Partial<Record<'WECOM_WORKSPACE' | 'WECOM_STATE_DIR', string>>;
}): string {
  if (!validWeComLabel(input.label)) throw new FleetError('企业微信服务名无效');
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const string = (value: string) => `<string>${escape(value)}</string>`;
  const runtimePaths = (['WECOM_WORKSPACE', 'WECOM_STATE_DIR'] as const)
    .filter((key) => input.runtimePaths?.[key] !== undefined)
    .map((key) => `<key>${key}</key>${string(input.runtimePaths![key]!)}`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(input.label)}
<key>ProgramArguments</key><array>${string(input.node)}${string(input.entry)}</array>
<key>WorkingDirectory</key>${string(input.cwd)}
<key>EnvironmentVariables</key><dict><key>PATH</key>${string(input.envPath)}<key>WECOM_ENV_FILE</key>${string(input.envFile)}${runtimePaths}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key>${string(join(input.logDir, 'stdout.log'))}
<key>StandardErrorPath</key>${string(join(input.logDir, 'stderr.log'))}
</dict></plist>\n`;
}

function inspectJob(label: string, file: string): BotServiceState {
  const result = launchctl(['print', `gui/${userInfo().uid}/${label}`]);
  if (!result.ok && !isMissingLaunchctlService(result)) {
    throw new FleetError('无法查询目标服务状态；未假定服务不存在，也未尝试启动');
  }
  return { ...inspectLaunchdStatus(result.ok, result.stdout), persistent: existsSync(file),
    temporary: result.ok && /^\s*path = \(submitted by launchctl\[/m.test(result.stdout) };
}

async function startInstalledJob(label: string, file: string): Promise<void> {
  if (!existsSync(file)) throw new FleetError('缺少持久服务定义；企业微信首次启动请指定 --wecom-env-file');
  const domain = `gui/${userInfo().uid}`;
  requireLaunchctl(['enable', `${domain}/${label}`]);
  const result = launchctl(['bootstrap', domain, file]);
  // Concurrent identical start commands may race bootstrap; never kill the winner.
  if (!result.ok && !inspectJob(label, file).loaded) throw new FleetError('bootstrap 失败；未停止其他已运行服务');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = inspectJob(label, file);
    if (state.running) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
      const stable = inspectJob(label, file);
      if (stable.running && stable.pid === state.pid) return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new FleetError('服务已注册，但未观察到稳定存活进程；请查看该服务日志');
}

function makeServices(profile: string, wecomLabel: string, opts: FleetOptions): FleetService[] {
  const larkLabel = launchAgentLabel(profile);
  const larkFile = launchAgentPlistPath(profile);
  const wecomFile = join(homedir(), 'Library', 'LaunchAgents', `${wecomLabel}.plist`);
  return [{
    name: '飞书', label: larkLabel,
    prepare: async () => {
      if (!existsSync(larkFile)) throw new FleetError('飞书尚未配置后台服务；请先 start --profile <name>');
      validateDefinition(larkFile, larkLabel, 'lark', profile);
    },
    inspect: () => inspectJob(larkLabel, larkFile),
    start: () => startInstalledJob(larkLabel, larkFile),
  }, {
    name: '企业微信', label: wecomLabel,
    prepare: async () => {
      if (existsSync(wecomFile)) {
        validateDefinition(wecomFile, wecomLabel, 'wecom');
        const requestedEnvFile = opts.wecomEnvFile ?? process.env.WECOM_ENV_FILE;
        if (requestedEnvFile) assertWeComEnvReference(wecomFile, requestedEnvFile);
        return;
      }
      const envFileInput = opts.wecomEnvFile ?? process.env.WECOM_ENV_FILE;
      if (!envFileInput) {
        if (inspectJob(wecomLabel, wecomFile).running) return; // Preserve a legacy submitted job.
        throw new FleetError('企业微信首次启动需要 --wecom-env-file <现有配置文件>；不会猜测或复制凭证');
      }
      const envFile = realpathSync(resolve(envFileInput));
      if (!lstatSync(envFile).isFile()) throw new FleetError('企业微信 env 文件必须存在且为常规文件');
      const currentEntry = realpathSync(process.argv[1] ?? '');
      const entryName = basename(currentEntry);
      if (!['lark-channel-bridge', 'lark-channel-bridge.mjs', 'cli.js'].includes(entryName)) throw new FleetError('无法确认当前包的 CLI 入口');
      const entry = join(dirname(currentEntry), entryName === 'cli.js' ? 'wecom.js' : 'wecom-channel-bridge.mjs');
      if (!existsSync(entry)) throw new FleetError('缺少当前包的企业微信入口；请先构建项目');
      // Match a foreground invocation: relative env-file settings resolve
      // against the caller's working directory, never the package location.
      const cwd = process.cwd();
      const runtimePaths = Object.fromEntries(
        (['WECOM_WORKSPACE', 'WECOM_STATE_DIR'] as const)
          .filter((key) => Boolean(process.env[key]))
          .map((key) => [key, resolve(cwd, process.env[key]!)]),
      );
      const logDir = join(paths.rootDir, 'daemon', wecomLabel);
      const content = buildWeComServicePlist({ label: wecomLabel, node: process.execPath, entry,
        envFile, cwd, envPath: process.env.PATH ?? '', logDir, runtimePaths });
      mkdirSync(dirname(wecomFile), { recursive: true });
      mkdirSync(logDir, { recursive: true });
      try { writeFileSync(wecomFile, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
      validateDefinition(wecomFile, wecomLabel, 'wecom');
      // A concurrent start may have won the wx race with a different env
      // file. Validate the winner before allowing its job to be bootstrapped.
      assertWeComEnvReference(wecomFile, envFile);
      // Deliberately do not unload a legacy live job: the new definition is for next bootstrap.
    },
    inspect: () => inspectJob(wecomLabel, wecomFile),
    start: () => startInstalledJob(wecomLabel, wecomFile),
  }];
}

export async function runAllServices(action: 'start' | 'status', opts: FleetOptions): Promise<void> {
  if (process.platform !== 'darwin') throw new FleetError('--all 当前只支持 macOS；单平台命令保持原有跨平台支持');
  const root = opts.profile ? undefined : await loadRootConfig(paths.configFile);
  const profile = opts.profile ?? await readActiveProfile(paths.rootDir) ?? root?.activeProfile;
  if (!profile) throw new FleetError('请用 --profile 指定飞书 profile，或先配置 active profile');
  let wecomLabel = opts.wecomService ?? `${WECOM_PREFIX}unselected`;
  let wecomDiscoveryError: unknown;
  try {
    wecomLabel = discoverWeComLabel(opts.wecomService);
  } catch (err) {
    // Discovery is one platform's preparation step. Keep the Lark service's
    // independent failure boundary while reporting this invocation non-zero.
    wecomDiscoveryError = err;
  }
  const services = makeServices(profile, wecomLabel, opts);
  if (wecomDiscoveryError) services[1] = discoveryFailureService(wecomLabel, wecomDiscoveryError);
  const results = await controlBotFleet(action, services);
  for (const result of results) {
    const state = result.status;
    const running = state?.running;
    console.log(`${result.ok ? '✓' : '✗'} ${result.name}: ${!state ? '状态未确认' : running ? '进程运行中' : state.loaded ? '已加载但未运行' : '未运行'}  ${result.label}${state?.pid ? `  pid=${state.pid}` : ''}`);
    if (result.outcome === 'already-running') console.log('  已运行，未重复启动或重启。');
    if (state?.runs !== undefined) console.log(`  launchd runs=${state.runs}`);
    if (state?.temporary) console.log(state.persistent
      ? '  当前仍为临时 job；持久定义已就绪，下次卸载并启动后生效。'
      : '  当前为临时 job；用 --wecom-env-file 建立持久定义，否则退出登录后无法恢复。');
    if (result.error) console.log(`  ${result.error}`);
  }
  console.log('以上为进程状态，不等同于平台连接或真实消息收发验收。');
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}
