# WeCom Risk CPU Acceptance — 2026-09-10

## Verdict: BLOCKED

The Codex subtask stopped at the mandatory VPN/reachability precondition. That subtask performed no real bridge query, local financial simulation, isolated CI snapshot, production mutation, live order, or WeCom/Lark message. Independent MCPX local validation was subsequently completed as recorded in the addendum below; the live matrix remains BLOCKED.

## Gate evidence

| Check | Exit | Result |
| --- | ---: | --- |
| `endpoint-vpn --json doctor` | 0 | `ok=true`, but `ready=false`; inspection of both required route exclusions returned `Operation not permitted`. This is an actual permission barrier. |
| HTTP reachability probe for `10.8.11.57:80` | 7 | The configured local proxy endpoint refused the connection before the target was reached, so intranet reachability was not established. No proxy or route bypass was attempted. |
| Baseline Git HEAD | 0 | `ddb99f650394e470c56bc214d77ec6b1af6adf9c`, matching the task baseline. |
| r3 bridge SHA-256 | 0 | `6ef23820198c3285e707fd5411ad5e11c1e41d37b18c9d08bf378a8c093f7d16`, matching the task. |
| candidate bridge SHA-256 | 0 | `cce6da1375c782050c3fe830ab3ac900e7ad4f713b0d06a1507f7ec282f5c389`, matching the task. |

The task explicitly prohibits bypassing a permission denial or changing sandbox, route, VPN, proxy, or allowlist rules. Therefore sampling did not proceed.

## Functional matrix and semantic comparison

All required cases are `BLOCKED / not run`: `get_holdings`, `search_securities`, `get_credit`, single-bond buy, changed-amount single buy, and two-leg buy, for both r3 and candidate. No business payloads were produced, no run IDs exist, and no semantic hashes or timing claims can be made. In particular, no native WeCom end-to-end behavior was tested.

## Local validation

The isolated `ci:local` equivalent and Python unittest suite were not run. Section C is ordered after live sampling, and the task requires stopping on the permission barrier. No isolated source snapshot or build artifact was created.

## Safety and process state

- Existing source/test/docs changes were preserved. Only this report and its sanitized JSON companion were added.
- No Git stage, commit, push, build in the live workspace, dependency install, deployment, restart, credential read, state/cache mutation, live order, or outbound WeCom/Lark message occurred.
- No acceptance bridge or owned test process was started, so none remains alive.
- WeCom remained PID `64122`, launchd `runs=1`; its persistent risk bridge remained PID `64125` on r3.
- Lark remained PID `36940`, launchd `runs=1`.
- Private raw evidence directory: not created; the gate stopped before business or test output collection.
- Isolated build snapshot: not created; local validation was not reached.

## Release implication

Do not cut over the CPU candidate. The required live functional matrix has not passed. The independent local CI gate subsequently passed, but cannot replace the live matrix.

## Independent local validation addendum

After the Codex subtask ended, MCPX created `/private/tmp/wecom-risk-cpu-validation-COvQbq` as an isolated Git worktree with the exact authorized working-tree changes. All 624 regular source files matched their captured SHA-256 values before validation and were rechecked against the original workspace afterwards. No shared production dist was rebuilt.

The equivalent `ci:local` completed with exit 0: 162 test files / 1199 tests passed, one controlled benchmark skipped; web build, TypeScript typecheck, server build, and diff check passed. The actual production Python unittest suite completed 40 tests with exit 0. Individual logs and the source manifest were retained.

An unloaded candidate package was prepared at `/Users/guanglin/.lark-channel/releases/wecom-risk-cpu-20260910-cce6da13`. All eight declared runtime dependencies resolved from its actual bundle path; JavaScript syntax, Python AST, and both plists passed checks. It retains the existing shared node_modules model, not an independently installed dependency tree. The currently installed r3 plist was frozen for rollback without changing the live definition.

The prior 93 simulation payloads, their summaries/drivers and local CI evidence were copied and hash-verified to `/Users/guanglin/.lark-channel/acceptance/risk-cpu-20260910-cce6da13` with private permissions. Raw financial payloads are not in Git. These are preserved historical samples, not new buy/query acceptance.

Host-level VPN was confirmed Connected. The live-test blocker is the Codex sandbox's route permission and proxy reachability, not proof of a disconnected VPN or application regression. No restriction was bypassed, and no production cutover was performed. See `WECOM_RISK_CPU_RELEASE_PREP_20260910.md` for the release boundary and remaining task.
