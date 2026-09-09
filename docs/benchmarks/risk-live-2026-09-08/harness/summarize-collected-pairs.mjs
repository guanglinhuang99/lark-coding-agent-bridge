#!/usr/bin/env node
// Read-only summary for bounded collected-pair runs. It never starts a client or writes output.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  console.log('node docs/benchmarks/risk-live-2026-09-08/harness/summarize-collected-pairs.mjs <output directory>');
  process.exit(args.length === 0 ? 1 : 0);
}
if (args.length !== 1) throw new Error('Usage: summarize-collected-pairs.mjs <output directory>');

const directory = resolve(args[0]);
if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`Output directory not found: ${directory}`);
const readJsonLines = file => readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch { throw new Error(`Invalid JSON at ${file}:${index + 1}`); }
});
const samplesPath = join(directory, 'samples.jsonl');
const pairsPath = join(directory, 'pairs.jsonl');
if (!existsSync(samplesPath) || !existsSync(pairsPath)) throw new Error('Output directory must contain samples.jsonl and pairs.jsonl');
const rows = readJsonLines(samplesPath);
const pairRecords = readJsonLines(pairsPath);
const keyOf = (scenario, pair) => `${JSON.stringify(scenario)}\u0000${JSON.stringify(pair)}`;
const attemptKeys = new Set(pairRecords.map(item => keyOf(item.scenario, item.pair)));
const rowsByAttempt = new Map();
for (const row of rows) {
  if (!row || typeof row.scenario !== 'string' || !Number.isInteger(row.pair)) throw new Error('Every sample must have scenario and integer pair');
  const key = keyOf(row.scenario, row.pair);
  attemptKeys.add(key);
  const batch = rowsByAttempt.get(key) ?? [];
  batch.push(row);
  rowsByAttempt.set(key, batch);
}

const attempts = [...attemptKeys].map(key => {
  const separator = key.indexOf('\u0000');
  const scenario = JSON.parse(key.slice(0, separator));
  const pair = JSON.parse(key.slice(separator + 1));
  return { scenario, pair, rows: rowsByAttempt.get(key) ?? [], record: pairRecords.find(item => item.scenario === scenario && item.pair === pair) ?? null };
});
const versions = ['before', 'after'];
const finiteMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const rowByVersion = batch => Object.fromEntries(versions.map(version => [version, batch.filter(row => row.version === version)]));
const pairStatus = item => {
  const byVersion = rowByVersion(item.rows);
  const completeRows = versions.every(version => byVersion[version].length === 1);
  const before = completeRows ? byVersion.before[0] : null;
  const after = completeRows ? byVersion.after[0] : null;
  const consistent = Boolean(before && after && before.success === true && after.success === true && before.resultHash !== null && before.resultHash !== undefined && before.resultHash === after.resultHash && before.inputHash === after.inputHash);
  const completeConsistent = consistent && finiteMs(before.totalMs) && finiteMs(after.totalMs);
  return { byVersion, completeRows, consistent, completeConsistent };
};
const nearestRankP95 = values => values.length ? values.slice().sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
const median = values => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const categoryCounts = values => values.reduce((counts, value) => {
  const category = value || 'unknown';
  counts[category] = (counts[category] ?? 0) + 1;
  return counts;
}, {});

const scenarios = [...new Set(attempts.map(item => item.scenario))].sort();
const report = {
  kind: 'read-only-collected-pair-summary',
  sourceDirectory: directory,
  versions: Object.fromEntries(versions.map(version => [version, [...new Set(rows.filter(row => row.version === version).map(row => row.commit))].filter(Boolean)])),
  rows: rows.length,
  scenarios: {},
};
for (const scenario of scenarios) {
  const scenarioAttempts = attempts.filter(item => item.scenario === scenario).sort((a, b) => a.pair - b.pair);
  const statuses = scenarioAttempts.map(pairStatus);
  const usable = scenarioAttempts.filter((_, index) => statuses[index].completeConsistent);
  const allAttempts = {};
  for (const version of versions) {
    const rowsByAttempt = scenarioAttempts.map((item, index) => statuses[index].byVersion[version]);
    const observedRows = rowsByAttempt.flat();
    const successful = rowsByAttempt.filter(batch => batch.length === 1 && batch[0].success === true);
    allAttempts[version] = {
      n: scenarioAttempts.length,
      observedRows: observedRows.length,
      success: successful.length,
      failures: scenarioAttempts.length - successful.length,
      missingRows: rowsByAttempt.filter(batch => batch.length === 0).length,
      duplicateRows: rowsByAttempt.filter(batch => batch.length > 1).length,
      successRate: scenarioAttempts.length ? successful.length / scenarioAttempts.length : null,
      failureCategories: categoryCounts(observedRows.filter(row => row.success !== true).map(row => row.errorCategory)),
    };
  }
  const pairFailureCategories = {};
  for (let index = 0; index < scenarioAttempts.length; index += 1) {
    const item = scenarioAttempts[index];
    const status = statuses[index];
    if (status.completeConsistent) continue;
    const rowFailures = item.rows.filter(row => row.success !== true).map(row => row.errorCategory || 'unknown');
    if (rowFailures.length) for (const category of rowFailures) pairFailureCategories[category] = (pairFailureCategories[category] ?? 0) + 1;
    else if (!status.completeRows) pairFailureCategories['incomplete-pair'] = (pairFailureCategories['incomplete-pair'] ?? 0) + 1;
    else if (!status.consistent) pairFailureCategories['pair-result-or-input-mismatch'] = (pairFailureCategories['pair-result-or-input-mismatch'] ?? 0) + 1;
  }
  const timings = {};
  for (const version of versions) {
    const values = usable.map(item => {
      const status = pairStatus(item);
      return status.byVersion[version][0].totalMs;
    });
    timings[version] = { n: values.length, medianMs: median(values), p95Ms: nearestRankP95(values) };
  }
  const beforeMedian = timings.before.medianMs;
  const afterMedian = timings.after.medianMs;
  report.scenarios[scenario] = {
    attempts: scenarioAttempts.length,
    usablePairs: usable.length,
    failures: scenarioAttempts.length - usable.length,
    failureCategories: pairFailureCategories,
    allAttempts,
    completeConsistentPairs: timings,
    absoluteReductionMs: beforeMedian !== null && afterMedian !== null ? beforeMedian - afterMedian : null,
    reductionPercent: beforeMedian !== null && afterMedian !== null && beforeMedian !== 0 ? 100 * (1 - afterMedian / beforeMedian) : null,
  };
}
console.log(JSON.stringify(report, null, 2));
