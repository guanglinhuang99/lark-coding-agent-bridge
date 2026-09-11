import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RiskDirectClient, type RiskDirectClientOptions } from './client';

export function resolveRiskIntentModel(env: Record<string, string | undefined>, legacyPrefix?: string): string {
  return env.RISK_INTENT_MODEL?.trim() ||
    (legacyPrefix ? env[`${legacyPrefix}_RISK_INTENT_MODEL`]?.trim() : undefined) || 'gpt-5.6-luna';
}

export interface RiskRuntimeConfig extends Omit<RiskDirectClientOptions, 'pythonPath'> {
  pythonPath?: string;
}

/** Bundled installations resolve beside the loaded JS, independently of the caller's cwd. */
export function resolveRiskBridgePath(rootDir: string, moduleUrl = import.meta.url,
  exists: (path: string) => boolean = existsSync): string {
  const packaged = fileURLToPath(new URL('./risk/direct_bridge.py', moduleUrl));
  return exists(packaged) ? packaged : resolve(rootDir, 'src/business/risk/direct_bridge.py');
}

/** Neutral settings win; an adapter can supply a legacy prefix during migration. */
export function readRiskRuntimeConfig(input: {
  env: NodeJS.ProcessEnv; rootDir: string; defaultStateDir: string; legacyPrefix?: string;
}): RiskRuntimeConfig {
  const get = (name: string): string | undefined => (
    input.env[`RISK_${name}`] ?? (input.legacyPrefix ? input.env[`${input.legacyPrefix}_RISK_${name}`] : undefined)
  )?.trim() || undefined;
  const integer = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid RISK_${name}`);
    return value;
  };
  return {
    pythonPath: get('PYTHON'),
    serviceDir: resolve(get('SERVICE_DIR') ?? join(input.rootDir, 'risk-service')),
    stateDir: resolve(get('STATE_DIR') ?? join(input.defaultStateDir, 'risk-service')),
    bridgePath: resolve(get('BRIDGE_PATH') ?? resolveRiskBridgePath(input.rootDir)),
    timeoutMs: integer('TIMEOUT_MS', 180_000),
    startupTimeoutMs: integer('STARTUP_TIMEOUT_MS', 30_000),
    workers: integer('DIRECT_WORKERS', 4),
    intranetHost: get('INTRANET_HOST') ?? '10.8.11.57',
    intranetPort: integer('INTRANET_PORT', 80),
    intranetTimeoutMs: integer('INTRANET_TIMEOUT_MS', 1500),
    intranetCacheTtlMs: integer('INTRANET_CACHE_TTL_MS', 60_000),
    productCacheTtlMs: integer('PRODUCT_CACHE_TTL_MS', 60 * 60_000),
  };
}

export function riskRuntimeAvailable(config: RiskRuntimeConfig): config is RiskRuntimeConfig & { pythonPath: string } {
  return Boolean(config.pythonPath && existsSync(config.pythonPath) &&
    existsSync(config.serviceDir) && existsSync(config.bridgePath));
}

export function createRiskRuntimeClient(config: RiskRuntimeConfig): RiskDirectClient | undefined {
  return riskRuntimeAvailable(config) ? new RiskDirectClient({ ...config, pythonPath: config.pythonPath }) : undefined;
}
