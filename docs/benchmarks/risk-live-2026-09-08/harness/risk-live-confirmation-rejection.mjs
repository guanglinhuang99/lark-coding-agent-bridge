#!/usr/bin/env node

/**
 * Replay the invalid confirmation states captured by risk-live-ai-guards.
 *
 * This entry point does not call Codex, RiskDirectClient, Python, or the
 * risk-service.  It loads the fixed after bundle, verifies the captured state
 * hashes, consumes the real confirmation registry once, and calls the real
 * WeComRiskRouter.executeConfirmed with a service whose every method is a
 * fail-fast trap.  An invalid amount must be rejected by the router before
 * calculatePretrade is reached.
 */

import { access, constants, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = '/Users/guanglin/Sync/wecom-bot';
const FIXED = {
  commit: '6d28a6a673b3d400f3d30e15018b5a5621d545cf',
  root: '/private/tmp/wecom-live-20260908/after',
  bundle: '/private/tmp/wecom-live-20260908/ai-functional-live-1/after-client.mjs',
};
const REQUIRED_SEMANTICS = new Set([
  'negative-amount',
  'zero-amount',
  'ambiguous-amount',
  'chinese-amount',
]);
const CHINESE_NUMBER = '[零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟萬]+';
const NUMBER = '(?:\\d+(?:\\.\\d+)?)';
const UNIT = '(?:亿元|万元|亿|万|元|块|股|手|张|份)';
const FULL_ROUTE_AMOUNT_RE = new RegExp(`^${NUMBER}\\s*${UNIT}?$`, 'u');
const NEGATIVE_AMOUNT_RE = new RegExp(`^(?:[-−]\\s*|负\\s*)${NUMBER}\\s*${UNIT}?$`, 'u');
const AMBIGUOUS_AMOUNT_RE = new RegExp(
  `^[-−]?\\s*${NUMBER}\\s*${UNIT}\\s*(?:或|或者|至|到|~|～|-)\\s*[-−]?\\s*${NUMBER}\\s*${UNIT}?$`,
  'u',
);
const CHINESE_AMOUNT_RE = new RegExp(`${CHINESE_NUMBER}\\s*${UNIT}`, 'u');
const AMOUNT_IN_TEXT_RE = new RegExp(
  `[-−]?\\s*(?:${NUMBER}|${CHINESE_NUMBER})\\s*${UNIT}(?:\\s*(?:或|或者|至|到|~|～|-)\\s*[-−]?\\s*(?:${NUMBER}|${CHINESE_NUMBER})\\s*${UNIT}?)?`,
  'u',
);
const ACTION_RE = /逆回购|回购|申购|认购|赎回|买入|卖出|买|卖/u;
const ALLOWED_BUNDLE_EXPORTS = [
  'RiskSelectionTaskRegistry',
  'WeComRiskRouter',
  'buildIntentSelection',
  'extractAmount',
];
const FORBIDDEN_INHERITED_ENV = [
  'POST_TRADE_HISTORY_DB',
  'PORTFOLIO_MARKET_CACHE',
  'PINS_CACHE_DIR',
  'PINS_DATA_DIR',
];

class ReplayError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'ReplayError';
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
    if (!token?.startsWith('--')) throw new ReplayError('unexpected-argument');
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!key || !next || next.startsWith('--')) throw new ReplayError(`missing-value:${key}`);
    args[key] = next;
    index += 1;
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node risk-live-confirmation-rejection.mjs --cases /absolute/private-cases.json',
    '    --guard-samples /absolute/ai-guards/samples.jsonl --out /absolute/new-output',
    '    [--states /absolute/private-state-snapshots.json] [--security-name <private-name>]',
    '',
    'The default root and bundle are the fixed after acceptance artifacts.',
    'No AI, Python, risk-service, transaction, or WeCom platform call is made.',
  ].join('\n');
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new ReplayError('json-read-failed', error);
  }
}

async function readJsonLines(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new ReplayError('samples-read-failed', error);
  }
  const rows = [];
  for (const [lineNumber, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new ReplayError(`samples-json-invalid:${lineNumber + 1}`, error);
    }
  }
  return rows;
}

function ensureAbsolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new ReplayError(`path-not-absolute:${name}`);
  return resolve(value);
}

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function existing(file, name, executable = false) {
  try {
    await stat(file);
    await access(file, executable ? constants.X_OK : constants.F_OK);
  } catch (error) {
    throw new ReplayError(`path-unavailable:${name}`, error);
  }
}

async function fileHash(file, name) {
  await existing(file, name);
  return hashText(await readFile(file));
}

async function assertNewOutput(file) {
  try {
    await stat(file);
    throw new ReplayError('output-directory-already-exists');
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    if (error?.code !== 'ENOENT') throw new ReplayError('output-directory-check-failed', error);
  }
}

async function verifyFixedSource(root) {
  try {
    const headResult = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']);
    const head = String(headResult.stdout).trim();
    if (head !== FIXED.commit) throw new ReplayError('fixed-head-mismatch');
    const diffResult = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'src'],
    );
    if (String(diffResult.stdout).trim()) throw new ReplayError('fixed-src-dirty');
    return { root, head, srcDirty: false };
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new ReplayError('fixed-source-check-failed', error);
  }
}

function loadCaseRows(value) {
  const rows = Array.isArray(value) ? value : value?.cases;
  if (!Array.isArray(rows)) throw new ReplayError('cases-array-required');
  const seen = new Set();
  const cases = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new ReplayError('invalid-case');
    const caseId = String(row.caseId ?? row.id ?? '').trim();
    const semantic = String(row.semantic ?? '').trim();
    if (!caseId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(caseId)) throw new ReplayError('invalid-case-id');
    if (seen.has(caseId)) throw new ReplayError(`duplicate-case:${caseId}`);
    if (!REQUIRED_SEMANTICS.has(semantic)) continue;
    if (typeof row.text !== 'string' || !row.text.trim()) throw new ReplayError(`missing-case-text:${caseId}`);
    if (typeof row.expectedProduct !== 'string' || !row.expectedProduct.trim()) throw new ReplayError(`missing-case-product:${caseId}`);
    if (typeof row.expectedSecurityCode !== 'string' || !row.expectedSecurityCode.trim()) throw new ReplayError(`missing-case-security:${caseId}`);
    seen.add(caseId);
    cases.push({ ...row, caseId, semantic });
  }
  for (const semantic of REQUIRED_SEMANTICS) {
    if (!cases.some((row) => row.semantic === semantic)) throw new ReplayError(`missing-required-semantic:${semantic}`);
  }
  return cases;
}

function loadStateRows(value) {
  if (value === undefined) return new Map();
  const rows = Array.isArray(value) ? value : value?.states ?? value?.snapshots;
  if (!Array.isArray(rows)) throw new ReplayError('states-array-required');
  const result = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new ReplayError('invalid-state-row');
    const caseId = String(row.caseId ?? row.id ?? '').trim();
    if (!caseId || result.has(caseId)) throw new ReplayError(`duplicate-state:${caseId}`);
    if (!row.state || typeof row.state !== 'object') throw new ReplayError(`state-object-required:${caseId}`);
    result.set(caseId, row.state);
  }
  return result;
}

function indexGuardSamples(rows) {
  const result = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.version !== 'after') continue;
    const caseId = String(row.caseId ?? '').trim();
    if (!caseId) continue;
    if (result.has(caseId)) throw new ReplayError(`duplicate-after-sample:${caseId}`);
    if (row.commit !== FIXED.commit) throw new ReplayError(`sample-commit-mismatch:${caseId}`);
    result.set(caseId, row);
  }
  return result;
}

function amountKind(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'missing';
  if (NEGATIVE_AMOUNT_RE.test(text)) return 'negative';
  if (AMBIGUOUS_AMOUNT_RE.test(text)) return 'ambiguous';
  if (CHINESE_AMOUNT_RE.test(text) && !FULL_ROUTE_AMOUNT_RE.test(text)) return 'chinese-nonnumeric';
  if (FULL_ROUTE_AMOUNT_RE.test(text)) {
    const number = Number(text.replace(new RegExp(`\\s*${UNIT}$`, 'u'), ''));
    if (number === 0) return 'zero';
    if (number > 0) return 'positive';
  }
  return 'invalid-nonnumeric';
}

function amountFromCase(testCase) {
  if (typeof testCase.amountText === 'string' && testCase.amountText.trim()) return testCase.amountText.trim();
  const match = AMOUNT_IN_TEXT_RE.exec(testCase.text);
  if (!match?.[0]) throw new ReplayError(`amount-text-unavailable:${testCase.caseId}`);
  return match[0].trim();
}

function actionFromCase(testCase) {
  if (typeof testCase.action === 'string' && testCase.action.trim()) return testCase.action.trim();
  if (typeof testCase.expectedAction === 'string' && testCase.expectedAction.trim()) return testCase.expectedAction.trim();
  if (/逆回购/u.test(testCase.text)) return 'reverse_repo';
  if (/回购/u.test(testCase.text)) return 'repo';
  if (/申购|认购/u.test(testCase.text)) return 'subscription';
  if (/赎回/u.test(testCase.text)) return 'redemption';
  if (/卖出|卖/u.test(testCase.text)) return 'sell';
  if (ACTION_RE.test(testCase.text)) return 'buy';
  throw new ReplayError(`action-unavailable:${testCase.caseId}`);
}

function buildReplayState(testCase, securityName) {
  const name = String(testCase.expectedSecurityName ?? securityName ?? '').trim();
  if (!name) throw new ReplayError(`security-name-required:${testCase.caseId}`);
  const code = testCase.expectedSecurityCode.trim();
  const action = actionFromCase(testCase);
  const amountText = amountFromCase(testCase);
  return {
    stage: 'confirm',
    originalText: testCase.text,
    draft: {
      accountQuery: testCase.accountQuery?.trim() || testCase.expectedProduct.trim(),
      action,
      securityQuery: testCase.securityQuery?.trim() || code,
      amountText,
      ...(Number.isFinite(testCase.days) ? { days: testCase.days } : {}),
      market: testCase.market === 'primary' || /一级/u.test(testCase.text) ? 'primary' : 'secondary',
    },
    product: testCase.expectedProduct.trim(),
    security: {
      name,
      code,
      label: testCase.expectedSecurityLabel?.trim() || `${name}（${code}）`,
    },
  };
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

function assertCapturedSample(sample, testCase) {
  if (!sample) throw new ReplayError(`guard-sample-missing:${testCase.caseId}`);
  if (sample.semantic !== testCase.semantic) throw new ReplayError(`sample-semantic-mismatch:${testCase.caseId}`);
  if (sample.status !== 'risk-observed-invalid-confirmation' || sample.safety !== 'risk-observed') {
    throw new ReplayError(`sample-not-invalid-confirmation:${testCase.caseId}`);
  }
  if (sample.ai?.calls < 1) throw new ReplayError(`sample-not-real-ai:${testCase.caseId}`);
  if (sample.normalization?.stage !== 'confirm') throw new ReplayError(`sample-not-confirm-stage:${testCase.caseId}`);
  if (sample.normalization?.stateHash === undefined || sample.normalization?.draft?.draftHash === undefined) {
    throw new ReplayError(`sample-hash-missing:${testCase.caseId}`);
  }
  if (sample.noCalculation?.calculatePretradeCalls !== 0) {
    throw new ReplayError(`guard-calculation-observed:${testCase.caseId}`);
  }
  if (sample.amountObservation?.executable !== false || sample.amountObservation?.semanticConflict !== false) {
    throw new ReplayError(`sample-positive-conflict:${testCase.caseId}`);
  }
  if (sample.amountObservation?.originalSemantic !== testCase.semantic) {
    throw new ReplayError(`sample-amount-semantic-mismatch:${testCase.caseId}`);
  }
}

function assertSameCapturedState(state, sample, testCase) {
  if (state.stage !== 'confirm' || !state.draft || typeof state.draft !== 'object') {
    throw new ReplayError(`replay-not-confirm-state:${testCase.caseId}`);
  }
  const normalized = summarizeState(state);
  const captured = sample.normalization;
  if (normalized.stateHash !== captured.stateHash) throw new ReplayError(`state-hash-mismatch:${testCase.caseId}`);
  if (normalized.draft.draftHash !== captured.draft.draftHash) throw new ReplayError(`draft-hash-mismatch:${testCase.caseId}`);
  if (hashValue(normalized.draft.fieldHashes) !== hashValue(captured.draft.fieldHashes)) {
    throw new ReplayError(`draft-field-hash-mismatch:${testCase.caseId}`);
  }
  if (normalized.stage !== captured.stage || normalized.field !== captured.field) {
    throw new ReplayError(`state-summary-mismatch:${testCase.caseId}`);
  }
  const expectedKind = {
    'negative-amount': 'negative',
    'zero-amount': 'zero',
    'ambiguous-amount': 'ambiguous',
    'chinese-amount': 'chinese-nonnumeric',
  }[testCase.semantic];
  if (amountKind(state.draft.amountText) !== expectedKind) {
    throw new ReplayError(`replay-amount-class-mismatch:${testCase.caseId}`);
  }
  if (sample.amountObservation?.aiAmountClass !== expectedKind) {
    throw new ReplayError(`captured-amount-class-mismatch:${testCase.caseId}`);
  }
  return normalized;
}

function sourceAmountRejection(api, amountText) {
  const value = String(amountText ?? '').trim();
  if (!FULL_ROUTE_AMOUNT_RE.test(value)) return 'invalid-amount-syntax';
  const parsed = api.extractAmount(value);
  const number = parsed?.amount ?? parsed?.quantity;
  if (!parsed || !Number.isFinite(number) || number <= 0) return 'non-positive-amount';
  return null;
}

function createTrapService(trace) {
  const deny = (method) => async () => {
    trace.serviceCalls += 1;
    trace.serviceMethods.push(method);
    throw new ReplayError(`unexpected-service-call:${method}`);
  };
  return {
    listProducts: deny('listProducts'),
    searchSecurities: deny('searchSecurities'),
    checkSecurity: deny('checkSecurity'),
    checkCounterparty: deny('checkCounterparty'),
    getHoldings: deny('getHoldings'),
    getRestrictions: deny('getRestrictions'),
    getCredit: deny('getCredit'),
    async calculatePretrade() {
      trace.serviceCalls += 1;
      trace.serviceMethods.push('calculatePretrade');
      trace.calculatePretradeCalls += 1;
      throw new ReplayError('calculate-pretrade-trap-hit');
    },
  };
}

function assertConfirmationRegistry(api, state, caseId) {
  const selection = api.buildIntentSelection(state, Date.now() + 300_000);
  if (selection.kind !== 'intent-confirm') throw new ReplayError(`selection-kind-mismatch:${caseId}`);
  const taskId = randomUUID();
  const conversationKey = randomUUID();
  const registry = new api.RiskSelectionTaskRegistry();
  registry.register(taskId, conversationKey, selection);
  const selected = registry.resolve(taskId, conversationKey, 'confirm');
  if (selected.status !== 'selected' || selected.option?.value !== '__confirm__') {
    throw new ReplayError(`confirmation-selection-rejected:${caseId}`);
  }
  const duplicate = registry.resolve(taskId, conversationKey, 'confirm');
  if (duplicate.status !== 'missing') throw new ReplayError(`duplicate-confirmation-accepted:${caseId}`);
  return { kind: selection.kind, selected: selected.status, duplicate: duplicate.status };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ReplayError('router-watchdog-timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function replayOne(api, testCase, sample, state, bundleHash) {
  const normalized = assertSameCapturedState(state, sample, testCase);
  const sourceReject = sourceAmountRejection(api, state.draft.amountText);
  if (!sourceReject) throw new ReplayError(`source-would-accept-amount:${testCase.caseId}`);
  const callback = assertConfirmationRegistry(api, state, testCase.caseId);
  const trace = { serviceCalls: 0, serviceMethods: [], calculatePretradeCalls: 0 };
  const service = createTrapService(trace);
  const router = new api.WeComRiskRouter(service);
  let result;
  try {
    result = await withTimeout(router.executeConfirmed(state), 10_000);
  } catch {
    throw new ReplayError(`router-threw:${testCase.caseId}`);
  }
  if (!result || result.handled !== true || result.intent !== 'risk-error') {
    throw new ReplayError(`invalid-confirmation-not-rejected:${testCase.caseId}`);
  }
  if (trace.serviceCalls !== 0 || trace.calculatePretradeCalls !== 0) {
    throw new ReplayError(`backend-call-before-rejection:${testCase.caseId}`);
  }
  return {
    version: 'after',
    commit: FIXED.commit,
    caseId: testCase.caseId,
    semantic: testCase.semantic,
    utc: new Date().toISOString(),
    captured: {
      inputHash: hashText(testCase.text),
      status: sample.status,
      safety: sample.safety,
      aiCalls: sample.ai.calls,
      stateHash: sample.normalization.stateHash,
      draftHash: sample.normalization.draft.draftHash,
    },
    replay: {
      stateHash: normalized.stateHash,
      draftHash: normalized.draft.draftHash,
      amountClass: amountKind(state.draft.amountText),
      sourceReject,
      confirmation: callback,
      route: { handled: result.handled, intent: result.intent },
      serviceCalls: trace.serviceCalls,
      serviceMethods: trace.serviceMethods,
      calculatePretradeCalls: trace.calculatePretradeCalls,
    },
    bundleSha256: bundleHash,
    status: 'passed',
    evidence: 'after-router-replay-with-calculate-trap',
  };
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function writeJsonLines(file, rows) {
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }
  for (const name of FORBIDDEN_INHERITED_ENV) {
    if (process.env[name]) throw new ReplayError(`forbidden-inherited-env:${name}`);
  }
  const casesFile = ensureAbsolute(flags.cases, 'cases');
  const samplesFile = ensureAbsolute(flags['guard-samples'], 'guard-samples');
  const outputDir = ensureAbsolute(flags.out, 'out');
  const statesFile = flags.states ? ensureAbsolute(flags.states, 'states') : null;
  const root = ensureAbsolute(flags.root ?? FIXED.root, 'root');
  const bundle = ensureAbsolute(flags.bundle ?? FIXED.bundle, 'bundle');
  if (isInside(REPO_ROOT, casesFile) || isInside(REPO_ROOT, statesFile ?? '/private/tmp')) {
    throw new ReplayError('private-input-must-be-outside-repository');
  }
  if (isInside(REPO_ROOT, outputDir)) throw new ReplayError('output-must-be-outside-repository');
  await assertNewOutput(outputDir);
  await Promise.all([
    existing(casesFile, 'cases'),
    existing(samplesFile, 'guard-samples'),
    existing(root, 'after-root'),
    existing(bundle, 'after-bundle'),
  ]);
  const sourceCheck = await verifyFixedSource(root);
  const bundleHash = await fileHash(bundle, 'after-bundle');
  const cases = loadCaseRows(await readJson(casesFile));
  const sampleIndex = indexGuardSamples(await readJsonLines(samplesFile));
  const stateIndex = loadStateRows(statesFile ? await readJson(statesFile) : undefined);
  const api = await import(pathToFileURL(bundle).href);
  for (const name of ALLOWED_BUNDLE_EXPORTS) {
    if (typeof api[name] !== 'function') throw new ReplayError(`bundle-missing-export:${name}`);
  }

  const outputParent = dirname(outputDir);
  await mkdir(outputParent, { recursive: true });
  await mkdir(outputDir, { mode: 0o700 });
  const environment = {
    kind: 'real-ai-invalid-confirmation-replay',
    version: 'after',
    commit: FIXED.commit,
    node: process.version,
    bundleSha256: bundleHash,
    sourceCheck,
    casesFileHash: hashText(await readFile(casesFile)),
    guardSamplesFileHash: hashText(await readFile(samplesFile)),
    statesFileHash: statesFile ? hashText(await readFile(statesFile)) : null,
    caseIds: cases.map((testCase) => testCase.caseId),
    stateInput: statesFile ? 'private-full-state-snapshot' : 'private-cases-reconstruction-checked-by-guard-state-hash',
    backend: 'none; every RiskService method is a fail-fast trap',
    boundaries: [
      'The guard samples must come from real AI and include the after normalized state/draft hashes.',
      'Without --states, the harness reconstructs only the hash-covered normalized fields from private cases; a hash mismatch stops before routing.',
      'The confirmation registry is the fixed source registry, not a WeCom platform callback or the CLI global registry.',
      'executeConfirmed is the fixed after bundle route; calculatePretrade is never allowed to run.',
      'No AI, Python, risk-service, holdings/NAV snapshot, platform transport, transaction, or business-ledger evidence is produced.',
    ],
  };
  await writeJson(join(outputDir, 'environment.json'), environment);

  const rows = [];
  for (const testCase of cases) {
    const sample = sampleIndex.get(testCase.caseId);
    let row;
    try {
      assertCapturedSample(sample, testCase);
      const state = stateIndex.get(testCase.caseId) ?? buildReplayState(testCase, flags['security-name']);
      row = await replayOne(api, testCase, sample, state, bundleHash);
    } catch (error) {
      row = {
        version: 'after',
        commit: FIXED.commit,
        caseId: testCase.caseId,
        semantic: testCase.semantic,
        utc: new Date().toISOString(),
        captured: sample ? {
          inputHash: hashText(testCase.text),
          status: sample.status ?? null,
          safety: sample.safety ?? null,
          aiCalls: sample.ai?.calls ?? null,
          stateHash: sample.normalization?.stateHash ?? null,
          draftHash: sample.normalization?.draft?.draftHash ?? null,
        } : null,
        status: error instanceof ReplayError ? error.code : 'replay-error',
        evidence: 'no-route-evidence-after-preflight-failure',
      };
    }
    rows.push(row);
  }
  await writeJsonLines(join(outputDir, 'samples.jsonl'), rows);
  const passed = rows.filter((row) => row.status === 'passed');
  const failed = rows.filter((row) => row.status !== 'passed');
  await writeJson(join(outputDir, 'summary.json'), {
    kind: 'real-ai-invalid-confirmation-replay',
    version: 'after',
    commit: FIXED.commit,
    caseCount: rows.length,
    passed: passed.length,
    failed: failed.length,
    status: failed.length === 0 ? 'passed-after-router-rejection' : 'blocked-or-failed',
    routeAssertions: {
      everyRouteResultRiskError: passed.length === rows.length,
      calculatePretradeCalls: rows.reduce((sum, row) => sum + (row.replay?.calculatePretradeCalls ?? 0), 0),
      serviceCalls: rows.reduce((sum, row) => sum + (row.replay?.serviceCalls ?? 0), 0),
      stateHashesMatched: rows.filter((row) => row.status === 'passed').length,
    },
    failedCaseIds: failed.map((row) => row.caseId),
    evidenceBoundary: 'This is a hash-checked replay of real-AI normalized invalid states through the fixed after router. It proves route rejection and zero service calls for the replay; it does not replay the model or prove platform callback delivery.',
  });
  if (failed.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`risk-live-confirmation-rejection: ${error instanceof ReplayError ? error.code : 'replay-error'}`);
  process.exitCode = 2;
});
