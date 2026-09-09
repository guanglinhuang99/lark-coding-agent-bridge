#!/usr/bin/env node

// Real local risk-service lifecycle acceptance.  This harness never connects to
// WeCom and never calls a mutating business operation.  The only default
// backend operation used for lifecycle timing is search_securities; list_products
// is used as a real blocker for the queue test.

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';

const FIXED_AFTER = '6d28a6a673b3d400f3d30e15018b5a5621d545cf';
const OBSERVATION_MARKER = '__RISK_LIFECYCLE_OBS__';
const DEFAULT_ROOT = '/private/tmp/wecom-live-20260908';
const DEFAULT_PYTHON = '/Users/guanglin/Documents/trae_projects/icube/bin/python';
const DEFAULT_SERVICE = '/Users/guanglin/Sync/risk-service';
const DEFAULT_QUERY = '100115.SZ';
const DEFAULT_FOLLOWUP_QUERY = '260201.IB';
const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_QUEUE_EXPIRY_MS = 100;
const DEFAULT_WAIT_MS = 180_000;

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};

if (argv.includes('--help')) {
  console.log(`Usage:
  node docs/benchmarks/risk-live-2026-09-08/harness/risk-live-lifecycle.mjs \\
    --root /private/tmp/wecom-live-20260908 \\
    --python /Users/guanglin/Documents/trae_projects/icube/bin/python \\
    --service /Users/guanglin/Sync/risk-service \\
    --out /private/tmp/wecom-live-20260908/lifecycle-<new> \\
    [--scenario all|fast-serial,queue,timeout,close,progress-contract] \\
    [--query 100115.SZ] [--followup-query 260201.IB] \\
    [--timeout-ms 250] [--queue-expiry-ms 100]

The default scenarios use real list_products/search_securities through the
fixed after bridge.  Use --preflight-only to validate the fixed source and
prepare the bundle without calling risk-service.  There is no fake backend or
artificial backend delay in this harness.`);
  process.exit(0);
}

process.env.PYTHONDONTWRITEBYTECODE = '1';
for (const variable of [
  'POST_TRADE_HISTORY_DB',
  'PORTFOLIO_MARKET_CACHE',
  'PINS_CACHE_DIR',
  'PINS_DATA_DIR',
]) {
  if (process.env[variable]) {
    throw new Error(`Preflight: inherited ${variable} must be unset for isolated state`);
  }
}

const root = resolve(option('--root', DEFAULT_ROOT));
const after = resolve(option('--after', join(root, 'after')));
const python = resolve(option('--python', process.env.WECOM_RISK_PYTHON || DEFAULT_PYTHON));
const service = resolve(option('--service', process.env.WECOM_RISK_SERVICE_DIR || DEFAULT_SERVICE));
const query = String(option('--query', DEFAULT_QUERY));
const followupQuery = String(option('--followup-query', DEFAULT_FOLLOWUP_QUERY));
const timeoutMs = positiveNumber(option('--timeout-ms', String(DEFAULT_TIMEOUT_MS)), 'timeout-ms');
const queueExpiryMs = positiveNumber(
  option('--queue-expiry-ms', String(DEFAULT_QUEUE_EXPIRY_MS)),
  'queue-expiry-ms',
);
const waitMs = positiveNumber(option('--wait-ms', String(DEFAULT_WAIT_MS)), 'wait-ms');
const scenarioArgument = String(option('--scenario', 'all'));
const preflightOnly = argv.includes('--preflight-only');
const scenarioNames = parseScenarios(scenarioArgument);

const defaultOutName = `lifecycle-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${process.pid}`;
const out = resolve(option('--out', join(root, defaultOutName)));
if (existsSync(out)) throw new Error(`Output already exists; choose a new directory: ${out}`);
const rawProtocolLogPath = join(out, 'raw-protocol.jsonl');

const bridgePath = join(after, 'src/wecom/risk/direct_bridge.py');
const clientSourcePath = join(after, 'src/wecom/risk/client.ts');
const progressSourcePath = join(after, 'src/wecom/risk/progress.ts');

preflightSource();
mkdirSync(out, { recursive: true });
mkdirSync(join(out, 'state'), { recursive: true });

const observerWrapperPath = join(out, 'risk-lifecycle-observer.py');
writeFileSync(observerWrapperPath, observerWrapperSource(), { encoding: 'utf8', mode: 0o600 });

const bundledApiPath = await bundleAfterSources();
const api = await import(pathToFileURL(bundledApiPath));
const sourceMetadata = {
  kind: 'real-risk-lifecycle',
  generatedAt: new Date().toISOString(),
  afterCommit: FIXED_AFTER,
  afterRoot: after,
  bridgeSource: bridgePath,
  bridgeSha256: sha256File(bridgePath),
  clientSource: clientSourcePath,
  clientSha256: sha256File(clientSourcePath),
  progressSource: progressSourcePath,
  progressSha256: sha256File(progressSourcePath),
  python,
  pythonVersion: pythonVersion(),
  service,
  node: process.version,
  workers: 1,
  defaultClientTimeoutMs: 180_000,
  startupTimeoutMs: 30_000,
  queryHash: digest(query),
  followupQueryHash: digest(followupQuery),
  timeoutMs,
  queueExpiryMs,
  waitMs,
  observationBoundary: {
    wrapper: observerWrapperPath,
    records: 'method entry/exit, argument hash, thread id and outcome only',
    source: 'wrapper imports and invokes the fixed after direct_bridge.py; it does not replace service methods or add delay',
    limitation: 'method entry proves DirectRiskService.call was entered, not the number of SQL statements inside risk-service',
    argumentHash: 'sha256 of UTF-8 compact JSON with recursively sorted object keys; matches Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)',
    rawProtocolLog: rawProtocolLogPath,
  },
};
writeFileSync(join(out, 'environment.json'), `${JSON.stringify(sourceMetadata, null, 2)}\n`, 'utf8');

if (preflightOnly) {
  writeFileSync(
    join(out, 'summary.json'),
    `${JSON.stringify({ status: 'preflight-only', scenarios: {} }, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({ status: 'preflight-only', out, afterCommit: FIXED_AFTER }, null, 2));
  process.exit(0);
}

const records = [];
const eventLogPath = join(out, 'events.jsonl');
const protocolLogPath = join(out, 'protocol.jsonl');
const stateSequence = { value: 0 };


function parseScenarios(value) {
  const names = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (names.length === 0 || names.includes('all')) {
    return ['fast-serial', 'queue', 'timeout', 'close', 'progress-contract'];
  }
  const allowed = new Set(['fast-serial', 'queue', 'timeout', 'close', 'progress-contract']);
  for (const name of names) {
    if (!allowed.has(name)) throw new Error(`Unknown scenario: ${name}`);
  }
  return [...new Set(names)];
}

function positiveNumber(raw, name) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
}

function preflightSource() {
  if (!existsSync(after)) throw new Error(`Missing fixed after checkout: ${after}`);
  if (!existsSync(bridgePath)) throw new Error(`Missing fixed after bridge: ${bridgePath}`);
  if (!existsSync(clientSourcePath)) throw new Error(`Missing fixed after client: ${clientSourcePath}`);
  if (!existsSync(progressSourcePath)) throw new Error(`Missing fixed after progress: ${progressSourcePath}`);
  if (!existsSync(python)) throw new Error(`Missing configured Python: ${python}`);
  if (!existsSync(service)) throw new Error(`Missing configured risk-service: ${service}`);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: after, encoding: 'utf8' }).trim();
  if (head !== FIXED_AFTER) throw new Error(`Wrong after checkout HEAD: ${head}`);
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'src'], { cwd: after, stdio: 'pipe' });
  } catch {
    throw new Error('Fixed after checkout has modified src; refusing to mix source versions');
  }
  try {
    execFileSync(
      python,
      ['-c', 'import azpy, pandas, pins, openpyxl'],
      { cwd: service, stdio: 'pipe', timeout: 30_000 },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`risk Python dependency preflight failed: ${detail}`);
  }
}

function pythonVersion() {
  try {
    return execFileSync(python, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return 'unobserved';
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function argsHash(args) {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

async function bundleAfterSources() {
  const entry = join(out, 'after-lifecycle-entry.ts');
  const bundle = join(out, 'after-lifecycle-client.mjs');
  writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(clientSourcePath)};`,
      `export * from ${JSON.stringify(progressSourcePath)};`,
    ].join('\n') + '\n',
    'utf8',
  );
  const requireAfter = createRequire(join(after, 'package.json'));
  const esbuild = createRequire(requireAfter.resolve('tsup')).resolve('esbuild');
  execFileSync(
    join(dirname(esbuild), '../bin/esbuild'),
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--banner:js=import {createRequire as __cr} from "node:module"; const require=__cr(import.meta.url);',
      `--outfile=${bundle}`,
    ],
    { cwd: after, stdio: 'pipe' },
  );
  return bundle;
}

function observerWrapperSource() {
  return `#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

MARKER = ${JSON.stringify(OBSERVATION_MARKER)}
fixed_path = Path(${JSON.stringify(bridgePath)}).resolve()
spec = importlib.util.spec_from_file_location("fixed_after_direct_bridge", fixed_path)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load fixed bridge: {fixed_path}")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

write_lock = threading.Lock()

def emit(event, method, args, started, outcome=None):
    payload = {
        "event": event,
        "method": method,
        "args_hash": hashlib.sha256(json.dumps(args, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")).hexdigest(),
        "thread": threading.get_ident(),
        "monotonic": time.monotonic(),
    }
    if outcome is not None:
        payload["outcome"] = outcome
    if started is not None:
        payload["duration_ms"] = round((time.monotonic() - started) * 1000, 3)
    with write_lock:
        print(MARKER + json.dumps(payload, ensure_ascii=False, separators=(",", ":")), file=sys.stderr, flush=True)

original_call = bridge.DirectRiskService.call

def observed_call(self, method, args, progress):
    started = time.monotonic()
    emit("start", method, args, started)
    try:
        value = original_call(self, method, args, progress)
    except BaseException:
        emit("end", method, args, started, "error")
        raise
    emit("end", method, args, started, "success")
    return value

bridge.DirectRiskService.call = observed_call
sys.argv = [str(fixed_path)] + sys.argv[1:]
raise SystemExit(bridge.main())
`;
}

class ObservationStream {
  constructor(label) {
    this.label = label;
    this.events = [];
    this.waiters = [];
  }

  line(line) {
    if (!line.startsWith(OBSERVATION_MARKER)) return;
    let parsed;
    try {
      parsed = JSON.parse(line.slice(OBSERVATION_MARKER.length));
    } catch {
      return;
    }
    const event = { label: this.label, at: performance.now(), ...parsed };
    this.events.push(event);
    appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, 'utf8');
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }

  waitFor(predicate, timeout = waitMs) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          rejectPromise(new Error(`observation timeout: ${this.label}`));
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }
}

class BridgeProtocolError extends Error {
  constructor(message, code = 'bridge-error') {
    super(message);
    this.name = 'BridgeProtocolError';
    this.code = code;
  }
}

class ObservedBridge {
  constructor(label, stateDir) {
    this.label = label;
    this.stateDir = stateDir;
    this.observation = new ObservationStream(label);
    this.messages = [];
    this.sent = [];
    this.pending = new Map();
    this.closed = false;
    this.child = spawn(
      python,
      ['-u', observerWrapperPath, '--service-dir', service, '--state-dir', stateDir, '--workers', '1'],
      { cwd: service, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } },
    );
    this.exitPromise = new Promise((resolvePromise) => {
      this.child.once('exit', (code, signal) => {
        const exit = { code, signal, at: performance.now() };
        this.exitInfo = exit;
        this.failAll(new BridgeProtocolError(
          `bridge exited: code=${code ?? ''} signal=${signal ?? ''}`,
          'bridge-process',
        ));
        resolvePromise(exit);
      });
    });
    this.child.once('error', (error) => this.failAll(new BridgeProtocolError(
      error instanceof Error ? error.message : String(error),
      'bridge-process',
    )));
    const stdout = createInterface({ input: this.child.stdout });
    stdout.on('line', (line) => this.handleLine(line));
    const stderr = createInterface({ input: this.child.stderr });
    stderr.on('line', (line) => this.observation.line(line));
    this.startPromise = this.waitForReady();
  }

  async waitForReady() {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      if (this.messages.some((message) => message.type === 'ready')) return;
      if (this.child.exitCode !== null) throw new BridgeProtocolError('bridge exited before ready', 'bridge-start');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new BridgeProtocolError('bridge startup timed out', 'bridge-start-timeout');
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const event = { at: performance.now(), type: message.type || 'unknown', id: message.id || null };
    this.messages.push(message);
    appendFileSync(protocolLogPath, `${JSON.stringify({ label: this.label, ...event })}\n`, 'utf8');
    const pending = message.id ? this.pending.get(String(message.id)) : undefined;
    if (!pending || message.type === 'progress') return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.id));
    if (message.type === 'result') pending.resolve(message.data);
    else pending.reject(new BridgeProtocolError(String(message.error || 'bridge request failed'), message.code || 'direct-error'));
  }

  request(method, args, requestTimeoutMs = 180_000) {
    if (this.closed || this.child.exitCode !== null || !this.child.stdin.writable) {
      throw new BridgeProtocolError('bridge is closed', 'bridge-closed');
    }
    const id = randomUUID();
    const request = { id, method, args, timeout_ms: requestTimeoutMs };
    const watchdogMs = Math.max(waitMs, requestTimeoutMs + 5_000);
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new BridgeProtocolError(
          `bridge protocol watchdog expired for ${method}`,
          'bridge-watchdog',
        ));
      }, watchdogMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
    this.sent.push({ at: performance.now(), id, method, argsHash: argsHash(args), requestTimeoutMs, watchdogMs });
    try {
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        this.rejectPending(id, new BridgeProtocolError(error.message, 'bridge-process'));
      });
    } catch (error) {
      this.rejectPending(id, new BridgeProtocolError(
        error instanceof Error ? error.message : String(error),
        'bridge-process',
      ));
    }
    return { id, promise };
  }

  cancel(id) {
    if (this.closed || this.child.exitCode !== null || !this.child.stdin.writable) return false;
    this.sent.push({ at: performance.now(), id, method: 'cancel' });
    try {
      this.child.stdin.write(`${JSON.stringify({ id, method: 'cancel' })}\n`, (error) => {
        if (error) this.rejectPending(id, new BridgeProtocolError(error.message, 'bridge-process'));
      });
    } catch (error) {
      this.rejectPending(id, new BridgeProtocolError(
        error instanceof Error ? error.message : String(error),
        'bridge-process',
      ));
      return false;
    }
    return true;
  }

  async close() {
    if (this.closed) return await this.waitForExit();
    this.closed = true;
    this.failAll(new BridgeProtocolError('bridge closed', 'bridge-closed'));
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
    return await this.waitForExit();
  }

  failAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  rejectPending(id, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  async waitForExit() {
    const graceful = await raceWithTimeout(this.exitPromise, 2_500);
    if (graceful) return graceful;
    if (this.child.exitCode === null) {
      try { this.child.kill('SIGKILL'); } catch { /* child may have exited between checks */ }
    }
    const forced = await raceWithTimeout(this.exitPromise, 1_000);
    if (forced) return forced;
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      try { stream.destroy(); } catch { /* best-effort cleanup of this harness child */ }
    }
    return {
      code: this.child.exitCode,
      signal: this.child.signalCode || 'close-kill-timeout',
      at: performance.now(),
    };
  }
}

async function raceWithTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(null), timeoutMs);
  });
  const result = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return result;
}

function nextStateDir(label) {
  stateSequence.value += 1;
  const path = join(out, 'state', `${label}-${stateSequence.value}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function timedResult(promise) {
  const started = performance.now();
  return promise
    .then((value) => ({ value, elapsedMs: performance.now() - started }))
    .catch((error) => ({ error, elapsedMs: performance.now() - started }));
}

async function forceChildCleanup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGKILL'); } catch { /* best-effort cleanup of this harness child */ }
  await raceWithTimeout(new Promise((resolvePromise) => child.once('exit', resolvePromise)), 1_000);
  if (child.exitCode === null && child.signalCode === null) {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream.destroy(); } catch { /* best-effort cleanup of this harness child */ }
    }
  }
}

function errorView(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    code: error.code || null,
    category: error.code || error.name || 'Error',
  };
}

function appendRecord(record) {
  appendFileSync(join(out, 'samples.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

async function runFastSerialScenario() {
  const label = 'fast-serial';
  const bridge = new ObservedBridge(label, nextStateDir(label));
  const startedAt = performance.now();
  const pingResults = [];
  try {
    await bridge.startPromise;
    for (let index = 0; index < 8; index++) {
      const request = bridge.request('ping', {}, 10_000);
      const result = await timedResult(request.promise);
      pingResults.push({
        index,
        id: request.id,
        ok: !result.error && result.value?.ok === true,
        elapsedMs: result.elapsedMs,
        error: errorView(result.error),
      });
    }
    const starts = bridge.observation.events.filter((event) => event.event === 'start' && event.method === 'ping');
    const ends = bridge.observation.events.filter((event) => event.event === 'end' && event.method === 'ping');
    const assertions = {
      allEightPingRepliesSucceeded: pingResults.length === 8 && pingResults.every((item) => item.ok),
      allEightCallsEnteredFixedBridge: starts.length === 8,
      allEightCallsReturnedFromFixedBridge: ends.length === 8,
      serialReplyOrderPreserved: pingResults.every((item, index) => item.index === index),
    };
    return {
      scenario: label,
      evidence: 'real-bridge',
      status: Object.values(assertions).every(Boolean) ? 'pass' : 'failed',
      elapsedMs: performance.now() - startedAt,
      requests: pingResults,
      backendObservation: { starts, ends },
      assertions,
      limitation: 'ping is a fixed-bridge health method and does not query Pins or SQL. This checks that a completed fast Future does not prevent the next request from being admitted; it is separate from risk-service business-query evidence.',
    };
  } catch (error) {
    return {
      scenario: label,
      evidence: 'real-bridge',
      status: 'blocked',
      error: errorView(error),
      limitation: 'No fast-serial pass is recorded unless all eight real bridge ping requests receive replies.',
    };
  } finally {
    await bridge.close();
  }
}

async function runQueueScenario() {
  const label = 'queue';
  const bridge = new ObservedBridge(label, nextStateDir(label));
  const startedAt = performance.now();
  try {
    await bridge.startPromise;
    const blocker = bridge.request('list_products', {}, waitMs);
    const blockerStart = await bridge.observation.waitFor(
      (event) => event.event === 'start' && event.method === 'list_products',
      waitMs,
    );
    const expired = bridge.request('search_securities', { query }, queueExpiryMs);
    const expiredOutcome = timedResult(expired.promise);
    const cancelled = bridge.request('search_securities', { query: followupQuery }, waitMs);
    // This request is intentionally left unresolved until bridge.close(); attach
    // a rejection handler so the expected close-time cleanup is not an
    // unhandled Node rejection.
    cancelled.promise.catch(() => {});
    const cancelledAt = performance.now();
    const cancelSent = bridge.cancel(cancelled.id);

    const blockerResult = await timedResult(blocker.promise);
    const blockerEnd = await bridge.observation.waitFor(
      (event) => event.event === 'end' && event.method === 'list_products',
      waitMs,
    );
    const expiredResult = await expiredOutcome;
    const ping = bridge.request('ping', {}, 10_000);
    const pingResult = await timedResult(ping.promise);
    const expiredStarted = bridge.observation.events.some(
      (event) => event.event === 'start' && event.method === 'search_securities' && event.args_hash === argsHash({ query }),
    );
    const cancelledStarted = bridge.observation.events.some(
      (event) => event.event === 'start' && event.method === 'search_securities' && event.args_hash === argsHash({ query: followupQuery }),
    );
    const allSearchStarts = bridge.observation.events.filter(
      (event) => event.event === 'start' && event.method === 'search_securities',
    );
    const cancelledMessages = bridge.messages.filter((message) => String(message.id || '') === cancelled.id);
    const expiredSent = bridge.sent.find((item) => item.id === expired.id);
    const blockerOutranExpiry = expiredSent
      ? blockerEnd.at - expiredSent.at > queueExpiryMs
      : false;
    const blockerSucceeded = !blockerResult.error && Array.isArray(blockerResult.value?.products);
    const pingSucceeded = !pingResult.error && pingResult.value?.ok === true;
    const expiryError = expiredResult.error;
    const expiryGuard = Boolean(expiryError && /过期|expired/i.test(String(expiryError.message)));
    const assertions = {
      blockerEnteredRealBackend: blockerStart.event === 'start',
      blockerSucceeded,
      blockerStillRunningWhenQueuedWorkExpired: blockerOutranExpiry,
      expiredRequestReturnedQueueExpiryError: expiryGuard,
      expiredRequestNeverEnteredRealBackend: !expiredStarted,
      cancelledRequestNeverEnteredRealBackend: !cancelledStarted,
      noSearchRequestEnteredRealBackendInQueueScenario: allSearchStarts.length === 0,
      cancelRequestWasWritten: cancelSent,
      cancelledRequestProducedNoProtocolOutput: cancelledMessages.length === 0,
      replacementPingSucceeded: pingSucceeded,
    };
    const allPass = Object.values(assertions).every(Boolean);
    const blocked = !blockerSucceeded || !blockerOutranExpiry;
    return {
      scenario: label,
      evidence: 'real-backend',
      status: allPass ? 'pass' : blocked ? 'blocked' : 'failed',
      startedAt: new Date(Date.now() - Math.round(performance.now() - startedAt)).toISOString(),
      elapsedMs: performance.now() - startedAt,
      queryHashes: { expired: digest(query), cancelled: digest(followupQuery) },
      timings: {
        blockerMs: blockerEnd.at - blockerStart.at,
        queueWaitUntilBlockerEndMs: expiredSent ? blockerEnd.at - expiredSent.at : null,
        cancelToBlockerEndMs: blockerEnd.at - cancelledAt,
        replacementPingMs: pingResult.elapsedMs,
      },
      backendObservation: {
        blocker: { start: blockerStart.at, end: blockerEnd.at },
        allSearchStarts,
        expiredSearchStarts: bridge.observation.events.filter((event) => event.method === 'search_securities' && event.args_hash === argsHash({ query })),
        cancelledSearchStarts: bridge.observation.events.filter((event) => event.method === 'search_securities' && event.args_hash === argsHash({ query: followupQuery })),
      },
      protocol: {
        expired: { id: expired.id, outcome: expiredResult.error ? 'error' : 'result', error: errorView(expiryError) },
        cancelled: { id: cancelled.id, messages: cancelledMessages.length },
        replacement: { id: ping.id, outcome: pingResult.error ? 'error' : 'result' },
      },
      assertions,
      limitation: 'DirectRiskService.call entry is observed; SQL/database execution count is not observed. A blocked result means the real blocker was too fast or the backend could not complete, not that the queue guarantee passed.',
    };
  } catch (error) {
    return {
      scenario: label,
      evidence: 'real-backend',
      status: 'blocked',
      error: errorView(error),
      limitation: 'No queue result is treated as a pass unless the real blocker entered and outlasted the queue expiry window.',
    };
  } finally {
    await bridge.close();
  }
}

async function runTimeoutScenario() {
  const label = 'timeout-running-slot';
  const observation = new ObservationStream(label);
  const client = new api.RiskDirectClient({
    pythonPath: python,
    serviceDir: service,
    stateDir: nextStateDir(label),
    bridgePath: observerWrapperPath,
    workers: 1,
    timeoutMs: 180_000,
    startupTimeoutMs: 30_000,
    onDiagnostic: (line) => observation.line(line),
  });
  const instrument = instrumentClient(client, observation);
  const startedAt = performance.now();
  let child;
  try {
    await client.ensureStarted();
    child = client.child;
    const args = { query };
    const timedIdPromise = instrument.waitForSent((item) => item.method === 'search_securities' && item.argsHash === argsHash(args));
    const first = timedResult(client.call('search_securities', args, undefined, timeoutMs));
    const timedRequest = await timedIdPromise;
    const firstStart = await observation.waitFor(
      (event) => event.event === 'start' && event.method === 'search_securities' && event.args_hash === argsHash(args),
      waitMs,
    );
    const firstOutcome = await first;
    const timeoutAt = performance.now();
    const firstEndBeforeTimeout = observation.events.some(
      (event) => event.event === 'end' && event.method === 'search_securities' && event.at <= timeoutAt,
    );
    const followup = timedResult(client.searchSecurities(followupQuery));
    const followupStart = await observation.waitFor(
      (event) => event.event === 'start' && event.method === 'search_securities' && event.args_hash === argsHash({ query: followupQuery }),
      waitMs,
    );
    const firstEnd = await observation.waitFor(
      (event) => event.event === 'end' && event.method === 'search_securities' && event.args_hash === argsHash(args),
      waitMs,
    );
    const followupOutcome = await followup;
    const cancelSent = instrument.sent.some((item) => item.method === 'cancel' && item.id === timedRequest.id);
    const lateProtocol = instrument.protocol.filter((item) => item.id === timedRequest.id && item.at > timeoutAt);
    const assertions = {
      requestEnteredRealBackend: firstStart.event === 'start',
      clientTimedOut: firstOutcome.error?.code === 'direct-timeout',
      clientSentCancel: cancelSent,
      backendEndedAfterClientTimeout: firstEnd.at > timeoutAt,
      noResultWasDeliveredToTimedOutCall: !lateProtocol.some((item) => item.type === 'result' || item.type === 'error'),
      followupStartedAfterTimedOutBackendEnded: followupStart.at >= firstEnd.at,
      followupSucceeded: !followupOutcome.error && Array.isArray(followupOutcome.value),
      firstEndWasNotAlreadyBeforeTimeout: !firstEndBeforeTimeout,
    };
    const allPass = Object.values(assertions).every(Boolean);
    const tooFast = firstEndBeforeTimeout || firstOutcome.value !== undefined;
    return {
      scenario: label,
      evidence: 'real-backend',
      status: allPass ? 'pass' : tooFast ? 'blocked' : 'failed',
      elapsedMs: performance.now() - startedAt,
      queryHashes: { timed: digest(query), followup: digest(followupQuery) },
      timings: {
        clientTimeoutMs: timeoutAt - startedAt,
        backendAfterTimeoutMs: firstEnd.at - timeoutAt,
        followupWaitMs: followupOutcome.elapsedMs,
      },
      protocol: {
        timedRequestId: timedRequest.id,
        sent: instrument.sent.map((item) => ({ method: item.method, id: item.id, argsHash: item.argsHash || null })),
        lateMessagesForTimedRequest: lateProtocol,
      },
      backendObservation: {
        timed: { start: firstStart.at, end: firstEnd.at },
        followup: { start: followupStart.at },
      },
      assertions,
      limitation: 'The bridge has no cooperative backend cancellation API. A pass proves the running call held the single bridge worker until its real backend call returned and that the timed-out client did not accept a late protocol message; it does not prove the database query was interrupted.',
    };
  } catch (error) {
    return {
      scenario: label,
      evidence: 'real-backend',
      status: 'blocked',
      error: errorView(error),
      limitation: 'A timeout scenario is inconclusive unless the real search_securities call entered backend.call before the client timeout.',
    };
  } finally {
    await client.close();
    await forceChildCleanup(child);
  }
}

async function runCloseScenario() {
  const label = 'client-close';
  const observation = new ObservationStream(label);
  const client = new api.RiskDirectClient({
    pythonPath: python,
    serviceDir: service,
    stateDir: nextStateDir(label),
    bridgePath: observerWrapperPath,
    workers: 1,
    timeoutMs: 180_000,
    startupTimeoutMs: 30_000,
    onDiagnostic: (line) => observation.line(line),
  });
  const instrument = instrumentClient(client, observation);
  const startedAt = performance.now();
  let child;
  const childExitEvents = [];
  try {
    await client.ensureStarted();
    child = client.child;
    child?.once('exit', (code, signal) => {
      childExitEvents.push({ code, signal, at: performance.now() });
    });
    const args = {};
    const requestIdPromise = instrument.waitForSent((item) => item.method === 'list_products' && item.argsHash === argsHash(args));
    const pending = timedResult(client.call('list_products', args, undefined, 180_000));
    const request = await requestIdPromise;
    const backendStart = await observation.waitFor(
      (event) => event.event === 'start' && event.method === 'list_products' && event.args_hash === argsHash(args),
      waitMs,
    );
    const childAliveAtCloseStart = Boolean(
      child && child.exitCode === null && child.signalCode === null,
    );
    const closeStarted = performance.now();
    const closePromise = client.close();
    const pendingOutcome = await pending;
    const closeResult = await closePromise;
    const childExitedWhenCloseReturned = Boolean(
      child && (child.exitCode !== null || child.signalCode !== null),
    );
    await forceChildCleanup(child);
    const childExit = childExitEvents[0] || null;
    const rawAfterClose = instrument.rawProtocol.filter((item) => item.id === request.id && item.at >= closeStarted);
    const acceptedAfterClose = instrument.protocol.filter((item) => item.id === request.id && item.at >= closeStarted);
    const rawLateTerminals = rawAfterClose.filter((item) => item.type === 'result' || item.type === 'error');
    const pendingMapSizeAfterClose = client.pending?.size ?? null;

    const fresh = new api.RiskDirectClient({
      pythonPath: python,
      serviceDir: service,
      stateDir: nextStateDir(`${label}-restart`),
      bridgePath: observerWrapperPath,
      workers: 1,
      timeoutMs: 180_000,
      startupTimeoutMs: 30_000,
    });
    let restartOutcome;
    let freshChild;
    try {
      restartOutcome = await timedResult(fresh.call('ping', {}, undefined, 10_000));
    } finally {
      freshChild = fresh.child;
      await fresh.close();
      await forceChildCleanup(freshChild);
    }
    const assertions = {
      requestEnteredRealBackend: backendStart.event === 'start',
      childAliveAtCloseStart,
      pendingRejectedByClose: pendingOutcome.error?.code === 'direct-process',
      bridgeChildExited: childExitedWhenCloseReturned,
      childExitObservedAfterClose: Boolean(childExit && childExit.at >= closeStarted && childExitedWhenCloseReturned),
      pendingMapClearedAfterClose: pendingMapSizeAfterClose === 0,
      noProtocolTerminalAcceptedAfterClose: !acceptedAfterClose.some((item) => item.type === 'result' || item.type === 'error'),
      rawLateTerminalMessagesWereIgnored: rawLateTerminals.every(
        (raw) => !acceptedAfterClose.some((accepted) => accepted.id === raw.id && accepted.type === raw.type),
      ),
      freshClientRestarted: !restartOutcome.error && restartOutcome.value?.ok === true,
    };
    const allPass = Object.values(assertions).every(Boolean);
    const restartBlocked = Boolean(restartOutcome.error);
    const closedCallFinishedBeforeClose = Boolean(
      pendingOutcome.value !== undefined
      || observation.events.some((event) => event.event === 'end' && event.method === 'list_products' && event.at <= closeStarted),
    );
    return {
      scenario: label,
      evidence: 'real-backend',
      status: allPass ? 'pass' : closedCallFinishedBeforeClose || restartBlocked ? 'blocked' : 'failed',
      elapsedMs: performance.now() - startedAt,
      queryHashes: { closedListProducts: digest(args), restartPing: digest({}) },
      timings: { pendingBeforeCloseMs: closeStarted - backendStart.at, restartMs: restartOutcome.elapsedMs },
      protocol: {
        closedRequestId: request.id,
        messagesAfterClose: rawAfterClose,
        clientAcceptedMessagesAfterClose: acceptedAfterClose,
        rawLateTerminalMessages: rawLateTerminals,
      },
      backendObservation: {
        closed: {
          start: backendStart.at,
          end: observation.events.find((event) => event.event === 'end' && event.method === 'list_products' && event.args_hash === argsHash(args)) || null,
          childAliveAtCloseStart,
          childExit,
        },
      },
      close: {
        closeResolved: closeResult === undefined,
        childExitedWhenCloseReturned,
        pendingMapSizeAfterClose,
      },
      assertions,
      limitation: 'close() terminates this harness-owned bridge child. The fixed bridge does not expose whether the underlying risk-service call finished after process termination; this scenario proves client fencing and restart isolation only.',
    };
  } catch (error) {
    return {
      scenario: label,
      evidence: 'real-backend',
      status: 'blocked',
      error: errorView(error),
      limitation: 'A close scenario is inconclusive unless a real backend call entered before close.',
    };
  } finally {
    await client.close();
    await forceChildCleanup(child);
  }
}

async function runProgressContractScenario() {
  const delivered = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
  const relay = new api.RiskProgressRelay(async (message) => {
    if (delivered.length === 0) await firstBlocked;
    delivered.push(message);
  });
  relay.push('正在读取真实风险进度');
  await Promise.resolve();
  const finishPromise = relay.finish();
  relay.push('迟到的后端进度');
  releaseFirst();
  await finishPromise;
  delivered.push('终态：客户端关闭');
  relay.push('终态之后的迟到进度');
  const assertions = {
    inFlightProgressDrainedBeforeTerminal: delivered[0] === '正在读取真实风险进度',
    lateProgressAfterFinishWasIgnored: !delivered.includes('迟到的后端进度') && !delivered.includes('终态之后的迟到进度'),
    terminalWasAppendedAfterRelayFinished: delivered.at(-1) === '终态：客户端关闭',
  };
  return {
    scenario: 'progress-contract',
    evidence: 'source-contract',
    status: Object.values(assertions).every(Boolean) ? 'pass' : 'failed',
    assertions,
    delivered,
    limitation: 'This uses the fixed after RiskProgressRelay with a controlled sender promise. It is not real backend progress or WeCom transport evidence; run a separately authorized real calculation/transport test before claiming platform progress acceptance.',
  };
}

function instrumentClient(client, observation) {
  const instrument = { sent: [], protocol: [], rawProtocol: [], waiters: [], rawChildren: new WeakSet() };
  const originalHandleLine = client.handleLine.bind(client);
  client.handleLine = (line) => {
    let message;
    try { message = JSON.parse(line); } catch { message = null; }
    if (message && message.type !== 'ready') {
      const event = { at: performance.now(), type: message.type || 'unknown', id: message.id || null };
      instrument.protocol.push(event);
      appendFileSync(protocolLogPath, `${JSON.stringify({ label: observation.label, ...event })}\n`, 'utf8');
    }
    return originalHandleLine(line);
  };
  const observeRawLine = (line) => {
    let message;
    try { message = JSON.parse(line); } catch { message = null; }
    if (!message || message.type === 'ready') return;
    const event = { at: performance.now(), type: message.type || 'unknown', id: message.id || null };
    instrument.rawProtocol.push(event);
    appendFileSync(rawProtocolLogPath, `${JSON.stringify({ label: observation.label, ...event })}\n`, 'utf8');
  };
  const attachRawStdout = (child) => {
    if (instrument.rawChildren.has(child)) return;
    instrument.rawChildren.add(child);
    let buffer = '';
    const consume = (chunk) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.trim()) observeRawLine(line);
      }
    };
    child.stdout.on('data', consume);
    child.stdout.on('end', () => {
      if (buffer.trim()) observeRawLine(buffer);
      buffer = '';
    });
  };
  const originalEnsureStarted = client.ensureStarted.bind(client);
  const instrumentedEnsureStarted = async () => {
    await originalEnsureStarted();
    const child = client.child;
    if (!child?.stdin) throw new Error('RiskDirectClient started without child stdin');
    attachRawStdout(child);
    if (instrument.stdinPatched) return;
    const originalWrite = child.stdin.write;
    child.stdin.write = function (...writeArgs) {
      const value = writeArgs[0];
      const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line);
          const item = {
            at: performance.now(),
            id: request.id || null,
            method: request.method || null,
            argsHash: request.args ? argsHash(request.args) : null,
            requestTimeoutMs: request.timeout_ms ?? null,
          };
          instrument.sent.push(item);
          for (const waiter of [...instrument.waiters]) {
            if (!waiter.predicate(item)) continue;
            instrument.waiters.splice(instrument.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(item);
          }
        } catch {
          // The client only writes JSONL requests; malformed observation input is ignored.
        }
      }
      return originalWrite.apply(this, writeArgs);
    };
    instrument.stdinPatched = true;
  };
  client.ensureStarted = instrumentedEnsureStarted;
  return {
    sent: instrument.sent,
    protocol: instrument.protocol,
    rawProtocol: instrument.rawProtocol,
    waitForSent: (predicate, timeout = waitMs) => {
      const existing = instrument.sent.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolvePromise, rejectPromise) => {
        const waiter = {
          predicate,
          resolve: resolvePromise,
          timer: setTimeout(() => rejectPromise(new Error(`client request observation timeout: ${observation.label}`)), timeout),
        };
        instrument.waiters.push(waiter);
      });
    },
  };
}

function summarize(records) {
  const failed = records.filter((record) => record.status === 'failed');
  const blocked = records.filter((record) => record.status === 'blocked');
  const pass = records.filter((record) => record.status === 'pass');
  const hasRealLifecycle = records.some((record) => record.evidence === 'real-backend' && record.scenario === 'queue' && record.status === 'pass')
    && records.some((record) => record.evidence === 'real-backend' && record.scenario === 'timeout-running-slot' && record.status === 'pass')
    && records.some((record) => record.evidence === 'real-backend' && record.scenario === 'client-close' && record.status === 'pass');
  return {
    kind: 'real-risk-lifecycle',
    afterCommit: FIXED_AFTER,
    status: failed.length > 0 ? 'failed' : blocked.length > 0 ? 'blocked' : hasRealLifecycle ? 'pass' : 'partial',
    realLifecycleComplete: hasRealLifecycle,
    counts: { scenarios: records.length, pass: pass.length, blocked: blocked.length, failed: failed.length },
    scenarios: Object.fromEntries(records.map((record) => [record.scenario, record])),
    evidenceBoundary: {
      realBackend: 'Only records marked real-backend use the actual Python risk-service and fixed after bridge. Their wrapper observes DirectRiskService.call entry/exit and does not count SQL statements.',
      sourceContract: 'progress-contract is source-level lifecycle evidence and must not be reported as real backend or WeCom transport acceptance.',
      platform: 'No WeCom connection, bot message, card callback, or business ledger write is performed.',
      releaseGate: 'A blocked or partial result is not an上线条件 pass; retain the missing evidence and rerun in an idle CPU window with the same fixed runtime configuration.',
    },
  };
}

try {
  for (const scenario of scenarioNames) {
    if (scenario === 'fast-serial') records.push(await runFastSerialScenario());
    else if (scenario === 'queue') records.push(await runQueueScenario());
    else if (scenario === 'timeout') records.push(await runTimeoutScenario());
    else if (scenario === 'close') records.push(await runCloseScenario());
    else if (scenario === 'progress-contract') records.push(await runProgressContractScenario());
    else throw new Error(`Unsupported scenario: ${scenario}`);
    appendRecord(records.at(-1));
  }
} catch (error) {
  const record = {
    scenario: 'harness',
    evidence: 'harness',
    status: 'failed',
    errorCategory: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
  records.push(record);
  appendRecord(record);
}

const summary = summarize(records);
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
if (summary.status === 'failed') process.exitCode = 1;
else if (summary.status === 'blocked' || summary.status === 'partial') process.exitCode = 2;
