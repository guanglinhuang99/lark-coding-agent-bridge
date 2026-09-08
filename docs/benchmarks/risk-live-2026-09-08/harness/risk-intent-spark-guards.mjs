#!/usr/bin/env node
// Spark variant of risk-intent-minimal-guards.mjs.
// It keeps the real model -> normalization -> Router trap boundary while
// making non-confirm states explicit outcomes instead of successful rows.
// No WeCom transport, formal calculation, or business write is performed.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};

if (args.includes('--help')) {
  console.log([
    'node docs/benchmarks/risk-live-2026-09-08/harness/risk-intent-spark-guards.mjs',
    '--config /private/tmp/wecom-live-20260908/spark-guards-private.json',
    '--out /private/tmp/wecom-live-20260908/spark-guards-live',
  ].join(' '));
  process.exit(0);
}

const configPath = resolve(option('--config', '/private/tmp/wecom-live-20260908/spark-guards-private.json'));
const out = resolve(option('--out', '/private/tmp/wecom-live-20260908/spark-guards-live'));
if (!existsSync(configPath)) throw new Error(`Preflight: config not found: ${configPath}`);
if (existsSync(out)) throw new Error(`Output already exists; choose a new directory: ${out}`);

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
if (cfg.model !== 'gpt-5.3-codex-spark') throw new Error(`Preflight: unexpected model ${cfg.model ?? '<missing>'}`);
if (cfg.reasoningEffort !== 'low') throw new Error(`Preflight: reasoning effort must be low`);
for (const [key, value] of Object.entries({
  binary: cfg.binary,
  bundle: cfg.bundle,
  codexHome: cfg.codexHome,
  cwd: cfg.cwd,
  python: cfg.python,
  service: cfg.service,
  bridge: cfg.bridge,
  casesFile: cfg.casesFile,
})) {
  if (typeof value !== 'string' || !isAbsolute(value) || !existsSync(value)) {
    throw new Error(`Preflight: unavailable absolute path ${key}`);
  }
}

const casePayload = JSON.parse(readFileSync(cfg.casesFile, 'utf8'));
const cases = casePayload.cases;
const expectedCases = new Map([
  ['negative-amount', 'confirm-router-rejection'],
  ['zero-amount', 'confirm-router-rejection'],
  ['ambiguous-amount', 'confirm-router-rejection'],
  ['chinese-amount', 'confirm-router-rejection'],
  ['missing-amount', 'non-confirm'],
]);
if (!Array.isArray(cases) || cases.length !== expectedCases.size) throw new Error('Preflight: expected five guard cases');
for (const c of cases) {
  if (!c || !expectedCases.has(c.caseId) || c.semantic !== c.caseId) throw new Error('Preflight: unexpected guard case set');
  if (typeof c.text !== 'string' || !c.text.trim()) throw new Error(`Preflight: missing case text for ${c.caseId}`);
  if (typeof c.expectedProduct !== 'string' || typeof c.expectedSecurityCode !== 'string') throw new Error('Preflight: missing expected master data');
}

mkdirSync(dirname(out), { recursive: true });
mkdirSync(out, { recursive: false });
for (const key of ['NO_PROXY', 'no_proxy']) {
  const values = String(process.env[key] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.includes('10.8.11.57')) values.push('10.8.11.57');
  process.env[key] = values.join(',');
}
const api = await import(pathToFileURL(cfg.bundle));
const agent = new api.CodexAdapter({
  binary: cfg.binary,
  profileStateDir: `${out}/codex-state`,
  codexHome: cfg.codexHome,
  purpose: 'risk-intent',
  sandbox: 'read-only',
});
const client = new api.RiskDirectClient({
  pythonPath: cfg.python,
  serviceDir: cfg.service,
  stateDir: `${out}/backend`,
  bridgePath: cfg.bridge,
  workers: 1,
  timeoutMs: cfg.timeoutMs ?? 180000,
  startupTimeoutMs: cfg.startupTimeoutMs ?? 30000,
});
const executor = new api.RunExecutor({
  agent,
  pool: new api.ProcessPool(() => 1, { maxQueued: 1, queueTimeoutMs: cfg.timeoutMs ?? 180000 }),
  activeRuns: new api.ActiveRuns(),
});
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = [];

function safeErrorCategory(error) {
  return typeof error?.code === 'string' ? error.code : (typeof error?.name === 'string' ? error.name : 'Error');
}

async function runCase(c) {
  const expected = expectedCases.get(c.caseId);
  const row = {
    caseId: c.caseId,
    semantic: c.semantic,
    expectedOutcome: expected,
    model: cfg.model,
    reasoningEffort: cfg.reasoningEffort,
    utc: new Date().toISOString(),
    verificationPass: false,
    businessSuccess: false,
    calculationCalls: 0,
    usageObserved: false,
  };
  let run;
  let timer;
  try {
    run = await api.startWeComAgentRun(
      executor,
      {
        runId: randomUUID(),
        prompt: api.buildRiskIntentPrompt(c.text),
        cwd: cfg.cwd,
        model: cfg.model,
        reasoningEffort: cfg.reasoningEffort,
        sandbox: 'read-only',
      },
      randomUUID(),
    );
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      void run.stop();
    }, cfg.timeoutMs ?? 180000);
    let output = '';
    for await (const event of run.events) {
      if (event.type === 'usage') { row.usageObserved = true; row.usage = event; }
      if (event.type === 'final_text') output = event.content ?? output;
      if (event.type === 'error') throw new Error(timedOut ? 'model-timeout' : 'model-error');
    }
    await run.waitForExit(1500).catch(() => false);
    if (timedOut) throw new Error('model-timeout');

    const draft = api.parseRiskIntentOutputPartial(output, c.text);
    row.draftHash = hash(draft);
    const state = await api.normalizeRiskDraft(c.text, draft, client);
    row.stage = state.stage;
    if (expected === 'non-confirm') {
      row.field = state.field;
      row.verificationPass = state.stage === 'freeform' && state.field === 'amount' && !state.draft.amountText;
      row.outcome = row.verificationPass ? 'expected-amount-clarification' : 'unexpected-state';
      if (!row.verificationPass) row.errorCategory = 'unexpected-confirm';
      return row;
    }
    if (state.stage !== 'confirm') {
      row.outcome = 'unexpected-non-confirm';
      row.errorCategory = 'non-confirm-stage';
      return row;
    }
    row.confirmStateHash = hash(state);
    row.productMatch = state.product === c.expectedProduct;
    row.securityMatch = state.security?.code === c.expectedSecurityCode;
    if (!row.productMatch || !row.securityMatch) {
      row.errorCategory = 'master-data-mismatch';
      row.outcome = 'master-data-mismatch';
      return row;
    }

    const trapped = new Proxy({}, {
      get: () => async () => {
        row.calculationCalls += 1;
        throw new Error('unexpected-service-call');
      },
    });
    const router = new api.WeComRiskRouter(trapped);
    const result = await router.executeConfirmed(state);
    row.routeIntent = result.intent;
    row.outcome = 'expected-router-rejection';
    row.verificationPass = row.calculationCalls === 0 && result.intent === 'risk-error';
    if (!row.verificationPass) row.errorCategory = 'invalid-input-was-executable';
    return row;
  } catch (error) {
    row.errorCategory = safeErrorCategory(error);
    row.outcome = 'verification-error';
    return row;
  } finally {
    clearTimeout(timer);
    if (run && !(await run.waitForExit(1500))) await run.stop();
  }
}

let closeError;
try {
  for (const c of cases) {
    const row = await runCase(c);
    rows.push(row);
    appendFileSync(`${out}/samples.jsonl`, JSON.stringify(row) + '\n');
  }
} finally {
  try {
    await client.close();
  } catch (error) {
    closeError = safeErrorCategory(error);
  }
}

const failed = rows.filter((row) => !row.verificationPass);
const summary = {
  model: cfg.model,
  reasoningEffort: cfg.reasoningEffort,
  n: rows.length,
  verificationPassed: rows.length - failed.length,
  verificationFailed: failed.length,
  confirmStates: rows.filter((row) => row.stage === 'confirm').length,
  nonConfirmStates: rows.filter((row) => row.stage && row.stage !== 'confirm').length,
  businessSuccess: rows.filter((row) => row.businessSuccess === true).length,
  calculationCalls: rows.reduce((sum, row) => sum + row.calculationCalls, 0),
  closeError: closeError ?? null,
  boundary: 'Real Spark AI and master-data normalization, then Router trap; no formal calculation, business write, or WeCom callback',
};
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
if (failed.length) process.exitCode = 2;
