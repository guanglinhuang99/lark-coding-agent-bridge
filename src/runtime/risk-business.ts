import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexAdapter } from '../agent/codex/adapter';
import type { AgentAdapter, AgentRun, AgentEvent } from '../agent/types';
import type { ActiveRuns } from '../bridge/active-runs';
import type { ProcessPool } from '../bridge/process-pool';
import type { BridgeIdentity } from '../bridge/identity';
import { RunExecutor } from '../bridge/run-executor';
import { log, redactDiagnosticText, reportMetric } from '../core/logger';
import { RiskApplication, type RiskAnalyzerInput, type RiskApplicationOptions } from '../business/risk/application';
import { buildRiskIntentPrompt, type RiskAiDraft } from '../business/risk/intent';
import { collectRiskIntent } from '../business/risk/analyzer';
import type { RiskService, RiskDirectRuntimeStatus } from '../business/risk/client';
import { createRiskRuntimeClient, readRiskRuntimeConfig, resolveRiskIntentModel, type RiskRuntimeConfig } from '../business/risk/runtime';

export interface RiskRuntimeClient extends RiskService {
  prewarm(): Promise<void>;
  close(): Promise<void>;
  runtimeStatus(): RiskDirectRuntimeStatus;
}
export interface RiskIntentLifecycle {
  /** Optional transport bookkeeping only; it must never parse or execute business rules. */
  starting?(input: RiskAnalyzerInput): void;
  started?(input: RiskAnalyzerInput, run: AgentRun): (() => void) | void;
  settled?(input: RiskAnalyzerInput): void;
}
export interface RiskBusinessRuntimeOptions {
  identity: BridgeIdentity;
  stateDir: string;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  legacyPrefix?: string;
  accessEnabled?: () => boolean;
  invalidateSelections?: RiskApplicationOptions['invalidateSelections'];
  intentLifecycle?: RiskIntentLifecycle;
  /** Injected dependencies are used instead of creating a second runtime. */
  application?: RiskApplication;
  clientFactory?: (config: RiskRuntimeConfig) => RiskRuntimeClient | undefined;
  intentAgent?: AgentAdapter;
}
export interface RiskBusinessSnapshot {
  schema: 'risk-business-runtime/v1';
  enabled: boolean;
  accessEnabled: boolean;
  pythonConfigured: boolean;
  serviceDirConfigured: boolean;
  reason?: 'closed' | 'python-not-configured' | 'path-unavailable';
  runtime?: RiskDirectRuntimeStatus;
  warmup: { phase: 'idle' | 'running' | 'ready' | 'failed' | 'disabled' | 'closed'; durationMs?: number; products?: number };
  intent: { model: string; active: number };
}

/** The sole composition root for both channels. Construction performs no network or process work. */
export function createRiskBusinessRuntime(input: RiskBusinessRuntimeOptions) {
  const env = { ...(input.env ?? process.env) };
  const config = readRiskRuntimeConfig({ env, rootDir: input.rootDir ?? process.cwd(),
    defaultStateDir: input.stateDir, legacyPrefix: input.legacyPrefix });
  const value = (suffix: string) => env[`RISK_${suffix}`]?.trim() ||
    (input.legacyPrefix ? env[`${input.legacyPrefix}_RISK_${suffix}`]?.trim() : undefined);
  const positive = (suffix: string, fallback: number) => {
    const raw = value(suffix), number = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid RISK_${suffix}`);
    return number;
  };
  const prewarm = value('PREWARM');
  if (prewarm !== undefined && prewarm !== '0' && prewarm !== '1') throw new Error('Invalid RISK_PREWARM');
  const model = resolveRiskIntentModel(env, input.legacyPrefix);
  const intentTimeoutMs = positive('INTENT_TIMEOUT_MS', 180_000);
  const exitGraceMs = positive('INTENT_EXIT_GRACE_MS', 5_000);
  const channel = input.identity.channel;
  const safe = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
  const metric = (name: string, duration: number, fields: Record<string, string> = {}) => safe(() => {
    reportMetric(`risk_${name}`, duration, { ...fields, channel });
    // Compatibility output only: the measured operation and policy have one implementation.
    if (channel === 'wecom') reportMetric(`wecom_risk_${name}`, duration, fields);
  });
  const event = (name: string, fields: Record<string, unknown> = {}) =>
    safe(() => log.info('risk-runtime', name, { ...fields, channel }));
  const accessEnabled = () => safe(() => input.accessEnabled?.() === true) === true;
  const client = input.application ? undefined : (input.clientFactory ?? createRiskRuntimeClient)({
    ...config,
    onCall: ({ method, durationMs, outcome }) => {
      metric('call_ms', durationMs, { method, outcome }); metric('call_total', 1, { method, outcome });
      event('call', { method, durationMs, outcome });
    },
    onStage: ({ stage, durationMs, outcome }) => { metric('stage_ms', durationMs, { stage, outcome }); },
    onStartup: timings => {
      for (const [stage, durationMs] of Object.entries(timings)) metric('startup_ms', durationMs, { stage });
    },
    onBusinessCapabilities: capabilities => event('capabilities', { capabilities }),
    onDiagnostic: line => safe(() => log.warn('risk-runtime', 'python', { channel, message: redactDiagnosticText(line) })),
  });
  // Lazy extraction infrastructure: deterministic queries never prepare or launch an Agent.
  let executor: RunExecutor | undefined;
  const getExecutor = () => executor ??= new RunExecutor({
    agent: input.intentAgent ?? new CodexAdapter({ binary: env.CODEX_BINARY?.trim() || 'codex',
      profileStateDir: input.stateDir, inheritCodexHome: true, purpose: 'risk-intent', sandbox: 'read-only' }),
    pool: input.pool, activeRuns: input.activeRuns, postDoneExitGraceMs: exitGraceMs,
  });
  const workspace = join(input.stateDir, 'risk-intent-workspace');
  const shutdown = new AbortController();
  const analyses = new Set<Promise<RiskAiDraft>>();
  let warmup: RiskBusinessSnapshot['warmup'] = { phase: 'idle' };
  let warming: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  function analyze(request: RiskAnalyzerInput): Promise<RiskAiDraft> {
    const signal = AbortSignal.any([request.signal, shutdown.signal]);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const inputForRun = { ...request, signal: combined };
    const timeout = setTimeout(() => controller.abort(), intentTimeoutMs);
    timeout.unref?.();
    const startedAt = Date.now();
    let outputReported = false;
    let run: AgentRun | undefined;
    let cleanup: (() => void) | void = undefined;
    const ensureActive = () => {
      if (combined.aborted) { const error = new Error('Risk intent interrupted'); error.name = 'RiskIntentInterruptedError'; throw error; }
    };
    const operation = (async () => {
      try {
        ensureActive();
        safe(() => input.intentLifecycle?.starting?.(inputForRun));
        await mkdir(workspace, { recursive: true });
        ensureActive();
        const execution = await getExecutor().submit({
          scopeId: request.key, signal: combined, permit: input.pool.currentPermit(),
          policy: { prompt: buildRiskIntentPrompt(request.originalText, request.previous, request.correction),
            cwdRealpath: workspace, sandbox: 'read-only', expiresAt: startedAt + intentTimeoutMs, accessMode: 'risk-intent' },
          model, reasoningEffort: 'low',
          observability: { profile: input.identity.instanceId, agent: 'codex', source: channel, stage: 'risk-intent' },
        });
        run = { runId: execution.runId, events: execution.subscribe(), stop: () => execution.stop(),
          waitForExit: ms => execution.run.waitForExit(ms) };
        ensureActive();
        cleanup = safe(() => input.intentLifecycle?.started?.(inputForRun, run!));
        const onEvent = (item: AgentEvent) => {
          if (!outputReported && ((item.type === 'text' && item.delta) || (item.type === 'final_text' && item.content))) {
            outputReported = true; metric('intent_ttft_ms', Date.now() - startedAt, { model });
          }
          if (item.type === 'usage') {
            const fields = { inputTokens: item.inputTokens, cachedInputTokens: item.cachedInputTokens,
              outputTokens: item.outputTokens, reasoningOutputTokens: item.reasoningOutputTokens };
            for (const [name, count] of Object.entries(fields)) if (count !== undefined) metric(`intent_${name}`, count, { model });
          }
        };
        const draft = await collectRiskIntent(run, { originalText: request.originalText,
          correction: request.correction, signal: combined, onEvent });
        ensureActive();
        metric('intent_ms', Date.now() - startedAt, { model, outcome: 'ok' });
        return draft;
      } catch (error) {
        metric('intent_ms', Date.now() - startedAt, { model, outcome: combined.aborted ? 'interrupted' : 'failed' });
        await run?.stop().catch(() => {});
        ensureActive();
        throw error;
      } finally {
        clearTimeout(timeout);
        if (cleanup) safe(cleanup);
        safe(() => input.intentLifecycle?.settled?.(inputForRun));
      }
    })();
    analyses.add(operation);
    void operation.then(() => analyses.delete(operation), () => analyses.delete(operation));
    return operation;
  }

  const application = input.application ?? new RiskApplication({ service: client, analyze,
    invalidateSelections: input.invalidateSelections });
  function snapshot(): RiskBusinessSnapshot {
    return {
      schema: 'risk-business-runtime/v1', enabled: Boolean(client) && !shutdown.signal.aborted,
      accessEnabled: accessEnabled(), pythonConfigured: Boolean(config.pythonPath),
      serviceDirConfigured: Boolean(value('SERVICE_DIR')),
      ...(!client || shutdown.signal.aborted ? { reason: shutdown.signal.aborted ? 'closed' as const
        : !config.pythonPath ? 'python-not-configured' as const : 'path-unavailable' as const } : {}),
      ...(client ? { runtime: shutdown.signal.aborted ? { ready: false } : client.runtimeStatus() } : {}),
      warmup: { ...warmup }, intent: { model, active: analyses.size },
    };
  }
  function start(): Promise<void> {
    if (shutdown.signal.aborted) return Promise.resolve();
    if (!client || !accessEnabled() || prewarm === '0') {
      if (!warming) warmup = { phase: 'disabled' };
      return Promise.resolve();
    }
    if (warming) return warming;
    const startedAt = Date.now();
    warmup = { phase: 'running' };
    warming = Promise.resolve().then(async () => {
      if (shutdown.signal.aborted || !accessEnabled()) return;
      await client.prewarm();
      if (shutdown.signal.aborted || !accessEnabled()) return;
      const products = await client.listProducts();
      if (shutdown.signal.aborted || !accessEnabled()) return;
      const durationMs = Date.now() - startedAt;
      warmup = { phase: 'ready', durationMs, products: products.length };
      metric('warmup_ms', durationMs, { outcome: 'success' }); event('warmup-ready', warmup);
    }).catch(() => {
      if (shutdown.signal.aborted) return;
      const durationMs = Date.now() - startedAt;
      warmup = { phase: 'failed', durationMs };
      metric('warmup_ms', durationMs, { outcome: 'error' }); event('warmup-failed', warmup);
    }).finally(() => {
      warming = undefined;
      if (!shutdown.signal.aborted && !accessEnabled()) warmup = { phase: 'disabled' };
    });
    return warming;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    shutdown.abort();
    warmup = { phase: 'closed' };
    // Close the client while draining applications, not afterwards: pending calls need rejection.
    closing = Promise.allSettled([application.close(), Promise.resolve().then(() => client?.close()),
      warming, ...analyses]).then(results => {
        // Application/client cleanup failures are operational errors, not warmup failures.
        const failure = results.slice(0, 2).find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      });
    return closing;
  }
  return { application, client, config, snapshot, start, close, analyze };
}
export type RiskBusinessRuntime = ReturnType<typeof createRiskBusinessRuntime>;
