#!/usr/bin/env node
// Prepare/run only the remaining Spark intent pairs against the fixed before/after refs.
// The private cases file is read locally and is never copied into the repository.
// This wrapper performs no WeCom transport and the benchmark performs read-only calls.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};

if (args.includes('--help')) {
  console.log([
    'node docs/benchmarks/risk-live-2026-09-08/harness/risk-intent-spark-completion.mjs',
    '--root <fixed acceptance root>',
    '--python <configured Python>',
    '--service <risk-service>',
    '--cases <private ai-performance-private.json>',
    '--out <new private output directory>',
    '[--model gpt-5.3-codex-spark|gpt-5.5]',
    '[--scenario natural_language|amount_correction|tenor_correction|compound_correction]',
    '[--collect-input-failures]',
  ].join(' '));
  process.exit(0);
}

const root = resolve(option('--root', '/private/tmp/wecom-live-20260908'));
const python = option('--python', process.env.WECOM_RISK_PYTHON);
const service = option('--service', process.env.WECOM_RISK_SERVICE_DIR);
const sourceCases = resolve(option('--cases', `${root}/ai-performance-private.json`));
const out = resolve(option('--out', `${root}/spark-completion-live`));
const requestedModel = option('--model', 'gpt-5.3-codex-spark');
const benchmark = resolve(`${process.cwd()}/docs/benchmarks/risk-live-2026-09-08/harness/risk-live-benchmark.mjs`);
const requiredNames = [
  'natural_language',
  'amount_correction',
  'tenor_correction',
  'compound_correction',
];
const expectedBefore = 'f00d635b36536dccac7ebeb73235e7dcf584d49b';
const expectedAfter = '6d28a6a673b3d400f3d30e15018b5a5621d545cf';
const supportedModels = new Set(['gpt-5.3-codex-spark', 'gpt-5.5']);

if (!python || !service) throw new Error('Preflight: require --python and --service');
if (!supportedModels.has(requestedModel)) throw new Error(`Preflight: unsupported model ${requestedModel}`);
if (!existsSync(sourceCases)) throw new Error(`Preflight: private cases file not found: ${sourceCases}`);
if (!existsSync(benchmark)) throw new Error(`Preflight: benchmark harness not found: ${benchmark}`);
if (existsSync(out)) throw new Error(`Output already exists; choose a new directory: ${out}`);

const fixedVersions = {
  before: { directory: `${root}/before`, commit: expectedBefore },
  after: { directory: `${root}/after`, commit: expectedAfter },
};
for (const version of Object.values(fixedVersions)) {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: version.directory, encoding: 'utf8' }).trim();
  if (actual !== version.commit) throw new Error(`Preflight: ${version.directory} is at ${actual}, expected ${version.commit}`);
}
if (readFileSync(`${root}/before/pnpm-lock.yaml`, 'utf8') !== readFileSync(`${root}/after/pnpm-lock.yaml`, 'utf8')) {
  throw new Error('Preflight: fixed before/after lockfiles differ');
}

const source = JSON.parse(readFileSync(sourceCases, 'utf8'));
if (source.ai?.model !== requestedModel) {
  throw new Error(`Preflight: expected ${requestedModel}, got ${source.ai?.model ?? '<missing>'}`);
}
if (source.ai?.reasoningEffort && source.ai.reasoningEffort !== 'low') {
  throw new Error(`Preflight: expected low reasoning effort, got ${source.ai.reasoningEffort}`);
}
if (!Array.isArray(source.cases)) throw new Error('Preflight: private cases must contain an array');

const byName = new Map(source.cases.map((item) => [item.name, item]));
const requestedScenario = option('--scenario', null);
if(requestedScenario && !requiredNames.includes(requestedScenario)) throw Error('Unknown scenario');
const selected = (requestedScenario ? [requestedScenario] : requiredNames).map((name) => {
  const item = byName.get(name);
  if (!item) throw new Error(`Preflight: missing required case ${name}`);
  if (item.samples !== 30) throw new Error(`Preflight: ${name} must contain exactly 30 pairs`);
  if (item.approvedForLocalCalculation !== true) throw new Error(`Preflight: ${name} is not approved for local calculation`);
  return item;
});
const selectedConfig = {
  ...source,
  ai: { ...source.ai, model: requestedModel, reasoningEffort: 'low' },
  cases: selected,
};

mkdirSync(dirname(out), { recursive: true });
// This file contains the already-private test text and stays outside Git.
const selectedCases = `${out}.private-cases.json`;
writeFileSync(selectedCases, JSON.stringify(selectedConfig, null, 2) + '\n', { mode: 0o600 });

const childEnv = { ...process.env };
for (const key of ['NO_PROXY', 'no_proxy']) {
  const values = String(childEnv[key] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.includes('10.8.11.57')) values.push('10.8.11.57');
  childEnv[key] = values.join(',');
}

const childArgs = [
  benchmark,
  '--root', root,
  '--python', python,
  '--service', service,
  '--data', `${root}/data-versions.json`,
  '--out', out,
  '--only-cases',
  '--cases', selectedCases,
];
if (args.includes('--collect-input-failures')) childArgs.push('--collect-input-failures');
console.log(JSON.stringify({
  mode: requestedModel === 'gpt-5.3-codex-spark' ? 'fixed-before-after-spark-completion' : 'fixed-before-after-model-completion',
  model: requestedModel,
  reasoningEffort: 'low',
  versions: { before: expectedBefore, after: expectedAfter },
  scenarios: selected.map(({ name, samples }) => ({ name, pairs: samples })),
  totalPairs: selected.reduce((sum, item) => sum + item.samples, 0),
  totalRows: selected.reduce((sum, item) => sum + item.samples * 2, 0),
  collectInputFailures: args.includes('--collect-input-failures'),
  maxAttemptsPerScenario: args.includes('--collect-input-failures') ? 40 : null,
  order: 'AB/BA alternation within every scenario',
  output: out,
  privateCases: selectedCases,
  transport: 'no WeCom platform transport',
  writes: 'read-only risk client; no business ledger writes',
}, null, 2));

const result = spawnSync(process.execPath, childArgs, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
