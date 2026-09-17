import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RiskMcpClient, type RiskMcpClientOptions } from './mcp-client';
import { StdioMcpSession } from './stdio-mcp';

export function resolveRiskIntentModel(env: Record<string, string | undefined>, legacyPrefix?: string): string {
  return env.RISK_INTENT_MODEL?.trim() ||
    (legacyPrefix ? env[`${legacyPrefix}_RISK_INTENT_MODEL`]?.trim() : undefined) || 'gpt-5.6-luna';
}

export interface RiskRuntimeConfig extends Omit<RiskMcpClientOptions, 'url' | 'requestHandler' | 'closeHandler'> {
  mode: 'remote' | 'local';
  url?: string;
  pythonPath?: string;
  serviceDir: string;
  launcherPath: string;
}

export function resolveRiskMcpLauncher(rootDir: string, moduleUrl = import.meta.url,
  exists: (path: string) => boolean = existsSync): string {
  const packaged = fileURLToPath(new URL('./risk/stdio_server.py', moduleUrl));
  return exists(packaged) ? packaged : resolve(rootDir, 'src/business/risk/stdio_server.py');
}

/** Neutral settings win; an adapter can supply a legacy prefix during migration. */
export function readRiskRuntimeConfig(input: {
  env: NodeJS.ProcessEnv; rootDir: string; defaultStateDir: string; legacyPrefix?: string;
}): RiskRuntimeConfig {
  const get = (name: string): string | undefined =>
    input.env[`RISK_${name}`]?.trim() ||
    (input.legacyPrefix ? input.env[`${input.legacyPrefix}_RISK_${name}`]?.trim() : undefined) || undefined;
  const integer = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid RISK_${name}`);
    return value;
  };
  const rawMode = get('MCP_MODE') ?? 'local';
  if (rawMode !== 'remote' && rawMode !== 'local') throw new Error('Invalid RISK_MCP_MODE');
  return {
    mode: rawMode,
    url: get('MCP_URL'),
    authorization: get('MCP_AUTH'),
    pythonPath: get('MCP_PYTHON') ?? get('PYTHON'),
    serviceDir: resolve(get('SERVICE_DIR') ?? join(input.rootDir, 'risk-service')),
    launcherPath: resolve(get('MCP_STDIO_LAUNCHER') ?? resolveRiskMcpLauncher(input.rootDir)),
    timeoutMs: integer('TIMEOUT_MS', 180_000),
    pollIntervalMs: integer('MCP_POLL_INTERVAL_MS', 1_000),
    productCacheTtlMs: integer('PRODUCT_CACHE_TTL_MS', 60 * 60_000),
  };
}

export function riskRuntimeAvailable(config: RiskRuntimeConfig): boolean {
  return config.mode === 'remote'
    ? Boolean(config.url)
    : Boolean(config.pythonPath && existsSync(config.pythonPath) && existsSync(config.serviceDir) && existsSync(config.launcherPath));
}

export function createRiskRuntimeClient(config: RiskRuntimeConfig): RiskMcpClient | undefined {
  if (!riskRuntimeAvailable(config)) return undefined;
  if (config.mode === 'remote') return new RiskMcpClient({ ...config, url: config.url! });
  const session = new StdioMcpSession({
    pythonPath: config.pythonPath!, serviceDir: config.serviceDir, launcherPath: config.launcherPath,
    timeoutMs: config.timeoutMs,
  });
  return new RiskMcpClient({
    ...config,
    endpointLabel: 'local-stdio',
    requestHandler: (method, params) => session.request(method, params),
    closeHandler: () => session.close(),
  });
}
