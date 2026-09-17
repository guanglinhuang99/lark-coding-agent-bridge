# Risk shared business migration — 2026-09-10

## Outcome

| Gate | Status | Evidence |
| --- | --- | --- |
| CODE IMPLEMENTED | YES | Shared checker owns the bounded memoization; the WeCom bridge no longer installs a duplicate wrapper. |
| SOURCE INSTALLED | YES | The approved local backend source imports as optimized in two independent offline processes. |
| RUNNING PROCESS VERIFIED | NO | No Lark/WeCom process was restarted, no release or `.connect-package` was changed, and no deployment was performed. |

This is a shared-source correction, not a second bridge. It does not change a risk result, cache holdings/aliases/market/credit decisions, add a Lark fast path, or redirect a Lark query.

## Ownership and callers

- The current repository contains the tracked convenience link `risk-service -> ../risk-service`; its resolved target is the explicitly approved `/Users/guanglin/Sync/risk-service` root.
- The backend is not a Git checkout. A bounded filesystem inspection found no symlinks below it. The changed file is a regular, user-owned file with link count 1: `linked_sources/portfolio_limits/check_portfolio_limits.py`.
- The root backend `app.py` prepends `linked_sources/portfolio_limits` and imports `connect_app` and `credit_query`. HTTP and MCP pretrade calls reach `portfolio_limits_web`, which imports the same `check_portfolio_limits` module. The full and simplified CLI entrypoints also import/use that checker. Therefore imports through local HTTP/MCP/CLI and the WeCom direct bridge resolve the same decorated functions without a WeCom startup installer.
- The separate normalization in `portfolio_restriction_checks.py` has different missing-value semantics and was intentionally left unchanged.

## Shared implementation contract

`memoize_short_text` now lives beside the authoritative functions, and `clean_text` plus `normalize_product_name` are decorated at definition time.

- Only values where `type(value) is str` and `len(value) <= 256` enter each function's LRU.
- Each function has its own 4,096-entry bound.
- Nonstrings, mutable/custom `__str__` inputs, string subclasses, and longer strings bypass caching.
- Exceptions are not cached; results remain strings; `functools.wraps` preserves callable metadata.
- `canonical_product_name_for_holding` and its mutable alias table are not cached.

The WeCom bridge reports a fixed, data-free `business_capabilities` object in its ready event. New shared source reports `optimized`; old shared source reports `unoptimized` while readiness and business calls continue normally. The TypeScript client accepts only the two known function rows, booleans, and numeric/null limits before logging the diagnostic.

## Files and hashes

| File | Before SHA-256 | After SHA-256 |
| --- | --- | --- |
| backend `linked_sources/portfolio_limits/check_portfolio_limits.py` | `1b7395c527753b7d4f3de1acf778a0761f04eaec1bacdd7cbcc754ce4ce5eecb` | `2805a2b8a7b5186c3240c48889b57dee07dfc14dd110a8ff848d2f0349ac0830` |
| `src/wecom/risk/direct_bridge.py` | `cce6da1375c782050c3fe830ab3ac900e7ad4f713b0d06a1507f7ec282f5c389` | `0c87e1bf23d9cf4504a6dc2650beb40db77445611a4d38fbbc1432fd636645bc` |

The private byte-identical backend original is at `.codex-handoff/risk-shared-business-20260910/backend-before/check_portfolio_limits.py`; `.codex-handoff/` is ignored. `cmp` returned 0 before editing.

The checked reproduction patch is `docs/patches/risk-service-shared-text-memoization-20260910.patch`, SHA-256 `a408f3914ed5ebcda6070d434277eefa9bc5b043b1b3b0ae262b0cc2d147e18a`. Applying it to the retained preimage produced the installed after hash exactly.

Guarded apply from the backend root:

```sh
(
set -eu
test "$(shasum -a 256 linked_sources/portfolio_limits/check_portfolio_limits.py | awk '{print $1}')" = "1b7395c527753b7d4f3de1acf778a0761f04eaec1bacdd7cbcc754ce4ce5eecb"
patch --dry-run -p1 < /Users/guanglin/Sync/wecom-bot/docs/patches/risk-service-shared-text-memoization-20260910.patch
patch -p1 < /Users/guanglin/Sync/wecom-bot/docs/patches/risk-service-shared-text-memoization-20260910.patch
test "$(shasum -a 256 linked_sources/portfolio_limits/check_portfolio_limits.py | awk '{print $1}')" = "2805a2b8a7b5186c3240c48889b57dee07dfc14dd110a8ff848d2f0349ac0830"
)
```

Guarded rollback uses the same versioned patch and refuses an unexpected source:

```sh
(
set -eu
test "$(shasum -a 256 linked_sources/portfolio_limits/check_portfolio_limits.py | awk '{print $1}')" = "2805a2b8a7b5186c3240c48889b57dee07dfc14dd110a8ff848d2f0349ac0830"
patch --dry-run -R -p1 < /Users/guanglin/Sync/wecom-bot/docs/patches/risk-service-shared-text-memoization-20260910.patch
patch -R -p1 < /Users/guanglin/Sync/wecom-bot/docs/patches/risk-service-shared-text-memoization-20260910.patch
test "$(shasum -a 256 linked_sources/portfolio_limits/check_portfolio_limits.py | awk '{print $1}')" = "1b7395c527753b7d4f3de1acf778a0761f04eaec1bacdd7cbcc754ce4ce5eecb"
)
```

## Offline verification

Production Python: `/Users/guanglin/.lark-channel/releases/wecom-risk-20260908-40e196ce3872/python-runtime/bin/python`.

- Shared text regression: 11/11 passed, exit 0. This retains the previous eight cases and adds original-function equivalence, dynamic alias updates, backend import without WeCom, capability fallback, and independent backend/bridge subprocess imports.
- WeCom risk client focus: 21/21 passed, exit 0.
- Python compile for the backend checker and bridge: exit 0 with bytecode directed to `/private/tmp`.
- Isolated snapshot: 628 regular files plus the tracked `risk-service` link matched the source snapshot; existing `node_modules` was linked, not reinstalled. Node was v24.19.0.
- First full run (snapshot without `.git`, sandboxed loopback): 160 files passed, 1 skipped; 1,186 tests passed, 1 skipped, 14 environment-only failures. Twelve could not bind a loopback test server (`EPERM`); two intentionally required Git metadata.
- Corrected full run (snapshot with copied Git metadata and approved loopback-only test binding): 162 files passed, 1 skipped; 1,200 tests passed, 1 skipped; exit 0.
- Isolated TypeScript typecheck: exit 0. Isolated server build: exit 0. Live `dist` was not rebuilt.
- Repository `git diff --check`: exit 0.

These are offline regression/import checks, not live risk-query acceptance.

### Final review corrections

After the isolated TypeScript validation, only Python diagnostics/tests were hardened. Capability inspection errors are non-fatal and conservatively report `unoptimized`; no diagnostic exception text is exposed. Tests now distinguish an absent optional backend (11 integration tests explicitly skipped) from an explicitly misconfigured `RISK_SERVICE_DIR` (clear failure), while five portable capability tests still run without a backend.

Final production-Python `unittest discover -s tests/python -p 'test_*.py'`, with explicit shared backend, passed **48 tests, no skips, exit 0**. A fresh private directory containing only the bridge and this test file passed 5 portable tests and explicitly skipped 11 backend tests; an explicit invalid backend path failed with the intended error. No secrets/configuration were copied into this minimal verification directory.

The earlier full-build snapshot was created with rsync excludes rather than a Git-file allowlist. It must remain private, is not a distributable release/evidence bundle, and was not archived or published. Subsequent snapshots must copy only tracked files plus explicitly selected source/tests; never copy ignored local configuration.

Scope: only `clean_text` / `normalize_product_name` CPU memoization moved into the common business definitions. `DailyPQCache`, daemon prewarm and transport-level caches still belong to the current WeCom direct runtime; this task does not claim all prior optimizations or process-local caches are now shared across channels.

## Actual Lark routing

Repository routing and sanitized active-profile inspection agree:

- Lark starts `bin/lark-channel-bridge.mjs`, reaches `startChannel`, and submits chat input to the configured generic Agent.
- The active profile is a personal Codex profile, inherits the normal Codex home, and does not ignore user config.
- The inspected inherited Codex config had no MCP binding whose name contained `risk`. This name-based check does not exclude a differently named tool, per-workspace configuration, a skill/CLI route or a remote risk service; the actual live Lark business call path remains unverified.
- No Lark source imports `RiskDirectClient` or `WeComRiskRouter`; only the WeCom entry constructs that direct bridge.

Therefore WeCom source is proven to import the optimized local shared checker after its next source/release rollout, but the currently running WeCom process was not restarted and is not proven to have loaded it. Lark is not proven to call any risk tool, so it is not proven to use these optimized functions.

The smallest supported reuse integration is to deploy/synchronize this source into the existing risk-service runtime and bind that existing MCP endpoint in the Codex configuration inherited by the Lark profile, then refresh the agent's MCP tool list. Those configuration, deployment, and restart actions were not performed in this source-migration task; no unverified endpoint was silently added or substituted.

## Final observed runtime (2026-09-10)

The final independent launchd check found a concurrent runtime change, not performed by this task: WeCom is now PID **70569**, runs **1**, using `wecom-risk-cpu-20260910-cce6da13/bin/wecom-channel-bridge.mjs`; its Python child is PID **70573**, started at **2026-09-10 21:09:54 +08:00**. Its configured business source is `/Users/guanglin/Sync/risk-service`, while its bridge path points to that earlier CPU candidate release. Lark remains PID **36940**, runs **1**.

This invalidates the older claim that the current WeCom instance is still PID64122/r3. The observed release path alone does not verify which function objects its already-running Python process loaded. This task neither restarted nor replaced that concurrent deployment. The new shared-source bridge/diagnostic changes remain uncommitted and were not packaged or rolled out by this task. Live shared-function capability and the actual Lark risk call path remain unverified.

## Rollout and residual gates

- `.connect-package/linked_sources/portfolio_limits/check_portfolio_limits.py` remains unchanged at the before hash, as required by the prohibition on touching shared dist.
- No commit, staging, push, deployment, live DB probe, business-network validation, message send, permission/proxy/configuration change, or production process action occurred.
- Remaining gates: synchronize the authorized release/deploy source; restart only the intended runtime; observe `optimized` capability metadata; add/verify a real Lark risk MCP binding if Lark risk access is desired; then run separately authorized live semantic acceptance.
