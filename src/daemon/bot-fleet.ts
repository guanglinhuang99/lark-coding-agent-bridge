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

function launchctl(args: string[]): { ok: boolean; status: number | null; stdout: string } {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  // Never include launchctl's raw environment / arguments in diagnostics.
  return { ok: result.status === 0 && !result.error, status: result.status, stdout: result.stdout ?? '' };
}
function requireLaunchctl(args: string[]): void {
  const result = launchctl(args);
  if (!result.ok) throw new FleetError(`launchctl ${args[0]} 失败（exit=${result.status ?? 'unknown'}）`);
}
function validWeComLabel(label: string): boolean {
  return /^ai\.wecom-channel-bridge\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label);
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

function plistField(file: string, key: string, format: 'raw' | 'json'): string {
  const result = spawnSync('/usr/bin/plutil', ['-extract', key, format, '-o', '-', file],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 });
  if (result.status !== 0 || result.error) throw new FleetError('无法读取目标 plist 的必要字段；未修改现有定义');
  return result.stdout.trim();
}

/** Refuse unrelated files, wrappers and the legacy extra-script-argument shape. */
function validateDefinition(file: string, label: string, kind: 'lark' | 'wecom', profile?: string): void {
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new FleetError('服务定义必须是常规文件，不能是符号链接');
  if (plistField(file, 'Label', 'raw') !== label) throw new FleetError('服务定义的 Label 不匹配；未启动或覆盖该文件');
  let args: unknown;
  try { args = JSON.parse(plistField(file, 'ProgramArguments', 'json')); }
  catch { throw new FleetError('服务参数无效；请用单平台命令修复该定义'); }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new FleetError('服务参数必须是字符串数组');
  const argv = args as string[];
  const entry = basename(argv[1] ?? '');
  const valid = kind === 'lark'
    ? argv.length === 5 && ['lark-channel-bridge', 'lark-channel-bridge.mjs', 'cli.js'].includes(entry)
      && argv[2] === 'run' && argv[3] === '--profile' && argv[4] === profile
    : argv.length === 2 && ['wecom-channel-bridge', 'wecom-channel-bridge.mjs', 'wecom.js'].includes(entry);
  if (!valid || basename(argv[0] ?? '') !== 'node' || !argv.slice(0, 2).every(isAbsolute) || !argv.slice(0, 2).every(existsSync)) {
    throw new FleetError('服务参数不是 canonical 入口；请先单独修复，统一启动不会执行 shell 包装器');
  }
}

export function buildWeComServicePlist(input: {
  label: string; node: string; entry: string; envFile: string; cwd: string; envPath: string; logDir: string;
}): string {
  if (!validWeComLabel(input.label)) throw new FleetError('企业微信服务名无效');
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const string = (value: string) => `<string>${escape(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(input.label)}
<key>ProgramArguments</key><array>${string(input.node)}${string(input.entry)}</array>
<key>WorkingDirectory</key>${string(input.cwd)}
<key>EnvironmentVariables</key><dict><key>PATH</key>${string(input.envPath)}<key>WECOM_ENV_FILE</key>${string(input.envFile)}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key>${string(join(input.logDir, 'stdout.log'))}
<key>StandardErrorPath</key>${string(join(input.logDir, 'stderr.log'))}
</dict></plist>\n`;
}

function inspectJob(label: string, file: string): BotServiceState {
  const result = launchctl(['print', `gui/${userInfo().uid}/${label}`]);
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
        if (opts.wecomEnvFile) {
          const existing = plistField(wecomFile, 'EnvironmentVariables.WECOM_ENV_FILE', 'raw');
          if (realpathSync(resolve(opts.wecomEnvFile)) !== realpathSync(existing)) {
            throw new FleetError('指定的 env 文件与已安装企业微信服务不同；未覆盖配置或重启，请单独完成配置变更');
          }
        }
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
      const cwd = resolve(dirname(currentEntry), '..');
      const logDir = join(paths.rootDir, 'daemon', wecomLabel);
      const content = buildWeComServicePlist({ label: wecomLabel, node: process.execPath, entry,
        envFile, cwd, envPath: process.env.PATH ?? '', logDir });
      mkdirSync(dirname(wecomFile), { recursive: true });
      mkdirSync(logDir, { recursive: true });
      try { writeFileSync(wecomFile, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
      validateDefinition(wecomFile, wecomLabel, 'wecom');
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
  const wecomLabel = discoverWeComLabel(opts.wecomService);
  const results = await controlBotFleet(action, makeServices(profile, wecomLabel, opts));
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
