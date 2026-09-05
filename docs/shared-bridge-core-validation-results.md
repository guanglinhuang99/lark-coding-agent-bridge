# PR #11 Shared Bridge Core Validation Results

Validation date: 2026-09-05 (Asia/Shanghai)

## Scope and tested revision

- Repository: `https://github.com/guanglinhuang99/lark-coding-agent-bridge.git`
- Pull request: `#11` (`refactor/shared-bridge-core` -> `main`)
- Reference and initial PR HEAD: `00a6a340a8ccd7486457f109ead672f99198cb9f`
- Code validation HEAD after the acceptance fix: `553874c` (`fix(wecom): retry after durable claim failure`)
- Validation worktree: `/tmp/lark-pr11-validation.dQoLKv`
- Reference workspace preserved unchanged: `/Users/guanglin/Sync/wecom-bot`
- Reference workspace state at start: branch `fix/wecom-rc-blockers`, HEAD `c461426a868e2847f84ec8ddd9aece1d4918e470`, with untracked `.pnpm-store/` and `AGENTS.md`

The PR head was fetched immediately before validation and still matched the reference commit. The isolated worktree was used so the reference workspace's uncommitted files were not reset, cleaned, staged, or overwritten.

## Environment

- macOS 26.6.2 (Build 25G83), Apple Silicon host
- Node.js `v23.11.0`
- Project package manager: Corepack pnpm `10.33.0`
- The shell's unrelated fallback pnpm `11.19.0` was not used for the formal validation commands.

## Automated checks

All formal results below are from the fixed code tree represented by commit `553874c`.

| Status | Command | Result |
| --- | --- | --- |
| PASS | `corepack pnpm@10.33.0 install --frozen-lockfile` | Exit 0; lockfile unchanged; 248 packages installed using pnpm 10.33.0 |
| PASS | `corepack pnpm@10.33.0 test` | Exit 0; 140/140 files and 989/989 tests passed |
| PASS | `corepack pnpm@10.33.0 typecheck` | Exit 0 |
| PASS | `corepack pnpm@10.33.0 build` | Exit 0 |
| PASS | `git diff --check` | Exit 0 |
| PASS | `corepack pnpm@10.33.0 exec vitest run tests/unit/bridge tests/integration/bot/shared-durable-channel.test.ts` | Exit 0; 5/5 files and 51/51 tests passed |
| PASS | `corepack pnpm@10.33.0 exec vitest run tests/unit/wecom tests/integration/executor tests/integration/session tests/integration/runtime tests/static` | Exit 0; 36/36 files and 277/277 tests passed |

The full test suite initially failed inside the restricted sandbox because 12 UI-server tests could not bind `127.0.0.1` (`EPERM`). Re-running the same command with approved local-listener access passed in full. This was an execution-environment restriction, not a product failure.

## Acceptance matrix

| Status | Acceptance item | Evidence and conclusion |
| --- | --- | --- |
| PASS | Shared implementations | Lark and WeCom both use the shared `RunExecutor`; shared conversation views are backed by `ConversationState`; WeCom uses `WeComConversationBindings`. Platform SDKs, processes, state roots, and policy decisions remain separate as designed. |
| PASS | Session isolation | Automated coverage separates platform, account, deployment instance, conversation scope, agent, canonical workspace, and policy fingerprint, including delimiter-like and `__proto__` inputs. Mutable symlink retargeting does not reuse a thread verified for the old canonical directory. |
| PASS | Migration and corruption protection | Temporary-file tests cover Lark catalog/workspace/idle preference import, WeCom unverified-thread quarantine, content-addressed backups, retry after backup-before-commit interruption, authoritative v2 state, damaged legacy/v2 rejection, and unchanged legacy input bytes. |
| PASS | Lark preferences | Named and conversation workspaces and idle-timeout overrides survive migration; clearing a session retains the idle-timeout override. Legacy sid/cwd-only records cannot bypass the catalog's workspace and policy evidence. |
| PASS | WeCom late result binding | The run captures its canonical session binding and generated-artifact workspace before execution; a late thread ID cannot attach to a workspace selected after the run began. |
| PASS | Deduplication and batching | Lark production-entry fake-channel coverage verifies concurrent/redelivered source deduplication, unchanged debounce merging, stable batch IDs, atomic batch start, cancellation, and restart behavior. Core ledger tests verify concurrent claim rollback and all-or-nothing source transitions. |
| PASS | Persistence failure safety | A failed durable claim or batch transition prevents protected work from starting. The acceptance fix ensures a failed WeCom durable claim does not poison the in-memory dedupe cache, so platform redelivery can retry after storage recovers. |
| PASS | Cancellation, reconnect, restart | Queued cancellation does not revive on reconnect/restart; already-running Agent work is marked interrupted and is not silently replayed. The explicit WeCom deterministic read-only risk exception remains separate from generic Agent work. |
| PASS | Delivery failure separation | WeCom preserves a completed execution result when reply, attachment, or post-run persistence delivery fails and warns against repeating a potentially side-effectful write. Delivery failure does not reclassify the Agent execution as retryable. |
| PASS | Concurrency and cleanup | Capacity-one nested Agent runs borrow the operation permit without double admission or deadlock. FIFO, reservation rollback, idempotent release/stop, spawn/prepare failure, terminal cleanup, reconnect pause, and state-directory lock release are covered. |
| PASS | Timeout fencing | `OperationRunner` sends a cooperative abort, does not retry a local timeout, fences the same operation key while underlying work remains alive, and does not let late success close a timeout-opened circuit. |
| PASS | State privacy | The task ledger stores hashes and bounded operational metadata, not raw message IDs, prompts, attachments, model output, or credentials. No production state or logs were copied into this report. |

The legacy WeCom thread map has no cwd/policy proof. Keeping it as unverified history without automatic resume is the expected behavior and was not changed.

## Additional offline and process-level validation

All commands used temporary `LARK_CHANNEL_HOME`, `WECOM_STATE_DIR`, configuration, and workspace paths.

| Status | Check | Result |
| --- | --- | --- |
| PASS | Process/CLI suites | 6 files, 46 tests passed using fake/local dependencies |
| PASS | `/doctor` command suites | 3 files, 8 tests passed using fake channel/agent dependencies |
| PASS | Lark CLI smoke | `--version`, `--help`, `run --help`, `migrate --help`, `ps`, and `profile list` behaved correctly in empty temporary state |
| PASS | WeCom fail-closed smoke | `--health` returned the expected missing-health result in empty temporary state; startup without credentials failed before connecting |

These are offline, simulated, or process-level results. They are not authenticated Feishu or WeCom client results.

## Real-client isolation and blocked checks

An existing WeCom bridge process was detected in the reference workspace and had an active external TLS connection. It was not stopped, restarted, inspected for content, or replaced. No clearly dedicated test bot or test credentials were available in the temporary worktree or process environment, so starting a second real connection would have risked affecting the online bot.

The following authenticated checks are therefore **BLOCKED**, not passed:

- WeCom and Lark ordinary conversation and second-turn continuation
- `/new`, `/resume`, stop, model/reasoning, `/runs`, and `/doctor`
- Template/card callbacks and text fallback
- Attachment receive/send with a harmless test file
- Read-only `/测算` against a dedicated test risk service
- WebSocket reconnect and controlled process restart without replay

Blocker: no independently identified test robot credentials and no isolated authenticated risk dependency. Fake SDK/agent coverage was not counted as real-client acceptance.

## Finding and minimal fix

The review found one WeCom retry defect. `processMessageEvent` originally claimed the in-memory message dedupe entry before the durable task receipt. If the durable write failed, the task correctly did not execute, but an immediate platform redelivery with the same message ID was then discarded by the in-memory TTL cache and could not retry after storage recovered.

Commit `553874c` moves the memory claim after the durable claim/fail-closed block and adds a regression contract. No architecture or unrelated code was changed. The fixed tree passed the full and targeted gates listed above.

## Migration and rollback conclusion

- PASS (automated, temporary state): migration preserves legacy bytes, writes mode-`0600` content-addressed backups, does not repeat import once v2 exists, retries safely after backup-before-commit interruption, and refuses damaged input or conflicting backup content.
- PASS (design and tests): old WeCom cwd/policy-unverified mappings remain quarantined and are not blindly resumed.
- BLOCKED (authenticated instance): no dedicated bot was available for a stop/migrate/run/rollback exercise.
- Rollback procedure remains: stop the new dedicated test process first; preserve v2 state, task receipts, legacy files, and backups; then run v0.8.0 against the legacy snapshot. The legacy snapshot may be stale, and uncertain external effects must be checked before any retry.

## GitHub and merge recommendation

At the initial tested PR head, GitHub reported macOS and Ubuntu / Node 20 checks successful and Windows / Node 20 checks failed. Windows is explicitly outside this acceptance scope and was not hidden, skipped, or modified. The repository reported no required checks and no branch protection for `main` at validation time.

Code-level and offline acceptance is **PASS** after `553874c`; no remaining code blocker was found. Overall acceptance is **NOT READY / do not merge yet** because the requested authenticated client checks remain BLOCKED. Re-evaluate after a dedicated Lark/WeCom test robot and isolated risk dependency complete the real-client checklist, and after the final pushed PR head's macOS/Ubuntu CI is green.
