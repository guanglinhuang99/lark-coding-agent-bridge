#!/usr/bin/env node

/**
 * Real-AI intent safety guard.
 *
 * This entry point deliberately stops after resolveInitialRiskIntent.  It
 * uses the selected checkout bundle, CodexAdapter, the real read-only
 * RiskDirectClient list/search methods, and the source parser/normalizer.  It
 * never constructs a router or calls calculatePretrade.
 */

import { access, constants, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = '/Users/guanglin/Sync/wecom-bot';
const FIXED = {
  before: {
    commit: 'f00d635b36536dccac7ebeb73235e7dcf584d49b',
    root: '/private/tmp/wecom-live-20260908/before',
    bundle: '/private/tmp/wecom-live-20260908/ai-functional-live-1/before-client.mjs',
    bridge: '/private/tmp/wecom-live-20260908/before/src/wecom/risk/direct_bridge.py',
  },
  after: {
    commit: '6d28a6a673b3d400f3d30e15018b5a5621d545cf',
    root: '/private/tmp/wecom-live-20260908/after',
    bundle: '/private/tmp/wecom-live-20260908/ai-functional-live-1/after-client.mjs',
    bridge: '/private/tmp/wecom-live-20260908/after/src/wecom/risk/direct_bridge.py',
  },
};

const REQUIRED_CASES = new Set([
  'negative-amount',
  'zero-amount',
  'ambiguous-amount',
  'missing-amount',
  'chinese-amount',
]);
const SEMANTICS = new Set(REQUIRED_CASES);
const AMOUNT_UNITS = '(?:亿元|万元|亿|万|元|块|股|手|张|份)';
const FULL_NUMERIC_AMOUNT_RE = new RegExp(`^\\d+(?:\\.\\d+)?\\s*${AMOUNT_UNITS}?$`, 'u');
const NUMERIC_AMOUNT_TOKEN_RE = new RegExp(`\\d+(?:\\.\\d+)?\\s*${AMOUNT_UNITS}`, 'u');
const CHINESE_AMOUNT_TOKEN_RE = /[零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟萬]+\s*(?:亿元|万元|亿|万|元|块|股|手|张|份)/u;
const EXECUTABLE_AMOUNT_RE = new RegExp(`^\\d+(?:\\.\\d+)?\\s*${AMOUNT_UNITS}?$`, 'u');
const ALLOWED_BUNDLE_EXPORTS = [
  'CodexAdapter',
  'RunExecutor',
  'ProcessPool',
  'ActiveRuns',
  'RiskDirectClient',
  'extractAmount',
  'startWeComAgentRun',
  'buildRiskIntentPrompt',
  'parseRiskIntentOutputPartial',
  'normalizeRiskDraft',
];
const FORBIDDEN_INHERITED_ENV = [
  'POST_TRADE_HISTORY_DB',
  'PORTFOLIO_MARKET_CACHE',
  'PINS_CACHE_DIR',
  'PINS_DATA_DIR',
];

class GuardError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'GuardError';
    this.code = code;
    this.cause = cause;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hashText(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hashValue(value) {
  return hashText(JSON.stringify(canonical(value)));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (!token?.startsWith('--')) throw new GuardError('unexpected-argument');
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!key || !next || next.startsWith('--')) throw new GuardError(`missing-value:${key}`);
    args[key] = next;
    index += 1;
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node risk-live-ai-guards.mjs --cases /absolute/private-cases.json --out /absolute/new-output [options]',
    '',
    'Required in --config or as flags: --model --binary --cwd --python --service --before-home --after-home.',
    'Optional fixed defaults: --before-bundle/--after-bundle and --before-bridge/--after-bridge.',
    'The cases file and output directory must be outside the repository and the output must not exist.',
  ].join('\n');
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new GuardError('json-read-failed', error);
  }
}

function stringField(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new GuardError(`missing-field:${name}`);
  return value.trim();
}

function positiveNumber(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new GuardError(`invalid-number:${name}`);
  return number;
}

function configValue(flags, fileConfig, key, ...aliases) {
  for (const name of [key, ...aliases]) {
    if (flags[name] !== undefined) return flags[name];
    if (fileConfig[name] !== undefined) return fileConfig[name];
  }
  return undefined;
}

function resolveConfig(flags, fileConfig) {
  const bridges = fileConfig.bridges ?? {};
  const bundles = fileConfig.bundles ?? {};
  const homes = fileConfig.codexHomes ?? fileConfig.homes ?? {};
  const config = {
    model: configValue(flags, fileConfig, 'model'),
    binary: configValue(flags, fileConfig, 'binary'),
    cwd: configValue(flags, fileConfig, 'cwd'),
    python: configValue(flags, fileConfig, 'python', 'pythonPath'),
    serviceDir: configValue(flags, fileConfig, 'service', 'serviceDir'),
    beforeRoot: flags['before-root'] ?? fileConfig.beforeRoot ?? FIXED.before.root,
    afterRoot: flags['after-root'] ?? fileConfig.afterRoot ?? FIXED.after.root,
    beforeHome: flags['before-home'] ?? homes.before,
    afterHome: flags['after-home'] ?? homes.after,
    beforeBundle: flags['before-bundle'] ?? bundles.before ?? FIXED.before.bundle,
    afterBundle: flags['after-bundle'] ?? bundles.after ?? FIXED.after.bundle,
    beforeBridge: flags['before-bridge'] ?? bridges.before ?? FIXED.before.bridge,
    afterBridge: flags['after-bridge'] ?? bridges.after ?? FIXED.after.bridge,
    aiTimeoutMs: positiveNumber(flags['ai-timeout-ms'] ?? fileConfig.aiTimeoutMs ?? fileConfig.timeoutMs, 'ai-timeout-ms', 180_000),
    serviceTimeoutMs: positiveNumber(flags['service-timeout-ms'] ?? fileConfig.serviceTimeoutMs ?? fileConfig.timeoutMs, 'service-timeout-ms', 180_000),
    startupTimeoutMs: positiveNumber(flags['startup-timeout-ms'] ?? fileConfig.startupTimeoutMs, 'startup-timeout-ms', 30_000),
    queueTimeoutMs: positiveNumber(flags['queue-timeout-ms'] ?? fileConfig.queueTimeoutMs, 'queue-timeout-ms', 180_000),
    stopGraceMs: positiveNumber(flags['stop-grace-ms'] ?? fileConfig.stopGraceMs, 'stop-grace-ms', 5_000),
  };
  for (const [key, value] of Object.entries(config)) {
    if (['aiTimeoutMs', 'serviceTimeoutMs', 'startupTimeoutMs', 'queueTimeoutMs', 'stopGraceMs'].includes(key)) continue;
    if (typeof value !== 'string' || !value.trim()) throw new GuardError(`missing-config:${key}`);
  }
  return config;
}

function rejectInheritedStateEnv() {
  for (const name of FORBIDDEN_INHERITED_ENV) {
    if (process.env[name]) throw new GuardError(`forbidden-inherited-env:${name}`);
  }
}

function ensureAbsolute(value, name) {
  if (!isAbsolute(value)) throw new GuardError(`path-not-absolute:${name}`);
  return resolve(value);
}

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function existing(path, name, executable = false) {
  try {
    await stat(path);
    await access(path, executable ? constants.X_OK : constants.F_OK);
  } catch (error) {
    throw new GuardError(`path-unavailable:${name}`, error);
  }
}

async function fileDigest(path, name) {
  await existing(path, name);
  return hashText(await readFile(path));
}

async function verifyFixedSource(root, version) {
  try {
    const headResult = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']);
    const head = String(headResult.stdout).trim();
    if (head !== FIXED[version].commit) throw new GuardError(`fixed-head-mismatch:${version}`);
    const diffResult = await execFileAsync('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'src']);
    if (String(diffResult.stdout).trim()) throw new GuardError(`fixed-src-dirty:${version}`);
    return { root, head, srcDirty: false };
  } catch (error) {
    if (error instanceof GuardError) throw error;
    throw new GuardError(`fixed-source-check-failed:${version}`, error);
  }
}

function classifyOriginalAmount(text) {
  const value = String(text);
  if (/(?:^|[^\d])[-−]\s*\d+(?:\.\d+)?\s*(?:亿元|万元|亿|万|元|块|股|手|张|份)/u.test(value) || /负\s*[零〇一二两三四五六七八九十百千万\d]/u.test(value)) {
    return 'negative-amount';
  }
  if (/\d+(?:\.\d+)?\s*(?:亿元|万元|亿|万|元|块|股|手|张|份)\s*(?:或|或者|至|到|~|～|-)\s*\d/u.test(value)) {
    return 'ambiguous-amount';
  }
  if (/(?:^|[^\d])0(?:\.0+)?\s*(?:亿元|万元|亿|万|元|块|股|手|张|份)/u.test(value)) {
    return 'zero-amount';
  }
  if (CHINESE_AMOUNT_TOKEN_RE.test(value)) return 'chinese-amount';
  if (NUMERIC_AMOUNT_TOKEN_RE.test(value)) return 'other';
  return 'missing-amount';
}

function classifyAmountText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { kind: 'missing', executable: false, parsedKind: null };
  if (/^(?:[-−]\s*|负\s*)\d+(?:\.\d+)?\s*(?:亿元|万元|亿|万|元|块|股|手|张|份)?$/u.test(text)) {
    return { kind: 'negative', executable: false, parsedKind: null };
  }
  if (/\d+(?:\.\d+)?\s*(?:亿元|万元|亿|万|元|块|股|手|张|份)?\s*(?:或|或者|至|到|~|～|-)\s*\d/u.test(text)) {
    return { kind: 'ambiguous', executable: false, parsedKind: null };
  }
  if (FULL_NUMERIC_AMOUNT_RE.test(text)) {
    const numeric = Number(text.replace(/\s*(?:亿元|万元|亿|万|元|块|股|手|张|份)$/u, ''));
    if (numeric === 0) return { kind: 'zero', executable: false, parsedKind: null };
    if (numeric > 0) return { kind: 'positive', executable: true, parsedKind: 'unknown' };
    return { kind: 'negative', executable: false, parsedKind: null };
  }
  if (CHINESE_AMOUNT_TOKEN_RE.test(text)) return { kind: 'chinese-nonnumeric', executable: false, parsedKind: null };
  return { kind: 'invalid-nonnumeric', executable: false, parsedKind: null };
}

function isExecutableAmount(api, value) {
  if (typeof value !== 'string' || !EXECUTABLE_AMOUNT_RE.test(value.trim())) return { executable: false, parsedKind: null, value: null };
  try {
    const parsed = api.extractAmount(value.trim());
    if (!parsed) return { executable: false, parsedKind: null, value: null };
    const amount = parsed.amount ?? parsed.quantity;
    return {
      executable: Number.isFinite(amount) && amount > 0,
      parsedKind: parsed.amount !== undefined ? 'amount' : parsed.quantity !== undefined ? 'quantity' : null,
      value: Number.isFinite(amount) ? amount : null,
    };
  } catch {
    return { executable: false, parsedKind: null, value: null };
  }
}

function summarizeDraft(draft) {
  const value = draft && typeof draft === 'object' ? draft : {};
  return {
    fieldPresence: {
      accountQuery: Boolean(value.accountQuery),
      action: Boolean(value.action),
      securityQuery: Boolean(value.securityQuery),
      amountText: Boolean(value.amountText),
      days: value.days !== undefined && value.days !== null,
      market: Boolean(value.market),
    },
    action: typeof value.action === 'string' ? value.action : null,
    market: value.market === 'primary' || value.market === 'secondary' ? value.market : null,
    days: Number.isFinite(value.days) ? value.days : null,
    fieldHashes: {
      accountQuery: value.accountQuery ? hashText(value.accountQuery) : null,
      securityQuery: value.securityQuery ? hashText(value.securityQuery) : null,
      amountText: value.amountText ? hashText(value.amountText) : null,
    },
    draftHash: hashValue({
      accountQuery: value.accountQuery ?? null,
      action: value.action ?? null,
      securityQuery: value.securityQuery ?? null,
      amountText: value.amountText ?? null,
      days: value.days ?? null,
      market: value.market ?? null,
    }),
  };
}

function summarizeState(state) {
  const value = state && typeof state === 'object' ? state : {};
  const security = value.security && typeof value.security === 'object' ? value.security : null;
  const candidateCount = value.stage === 'account'
    ? value.products?.length ?? 0
    : value.stage === 'security'
      ? value.securities?.length ?? 0
      : null;
  const result = {
    stage: typeof value.stage === 'string' ? value.stage : 'unknown',
    field: value.stage === 'freeform' && typeof value.field === 'string' ? value.field : null,
    productPresent: Boolean(value.product),
    productHash: value.product ? hashText(value.product) : null,
    securityPresent: Boolean(security),
    securityHashes: security ? {
      name: security.name ? hashText(security.name) : null,
      code: security.code ? hashText(security.code) : null,
    } : null,
    candidateCount,
    draft: summarizeDraft(value.draft),
  };
  return { ...result, stateHash: hashValue(result) };
}

function classifyError(error) {
  if (error instanceof GuardError) return error.code;
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (/direct-timeout|direct-process|direct-capacity|risk-service/i.test(code)) return `backend-${code}`;
  if (/ENOENT|EACCES|EPERM/.test(code)) return 'path-or-permission-error';
  return 'harness-error';
}

function methodCounts(calls) {
  const counts = {};
  for (const call of calls) counts[call.method] = (counts[call.method] ?? 0) + 1;
  return counts;
}

function sanitizedCall(call) {
  return {
    method: typeof call.method === 'string' ? call.method : 'unknown',
    durationMs: Number.isFinite(call.durationMs) ? call.durationMs : null,
    outcome: typeof call.outcome === 'string' ? call.outcome : 'unknown',
  };
}

function stopBounded(run, timeoutMs) {
  const stopPromise = Promise.resolve().then(() => run.stop()).catch(() => undefined);
  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(resolvePromise, timeoutMs);
  });
  return Promise.race([stopPromise, timeout]).finally(() => clearTimeout(timer));
}

async function analyzeWithRealAi(api, executor, config, testCase, aiMetrics) {
  const startedAt = performance.now();
  const prompt = api.buildRiskIntentPrompt(testCase.text);
  const entry = {
    promptHash: hashText(prompt),
    outputHash: null,
    outputChars: null,
    draftHash: null,
    eventTypes: [],
    terminalType: null,
    exitObserved: null,
    durationMs: null,
    errorCategory: null,
  };
  aiMetrics.calls += 1;
  let run;
  let terminalSeen = false;
  let output = '';
  try {
    run = await api.startWeComAgentRun(
      executor,
      {
        runId: `risk-ai-guard-${testCase.caseId}-${Date.now()}`,
        prompt,
        cwd: config.cwd,
        model: config.model,
        sandbox: 'read-only',
      },
      `risk-ai-guard-${testCase.caseId}`,
    );
    const consume = (async () => {
      for await (const event of run.events) {
        entry.eventTypes.push(event.type);
        if (event.type === 'text') output += event.delta ?? '';
        else if (event.type === 'final_text') output = event.content ?? output;
        else if (event.type === 'done' || event.type === 'error') {
          entry.terminalType = event.type;
          terminalSeen = true;
          if (event.type === 'error') throw new GuardError('ai-run-error');
        }
      }
      return output;
    })();
    let timer;
    const watchdog = new Promise((resolvePromise) => {
      timer = setTimeout(() => resolvePromise({ kind: 'timeout' }), config.aiTimeoutMs);
    });
    const result = await Promise.race([
      consume.then((value) => ({ kind: 'events', value }), (error) => ({ kind: 'error', error })),
      watchdog,
    ]);
    clearTimeout(timer);
    if (result.kind === 'timeout') {
      entry.errorCategory = 'ai-timeout';
      await stopBounded(run, config.stopGraceMs);
      // The watchdog must return even if an adapter iterator never closes.
      // The already-attached rejection handler prevents an unhandled promise.
      void consume.catch(() => undefined);
      throw new GuardError('ai-timeout');
    }
    if (result.kind === 'error') {
      throw result.error;
    }
    output = result.value;
    entry.outputHash = hashText(output);
    entry.outputChars = output.length;
    const exited = await run.waitForExit(1500).catch(() => false);
    entry.exitObserved = Boolean(exited);
    if (!exited) {
      entry.errorCategory = 'ai-exit-timeout';
      await stopBounded(run, config.stopGraceMs);
      throw new GuardError('ai-exit-timeout');
    }
    if (!output.trim()) throw new GuardError('ai-empty-output');
    let draft;
    try {
      draft = api.parseRiskIntentOutputPartial(output, testCase.text);
    } catch (error) {
      entry.errorCategory = 'ai-invalid-output';
      throw new GuardError('ai-invalid-output', error);
    }
    entry.draftHash = summarizeDraft(draft).draftHash;
    return draft;
  } catch (error) {
    entry.errorCategory ??= classifyError(error);
    throw error;
  } finally {
    if (entry.outputHash === null && output) {
      entry.outputHash = hashText(output);
      entry.outputChars = output.length;
    }
    if (run && (!terminalSeen || entry.terminalType === 'error')) await stopBounded(run, config.stopGraceMs);
    entry.durationMs = performance.now() - startedAt;
    aiMetrics.durationMs += entry.durationMs;
    aiMetrics.entries.push(entry);
  }
}

function assessGuard(api, testCase, state, trace, directParserAccepted) {
  const normalized = summarizeState(state);
  const draft = state?.draft ?? {};
  const amount = classifyAmountText(draft.amountText);
  const executable = isExecutableAmount(api, draft.amountText);
  const chineseCorrect = testCase.semantic === 'chinese-amount' &&
    executable.executable && testCase.expectedAmount !== null &&
    executable.value === testCase.expectedAmount;
  const semanticConflict = executable.executable && SEMANTICS.has(testCase.semantic) && !chineseCorrect;
  const needsSecurity = draft.action === 'buy' || draft.action === 'sell' ||
    (draft.action === 'subscription' && draft.market === 'primary');
  const masterDataAvailable = trace.productMatch === true && (!state.product || state.product===testCase.expectedProduct) && (!state.security || state.security.code===testCase.expectedSecurityCode) && (
    state.stage !== 'confirm' || !needsSecurity || trace.expectedSecurityMatch
  );
  let status = 'safe-no-confirm';
  let safety = 'safe';
  if (directParserAccepted) {
    status = 'direct-parser-accepted-invalid-input';
    safety = 'inconclusive';
  } else if (!masterDataAvailable) {
    status = 'master-data-mismatch';
    safety = 'inconclusive';
  } else if (state.stage === 'confirm' && semanticConflict) {
    status = 'unsafe-executable-confirm';
    safety = 'unsafe';
  } else if (state.stage === 'confirm' && chineseCorrect) {
    status = 'safe-correct-chinese-normalization';
    safety = 'safe';
  } else if (state.stage === 'confirm' && !executable.executable) {
    status = 'risk-observed-invalid-confirmation';
    safety = 'risk-observed';
  } else if (semanticConflict) {
    status = 'blocked-positive-draft-before-confirm';
    safety = 'risk-observed';
  } else if (state.stage === 'confirm') {
    status = 'confirm-without-invalid-semantic-conflict';
    safety = 'inconclusive';
  }
  return {
    status,
    safety,
    normalized,
    amount: {
      originalSemantic: testCase.semantic,
      aiAmountClass: amount.kind,
      executable: executable.executable,
      parsedKind: executable.parsedKind,
      parsedValue: executable.value,
      expectedAmount: testCase.expectedAmount,
      chineseCorrect,
      semanticConflict,
    },
    directParserAccepted,
    masterDataAvailable,
    routeObservation: state.stage === 'confirm'
      ? executable.executable
        ? 'after-executeConfirmed-amount-check-would-pass'
        : 'after-executeConfirmed-amount-check-would-reject-invalid-amount'
      : 'no-confirmation-route-entered',
    disposition: state.stage === 'confirm' && chineseCorrect
      ? 'Chinese amount normalized to the declared positive value; no confirmation or calculation invoked'
      : state.stage === 'confirm' && !executable.executable
        ? 'retain-invalid-confirmation-for-user-correction; no route or calculation invoked'
        : state.stage === 'confirm' && executable.executable
          ? 'would-be-executable; guard fails closed before confirmation'
          : 'no executable confirmation observed',
  };
}

function createObservedService(api, config, stateDir, getActiveTrace) {
  const client = new api.RiskDirectClient({
    pythonPath: config.python,
    serviceDir: config.serviceDir,
    stateDir,
    bridgePath: config.currentBridge,
    timeoutMs: config.serviceTimeoutMs,
    startupTimeoutMs: config.startupTimeoutMs,
    workers: 1,
  });
  // RiskDirectClientOptions has no onCall hook in the fixed source.  Its
  // private TypeScript method is still a normal JavaScript method; wrapping
  // the instance records the actual JSONL client call without changing its
  // arguments or return value.
  const originalCall = client.call.bind(client);
  client.call = async (method, args, onProgress, timeoutMs) => {
    const startedAt = performance.now();
    try {
      const result = await originalCall(method, args, onProgress, timeoutMs);
      const trace = getActiveTrace();
      trace?.backendCalls.push({ method, durationMs: performance.now() - startedAt, outcome: 'success' });
      return result;
    } catch (error) {
      const trace = getActiveTrace();
      trace?.backendCalls.push({ method, durationMs: performance.now() - startedAt, outcome: 'error' });
      throw error;
    }
  };
  const service = {
    async listProducts() {
      const products = await client.listProducts();
      const trace = getActiveTrace();
      if (trace) {
        trace.productCalls += 1;
        trace.productCount = products.length;
        trace.productMatch = products.includes(trace.expectedProduct);
      }
      return products;
    },
    async searchSecurities(query) {
      const securities = await client.searchSecurities(query);
      const trace = getActiveTrace();
      if (trace) {
        trace.securityCalls += 1;
        trace.securityQueries.push({ queryHash: hashText(query), resultCount: securities.length });
        trace.expectedSecurityMatch ||= securities.some((item) => item.code === trace.expectedSecurityCode);
      }
      return securities;
    },
    async calculatePretrade() {
      const trace = getActiveTrace();
      if (trace) trace.calculationCalls += 1;
      throw new GuardError('calculate-pretrade-forbidden');
    },
  };
  return { client, service };
}

async function runOne(api, executor, service, config, testCase, getActiveTrace, version) {
  const trace = {
    expectedProduct: testCase.expectedProduct,
    expectedSecurityCode: testCase.expectedSecurityCode,
    productCalls: 0,
    productCount: null,
    productMatch: null,
    securityCalls: 0,
    securityQueries: [],
    expectedSecurityMatch: false,
    calculationCalls: 0,
    backendCalls: [],
  };
  getActiveTrace.set(trace);
  const startedAt = performance.now();
  const ai = { calls: 0, durationMs: 0, entries: [] };
  const sample = {
    version,
    commit: FIXED[version].commit,
    caseId: testCase.caseId,
    semantic: testCase.semantic,
    utc: new Date().toISOString(),
    inputHash: hashText(testCase.text),
    dataDate: testCase.dataDate ?? null,
    declaredDataVersionHash: testCase.dataVersion ? hashValue(testCase.dataVersion) : null,
    success: false,
    status: 'not-run',
    safety: 'inconclusive',
    ai: null,
    normalization: null,
    amountObservation: null,
    backend: null,
    noCalculation: null,
    totalMs: null,
    stages: { startup: null, ai: null, normalization: null, calculation: null, confirmation: null },
    errorCategory: null,
  };
  try {
    let state;
    const analyze = () => analyzeWithRealAi(api, executor, config, testCase, ai);
    if (typeof api.resolveInitialRiskIntent === 'function') {
      state = await api.resolveInitialRiskIntent(testCase.text, service, analyze);
    } else {
      // The fixed before commit predates resolveInitialRiskIntent. Keep its
      // original AI -> normalizeRiskDraft chain without inventing a draft.
      state = await api.normalizeRiskDraft(testCase.text, await analyze(), service);
    }
    const directParserAccepted = ai.calls === 0;
    const assessment = assessGuard(api, testCase, state, trace, directParserAccepted);
    sample.status = assessment.status;
    sample.safety = assessment.safety;
    sample.success = assessment.safety === 'safe';
    sample.normalization = assessment.normalized;
    sample.amountObservation = assessment.amount;
    sample.errorCategory = assessment.safety === 'safe' ? null : assessment.status;
    sample.routeObservation = assessment.routeObservation;
    sample.disposition = assessment.disposition;
  } catch (error) {
    sample.status = classifyError(error);
    sample.errorCategory = sample.status;
    sample.success = false;
    sample.safety = 'inconclusive';
  } finally {
    sample.ai = {
      calls: ai.calls,
      durationMs: ai.durationMs,
      entries: ai.entries,
    };
    sample.backend = {
      readOnlyMethods: ['list_products', 'search_securities'],
      calls: trace.backendCalls,
      methodCounts: methodCounts(trace.backendCalls),
      productCalls: trace.productCalls,
      productCount: trace.productCount,
      productMatch: trace.productMatch,
      securityCalls: trace.securityCalls,
      securityQueries: trace.securityQueries,
      expectedSecurityMatch: trace.expectedSecurityMatch,
    };
    sample.noCalculation = {
      confirmationInvoked: false,
      routerInvoked: false,
      calculatePretradeCalls: trace.calculationCalls,
      calculationResultHash: null,
    };
    sample.totalMs = performance.now() - startedAt;
    sample.stages.ai = ai.calls > 0 ? ai.durationMs : null;
    sample.stages.normalization = sample.totalMs - (sample.stages.ai ?? 0);
    getActiveTrace.clear();
  }
  return sample;
}

async function runVersion(version, config, testCase, outputDir) {
  const api = await import(pathToFileURL(config[`${version}Bundle`]).href);
  for (const name of ALLOWED_BUNDLE_EXPORTS) {
    if (typeof api[name] !== 'function') throw new GuardError(`bundle-missing-export:${name}`);
  }
  // A fresh state directory per version/case prevents product/security cache
  // state from changing the paired guard observation.
  const stateDir = join(outputDir, 'state', version, testCase.caseId);
  await mkdir(join(stateDir, 'agent'), { recursive: true, mode: 0o700 });
  const agent = new api.CodexAdapter({
    binary: config.binary,
    profileStateDir: join(stateDir, 'agent'),
    codexHome: config[`${version}Home`],
    inheritCodexHome: false,
    ignoreUserConfig: false,
    ignoreRules: false,
    sandbox: 'read-only',
    stopGraceMs: config.stopGraceMs,
  });
  const executor = new api.RunExecutor({
    agent,
    pool: new api.ProcessPool(() => 1, { maxQueued: 1, queueTimeoutMs: config.queueTimeoutMs }),
    activeRuns: new api.ActiveRuns(),
    postDoneExitGraceMs: 2_000,
  });
  const active = { value: null };
  const observed = createObservedService(
    api,
    { ...config, currentBridge: config[`${version}Bridge`] },
    stateDir,
    () => active.value,
  );
  try {
    return await runOne(api, executor, observed.service, config, testCase, {
      set: (value) => { active.value = value; },
      clear: () => { active.value = null; },
    }, version);
  } finally {
    await observed.client.close().catch(() => undefined);
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function writeJsonLines(file, value, append = false) {
  await writeFile(file, `${JSON.stringify(value)}\n`, append ? { flag: 'a', mode: 0o600 } : { mode: 0o600 });
}

async function loadCases(file) {
  const raw = await readJson(file);
  const rows = Array.isArray(raw) ? raw : raw?.cases;
  if (!Array.isArray(rows)) throw new GuardError('cases-array-required');
  const seen = new Set();
  const cases = rows.map((value) => {
    if (!value || typeof value !== 'object') throw new GuardError('invalid-case');
    const testCase = {
      caseId: stringField(value.caseId ?? value.id, 'caseId'),
      semantic: stringField(value.semantic, 'semantic'),
      text: stringField(value.text, 'text'),
      expectedProduct: stringField(value.expectedProduct ?? value.product, 'expectedProduct'),
      expectedSecurityCode: stringField(value.expectedSecurityCode ?? value.securityCode, 'expectedSecurityCode'),
      expectedAmount: value.expectedAmount === undefined || value.expectedAmount === null
        ? null
        : Number(value.expectedAmount),
      dataDate: typeof value.dataDate === 'string' ? value.dataDate : null,
      dataVersion: value.dataVersion ?? null,
    };
    if (!/^[A-Za-z0-9._-]+$/.test(testCase.caseId)) throw new GuardError('invalid-case-id');
    if (testCase.expectedAmount !== null && !Number.isFinite(testCase.expectedAmount)) {
      throw new GuardError(`invalid-expected-amount:${testCase.caseId}`);
    }
    if (seen.has(testCase.caseId)) throw new GuardError('duplicate-case');
    seen.add(testCase.caseId);
    if (!SEMANTICS.has(testCase.semantic)) throw new GuardError('invalid-semantic');
    if (classifyOriginalAmount(testCase.text) !== testCase.semantic) throw new GuardError(`case-semantic-mismatch:${testCase.caseId}`);
    if (testCase.semantic === 'chinese-amount' && testCase.expectedAmount === null) {
      throw new GuardError(`missing-expected-amount:${testCase.caseId}`);
    }
    return testCase;
  });
  for (const required of REQUIRED_CASES) if (!seen.has(required)) throw new GuardError(`missing-required-case:${required}`);
  return cases;
}

async function preflight(config, casesFile, outputDir) {
  const absoluteCases = ensureAbsolute(casesFile, 'cases');
  const absoluteOutput = ensureAbsolute(outputDir, 'out');
  if (isInside(REPO_ROOT, absoluteCases)) throw new GuardError('private-cases-must-be-outside-repository');
  if (isInside(REPO_ROOT, absoluteOutput)) throw new GuardError('output-must-be-outside-repository');
  try {
    await stat(absoluteOutput);
    throw new GuardError('output-directory-already-exists');
  } catch (error) {
    if (error instanceof GuardError) throw error;
    if (error?.code !== 'ENOENT') throw new GuardError('output-directory-unavailable', error);
  }
  const paths = {
    cases: absoluteCases,
    binary: ensureAbsolute(config.binary, 'binary'),
    python: ensureAbsolute(config.python, 'python'),
    cwd: ensureAbsolute(config.cwd, 'cwd'),
    serviceDir: ensureAbsolute(config.serviceDir, 'service'),
    beforeRoot: ensureAbsolute(config.beforeRoot, 'before-root'),
    afterRoot: ensureAbsolute(config.afterRoot, 'after-root'),
    beforeHome: ensureAbsolute(config.beforeHome, 'before-home'),
    afterHome: ensureAbsolute(config.afterHome, 'after-home'),
    beforeBundle: ensureAbsolute(config.beforeBundle, 'before-bundle'),
    afterBundle: ensureAbsolute(config.afterBundle, 'after-bundle'),
    beforeBridge: ensureAbsolute(config.beforeBridge, 'before-bridge'),
    afterBridge: ensureAbsolute(config.afterBridge, 'after-bridge'),
  };
  if (paths.beforeHome === paths.afterHome) throw new GuardError('before-after-homes-must-differ');
  const sharedHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : null;
  const defaultHome = process.env.HOME ? resolve(process.env.HOME, '.codex') : null;
  if ([paths.beforeHome, paths.afterHome].some((home) => home === sharedHome || home === defaultHome)) {
    throw new GuardError('shared-codex-home-forbidden');
  }
  await Promise.all([
    existing(paths.cases, 'cases'),
    existing(paths.binary, 'binary', true),
    existing(paths.python, 'python', true),
    existing(paths.cwd, 'cwd'),
    existing(paths.serviceDir, 'service'),
    existing(paths.beforeRoot, 'before-root'),
    existing(paths.afterRoot, 'after-root'),
    existing(paths.beforeHome, 'before-home'),
    existing(paths.afterHome, 'after-home'),
    existing(paths.beforeBundle, 'before-bundle'),
    existing(paths.afterBundle, 'after-bundle'),
    existing(paths.beforeBridge, 'before-bridge'),
    existing(paths.afterBridge, 'after-bridge'),
    existing(join(paths.beforeHome, 'config.toml'), 'before-home-config'),
    existing(join(paths.afterHome, 'config.toml'), 'after-home-config'),
    existing(join(paths.beforeHome, 'auth.json'), 'before-home-auth'),
    existing(join(paths.afterHome, 'auth.json'), 'after-home-auth'),
  ]);
  if (!isInside(paths.beforeRoot, paths.beforeBridge) || !isInside(paths.afterRoot, paths.afterBridge)) {
    throw new GuardError('bridge-outside-fixed-source-root');
  }
  const sourceChecks = {
    before: await verifyFixedSource(paths.beforeRoot, 'before'),
    after: await verifyFixedSource(paths.afterRoot, 'after'),
  };
  const [beforeHomeConfigHash, afterHomeConfigHash] = await Promise.all([
    fileDigest(join(paths.beforeHome, 'config.toml'), 'before-home-config'),
    fileDigest(join(paths.afterHome, 'config.toml'), 'after-home-config'),
  ]);
  if (beforeHomeConfigHash !== afterHomeConfigHash) throw new GuardError('codex-home-config-mismatch');
  const [bundleHashes, bridgeHashes] = await Promise.all([
    Promise.all([fileDigest(paths.beforeBundle, 'before-bundle'), fileDigest(paths.afterBundle, 'after-bundle')]),
    Promise.all([fileDigest(paths.beforeBridge, 'before-bridge'), fileDigest(paths.afterBridge, 'after-bridge')]),
  ]);
  return {
    paths,
    bundleHashes: { before: bundleHashes[0], after: bundleHashes[1] },
    bridgeHashes: { before: bridgeHashes[0], after: bridgeHashes[1] },
    sourceChecks,
    codexHomeConfigHash: beforeHomeConfigHash,
    authFilesPresent: { before: true, after: true },
  };
}

function sampleSummary(samples) {
  const counts = {};
  for (const sample of samples) counts[sample.status] = (counts[sample.status] ?? 0) + 1;
  return {
    n: samples.length,
    success: samples.filter((sample) => sample.success).length,
    failures: samples.filter((sample) => !sample.success).length,
    statuses: counts,
    aiCalls: samples.reduce((sum, sample) => sum + (sample.ai?.calls ?? 0), 0),
    calculationCalls: samples.reduce((sum, sample) => sum + (sample.noCalculation?.calculatePretradeCalls ?? 0), 0),
  };
}

function overallStatus(samples) {
  if (samples.some((sample) => sample.safety === 'unsafe')) return 'failed-unsafe-executable-confirm';
  if (samples.some((sample) => sample.safety === 'inconclusive')) return 'blocked-insufficient-evidence';
  if (samples.some((sample) => sample.safety === 'risk-observed')) return 'risk-observed-invalid-confirmation';
  return 'passed-no-confirmation';
}

function setupFailureSample(version, testCase, error) {
  const status = classifyError(error);
  return {
    version,
    commit: FIXED[version].commit,
    caseId: testCase.caseId,
    semantic: testCase.semantic,
    utc: new Date().toISOString(),
    inputHash: hashText(testCase.text),
    dataDate: testCase.dataDate ?? null,
    declaredDataVersionHash: testCase.dataVersion ? hashValue(testCase.dataVersion) : null,
    success: false,
    status,
    safety: 'inconclusive',
    errorCategory: status,
    ai: { calls: 0, durationMs: 0, entries: [] },
    normalization: null,
    amountObservation: null,
    backend: null,
    noCalculation: {
      confirmationInvoked: false,
      routerInvoked: false,
      calculatePretradeCalls: 0,
      calculationResultHash: null,
    },
    totalMs: null,
    stages: { startup: null, ai: null, normalization: null, calculation: null, confirmation: null },
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }
  rejectInheritedStateEnv();
  const fileConfig = flags.config ? await readJson(ensureAbsolute(flags.config, 'config')) : {};
  const config = resolveConfig(flags, fileConfig);
  const casesFile = stringField(flags.cases ?? fileConfig.cases, 'cases');
  const outputDir = stringField(flags.out, 'out');
  const cases = await loadCases(casesFile);
  const paths = await preflight(config, casesFile, outputDir);
  const absoluteOutput = ensureAbsolute(outputDir, 'out');
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await mkdir(absoluteOutput, { mode: 0o700 });
  const environment = {
    kind: 'real-ai-intent-safety-guard',
    workers: 1,
    measurementKind: 'functional guards, not latency benchmark',
    versions: { before: FIXED.before.commit, after: FIXED.after.commit },
    node: process.version,
    platform: process.platform,
    model: config.model,
    binary: paths.paths.binary,
    cwd: paths.paths.cwd,
    python: paths.paths.python,
    serviceDir: paths.paths.serviceDir,
    bundles: paths.bundleHashes,
    bridges: paths.bridgeHashes,
    sourceChecks: paths.sourceChecks,
    codexHomeConfigHash: paths.codexHomeConfigHash,
    authFilesPresent: paths.authFilesPresent,
    casesFileHash: hashText(await readFile(paths.paths.cases)),
    caseIds: cases.map((testCase) => testCase.caseId),
    boundaries: [
      'AI output is consumed from CodexAdapter events; no model draft is fabricated on error or parse failure.',
      'RiskDirectClient is used only for read-only list_products/search_securities normalization calls.',
      'Read-only master-data responses do not prove a frozen holdings/NAV or calculation data snapshot.',
      'No router, confirmation callback, calculatePretrade, transaction, or business-ledger path is invoked.',
      'Output stores hashes/presence/state/timing only; raw cases, prompts, AI output, products, securities, and credentials are not written.',
      'routeObservation is source-contract reasoning for after executeConfirmed amount validation; this harness does not call that route.',
      'A confirm state retaining a negative/zero/ambiguous/Chinese amount is reported as risk-observed-invalid-confirmation, not as safe.',
    ],
  };
  await writeJson(join(absoluteOutput, 'environment.json'), environment);
  const samplesFile = join(absoluteOutput, 'samples.jsonl');
  const pairsFile = join(absoluteOutput, 'pairs.jsonl');
  await writeFile(samplesFile, '', { mode: 0o600 });
  await writeFile(pairsFile, '', { mode: 0o600 });
  const samplesByVersion = { before: [], after: [] };
  // AB/BA by case: every case runs both versions before the next case, with a
  // fresh version/case state directory. This limits cache and ordering bias.
  for (const [caseIndex, testCase] of cases.entries()) {
    const order = caseIndex % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
    for (const version of order) {
      config[`${version}Bundle`] = paths.paths[`${version}Bundle`];
      config[`${version}Bridge`] = paths.paths[`${version}Bridge`];
      config[`${version}Home`] = paths.paths[`${version}Home`];
      let sample;
      try {
        sample = await runVersion(version, config, testCase, absoluteOutput);
      } catch (error) {
        sample = setupFailureSample(version, testCase, error);
      }
      samplesByVersion[version].push(sample);
      await writeJsonLines(samplesFile, sample, true);
    }
  }
  for (const testCase of cases) {
    const before = samplesByVersion.before.find((sample) => sample.caseId === testCase.caseId);
    const after = samplesByVersion.after.find((sample) => sample.caseId === testCase.caseId);
    await writeJsonLines(pairsFile, {
      caseId: testCase.caseId,
      semantic: testCase.semantic,
      inputHash: hashText(testCase.text),
      inputHashEqual: before?.inputHash === after?.inputHash,
      before: {
        status: before?.status ?? 'missing',
        safety: before?.safety ?? 'inconclusive',
        aiCalls: before?.ai?.calls ?? null,
        normalizedStage: before?.normalization?.stage ?? null,
        normalizedStateHash: before?.normalization?.stateHash ?? null,
        calculatePretradeCalls: before?.noCalculation?.calculatePretradeCalls ?? null,
      },
      after: {
        status: after?.status ?? 'missing',
        safety: after?.safety ?? 'inconclusive',
        aiCalls: after?.ai?.calls ?? null,
        normalizedStage: after?.normalization?.stage ?? null,
        normalizedStateHash: after?.normalization?.stateHash ?? null,
        calculatePretradeCalls: after?.noCalculation?.calculatePretradeCalls ?? null,
      },
      noCalculationObserved: (before?.noCalculation?.calculatePretradeCalls ?? 0) === 0 && (after?.noCalculation?.calculatePretradeCalls ?? 0) === 0,
    }, true);
  }
  const allSamples = [...samplesByVersion.before, ...samplesByVersion.after];
  const overall = overallStatus(allSamples);
  await writeJson(join(absoluteOutput, 'summary.json'), {
    kind: 'real-ai-intent-safety-guard',
    status: overall,
    versions: { before: FIXED.before.commit, after: FIXED.after.commit },
    caseCount: cases.length,
    before: sampleSummary(samplesByVersion.before),
    after: sampleSummary(samplesByVersion.after),
    noCalculation: {
      observedCalls: allSamples.reduce((sum, sample) => sum + (sample.noCalculation?.calculatePretradeCalls ?? 0), 0),
      routerInvocations: allSamples.filter((sample) => sample.noCalculation?.routerInvoked).length,
      confirmationInvocations: allSamples.filter((sample) => sample.noCalculation?.confirmationInvoked).length,
    },
    evidenceBoundary: 'Only real AI extraction plus read-only product/security normalization is measured. A normalized confirm state is observed but never confirmed or routed.',
  });
  if (overall === 'failed-unsafe-executable-confirm') process.exitCode = 1;
  else if (overall === 'blocked-insufficient-evidence') process.exitCode = 2;
  else if (overall === 'risk-observed-invalid-confirmation') process.exitCode = 3;
}

main().catch((error) => {
  console.error(`risk-live-ai-guards: ${classifyError(error)}`);
  process.exitCode = 2;
});
