# Shared risk channel runtime acceptance — 2026-09-10

## Outcome

`PARTIAL: WECOM VERIFIED; CONNECT DEPLOYED; LARK BINDING BLOCKED`

The shared backend was updated as existing Connect content and the WeCom single-instance cutover completed. Lark was not restarted or modified. Its risk-service binding remains intentionally absent because the ACL-protected health/MCP endpoint could not be verified with intended query authentication, and deployment credentials were not repurposed.

No message was sent, no native-chat test was manufactured, no financial action or business-data query was executed, and no Lark job or live dist was changed.

## Backend change and package parity

- `/Users/guanglin/Sync/risk-service/app.py` now exposes `risk-text-runtime/v1` metadata from the already-loaded checker through `/api/health` and the read-only MCP resource `riskservice://runtime`.
- The fixed function set is only `clean_text` and `normalize_product_name`. Each row contains only `optimized` and safe `max_entries`; broken or legacy metadata falls back to unoptimized without exception text.
- `tests/test_app.py` adds no-startup health, no-DB, legacy/broken fallback, and MCP resource coverage. The existing ten financial MCP tools are unchanged.
- Only `app.py` and `linked_sources/portfolio_limits/check_portfolio_limits.py` were synchronized into `.connect-package`. Both source/package pairs are byte-identical.
- Source/package app SHA-256: `3d52970d2ab3321bf5fbc9b23e778286f5d2cb635b8f56a4aea8ae2ad162e54b`.
- Source/package checker SHA-256: `2805a2b8a7b5186c3240c48889b57dee07dfc14dd110a8ff848d2f0349ac0830`.
- Test SHA-256: `403f455b517ee6f1e52d31f9ca414c589059a4f088fcc00e54d7f09043fce537`.
- Reproducible source patch: `docs/patches/risk-service-runtime-metadata-20260910.patch`, SHA-256 `0d60fef8c898e6a37b9839e2ffa86e7b3bf6d44df88c4da4c7b174fa06943d8b`; dry-run application passed.

## Validation

| Gate | Result | Evidence boundary |
| --- | --- | --- |
| Backend Python syntax | PASS | `python3 -m py_compile app.py tests/test_app.py`, exit 0 |
| Focused backend pytest | BLOCKED | Available local interpreters do not contain the existing `fastmcp` or `pytest` runtime; no package was installed. New test code therefore was not executed locally. |
| Package parity | PASS | `cmp -s` passed for the two approved source/package pairs. |
| Connect build/start | PASS | Existing-content deployment completed successfully and Connect verification returned `[OK]`. |
| Prior WeCom focused tests | PRIOR PASS, NOT RERUN | Handoff records 37 targeted TypeScript tests and typecheck at 13:37Z, plus 48 Python tests earlier. This task did not change those WeCom sources. |
| Candidate build | PASS | Git tracked-file allowlist; existing `node_modules`; web input build then server build, exit 0. The first server-only attempt failed on the absent generated HTML and was not treated as a pass. |
| Candidate runtime package | PASS | JavaScript syntax, Python AST, plist lint, installed hashes, and all 8 declared runtime dependencies passed. |

## Existing Connect content

| Field | Before | After |
| --- | --- | --- |
| GUID / ID | `1ec85ef0-897f-4230-b824-1ed14103c34f` / `218` | unchanged |
| Bundle | `2810` | `2841` |
| Python | `3.11.6` | `3.11.6` |
| Access | `acl` | `acl` |
| Deploy time | `2026-09-07T06:10:07Z` | `2026-09-10T14:01:48Z` |

The pre-rollout direct health request returned 404 under ACL; the proxy-path attempt returned 502. Deployment startup verification passed, but post-deployment runtime health and MCP resource enumeration remain unverified because no intended query credential was available. The saved deployment/API key was not used as query authentication.

## Per-channel gates

| Channel | Configuration | Endpoint/runtime | Agent protocol | Native chat | Verdict |
| --- | --- | --- | --- | --- | --- |
| Shared Connect | Existing GUID/ID and ACL preserved | Bundle `2841` built, launched, and deployment-verified; authenticated runtime metadata not observed | MCP resource not enumerated remotely | Not applicable | `DEPLOYED_WITH_RUNTIME_AUTH_BLOCKER` |
| Lark | Risk MCP binding not added; inherited Codex config not mutated | ACL-protected runtime health not verified | Not verified | Not run; sending prohibited | `BLOCKED_AUTH; JOB UNCHANGED` |
| WeCom | Only `ai.wecom-channel-bridge.riskbot-codex` cut over | Fresh connected daemon health; runtime child ready and optimized | Daemon JSONL capability propagated into its own health | Not run; sending prohibited | `VERIFIED_RUNTIME` |

The configuration hash observed after deciding not to bind Lark was `61f1d03c67b13b061d6368c03365ac2d1dbc9dcb3bd13c1b87a88bc97c202eb3`. It is recorded only as the final non-secret fingerprint; no configuration contents were copied.

## WeCom release and live state

- Release: `/Users/guanglin/.lark-channel/releases/wecom-risk-runtime-20260910-09223264`.
- Source HEAD: `21af9cbfa1d2e4b8189a8c499b7d73d36fed8063`; dirty approved-source fingerprint: `b1cdd6b8e16760987bca6414aaa102d9893f6e79718b852e7cd31c8e4b81d4e1`.
- Bundle SHA-256: `09223264db039265da46b6d847bb19dd19cd06671ddc440d5a960d67869fc219`.
- Bridge SHA-256: `0c87e1bf23d9cf4504a6dc2650beb40db77445611a4d38fbbc1432fd636645bc`.
- Before: WeCom PID `70569`, runs `1`, connected and idle; Lark PID `36940`, runs `1`.
- After: WeCom PID `77479`, child PID `77480`, runs `1`, connected; `activeRuns=0`, `startingRuns=0`, durable `queued=0`, durable `running=0`.
- The daemon's health reports `runtime.ready=true`, `sharedTextMemoization=optimized`, and both fixed functions optimized with `maxEntries=4096`.
- Lark remains PID `36940`, runs `1`; it was not restarted.

## Guarded rollback

The actual loaded pre-cutover definition is preserved at `/Users/guanglin/.lark-channel/releases/wecom-risk-runtime-20260910-09223264/rollback-current.plist`, SHA-256 `dea3abc9415ddb5f86e65bedbd65dc2e9da685e0c1b8df69be57f17bea0e662a`.

Rollback, only if needed, is: recheck fresh health and durable idle counts; boot out only the named WeCom label; atomically restore that captured plist; bootstrap the same label; verify a new connected PID and ledger continuity. Do not restore any older state snapshot and do not touch Lark.

## Private evidence

Sanitized evidence and backend preimages are stored at `/Users/guanglin/.lark-channel/acceptance/risk-channel-runtime-20260910` with directories mode `0700` and files mode `0600`. It contains no credentials, raw configuration, chat content, or business data.

## Focused backend test-gap follow-up — 2026-09-10 22:16 +08:00

This follow-up occurred after Connect bundle `2841` was deployed and after the WeCom runtime gate was completed. It did not redeploy, restart, probe, or modify any service or configuration.

A single private isolated venv was created at `/private/tmp/risk-channel-backend-tests.PcXD2T/venv` with `--system-site-packages`, using the already-known `/Users/guanglin/miniforge3/bin/python3`. Selected versions/status were:

- Python `3.12.8`; pip `24.3.1`; inherited pandas `2.2.3`.
- `fastapi`, `fastmcp`, `pytest`, `pydantic`, `pins`, `pyarrow`, and `azpy` remained not installed.

Setup commands and results:

1. `/private/tmp/risk-channel-backend-tests.PcXD2T/venv/bin/pip install -r requirements.txt pytest` — exit `1`; the configured package source had no `azpy==1.9.0`.
2. `/private/tmp/risk-channel-backend-tests.PcXD2T/venv/bin/pip install --index-url <known-internal-index> -r requirements.txt pytest` — exit `1`; the endpoint is redacted from this repository report, and pip rejected its plain-HTTP transport unless an explicit trust bypass was supplied. No `--trusted-host`, proxy, VPN, permission, credential, or configuration bypass was used.

Both pip transactions stopped before installation; package inspection confirmed the framework/test dependencies remained absent. The authorized API/MCP framework tests were therefore **NOT RUN**: collected `0`, passed `0`, failed `0`, skipped `0`. No AST-only result or mocked financial response was substituted for them.

The intended focused pytest selection, not executed, was limited to:

- added health no-DB and legacy/broken metadata tests;
- added MCP runtime resource test;
- existing health identity test and MCP tool-contract test;
- existing source/package parity tests.

The application source was not changed in this follow-up. A reproducible test-only patch was added at `docs/patches/risk-service-runtime-metadata-tests-20260910.patch`, SHA-256 `c558b619bdea7a6872dd2c224af48eb64025ebd3258ab4a92ebd75c3848dfe48`.

Using retained persistent preimages in the private evidence directory and the new unique temp root, the application metadata patch applied to the preimage, matched the current app byte-for-byte, reversed, and matched the retained preimage byte-for-byte. The test patch passed the same apply/current/reverse/preimage byte-exact sequence. No deployed file was involved.
