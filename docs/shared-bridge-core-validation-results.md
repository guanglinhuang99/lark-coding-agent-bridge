# PR #11 Shared Bridge Core Validation Results

Validation dates: 2026-09-05 and 2026-09-07 (Asia/Shanghai)

## Scope and tested revision

- Repository: `https://github.com/guanglinhuang99/lark-coding-agent-bridge.git`
- Pull request: `#11` (`refactor/shared-bridge-core` -> `main`)
- Reference and initial PR HEAD: `00a6a340a8ccd7486457f109ead672f99198cb9f`
- Initial acceptance-fix commit: `553874c` (`fix(wecom): retry after durable claim failure`)
- Actual code HEAD tested after real-client fix: `8a920e96b012e4d76738f6adc5c83b5d0f159e9b` (`fix(wecom): cap card facts for client limits`)
- Validation worktree: `/tmp/lark-pr11-validation.dQoLKv`
- Reference workspace preserved unchanged: `/Users/guanglin/Sync/wecom-bot`
- Reference workspace state at start: branch `fix/wecom-rc-blockers`, HEAD `c461426a868e2847f84ec8ddd9aece1d4918e470`, with untracked `.pnpm-store/` and `AGENTS.md`

The PR head was fetched before validation and initially matched the reference commit. Testing then followed the latest branch commits shown above. The isolated worktree was used so the reference workspace's uncommitted files were not reset, cleaned, staged, or overwritten.

## Environment

- macOS 26.6.2 (Build 25G83), Apple Silicon host
- Node.js `v23.11.0`
- Project package manager: Corepack pnpm `10.33.0`
- WeCom desktop client `5.0.10`
- Lark desktop client `131.0.6778.268`
- Codex CLI `0.153.2` during authenticated `/doctor` validation
- The shell's unrelated fallback pnpm `11.19.0` was not used for the formal validation commands.

## Automated checks

All formal results below are from the fixed code tree represented by commit `8a920e9`.

| Status | Command | Result |
| --- | --- | --- |
| PASS | `corepack pnpm@10.33.0 install --frozen-lockfile` | Exit 0; lockfile unchanged; 248 packages installed using pnpm 10.33.0 |
| PASS | `corepack pnpm@10.33.0 test` | Exit 0; 140/140 files and 990/990 tests passed |
| PASS | `corepack pnpm@10.33.0 typecheck` | Exit 0 |
| PASS | `corepack pnpm@10.33.0 build` | Exit 0 |
| PASS | `git diff --check` | Exit 0 |
| PASS | `corepack pnpm@10.33.0 exec vitest run tests/unit/bridge tests/integration/bot/shared-durable-channel.test.ts` | Exit 0; 5/5 files and 51/51 tests passed |
| PASS | `corepack pnpm@10.33.0 exec vitest run tests/unit/wecom tests/integration/executor tests/integration/session tests/integration/runtime tests/static` | Exit 0; 36/36 files and 278/278 tests passed |

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

## Authenticated real-client validation

At the user's explicit direction, the existing WeCom test target was used. The original process was stopped only after confirming zero active/starting runs. The PR process used the same robot credentials but separate temporary state and workspace directories, and no second connection was run concurrently. Test messages were synthetic and the only transferred file was a harmless 102-byte text fixture. No credentials, login material, real attachment, session body, or raw state file is recorded here.

| Status | Real-client check | Evidence and conclusion |
| --- | --- | --- |
| PASS | Startup and authentication | The built PR process authenticated and connected using temporary state/workspace paths and read-only Codex sandboxing. The risk fast path used an explicit service directory. |
| PASS | Ordinary conversation | A deterministic prompt returned the requested synthetic marker. |
| PASS | Second-turn continuation | The next turn recalled the marker from the same authenticated conversation. |
| PASS | `/new` | The client displayed the reset/new-session confirmation card. |
| PASS | `/resume` rendering | The client displayed the resume selection card from persisted session history. |
| PASS | Resume/card callback execution | Computer Use clicked the real `/resume` card's Apply control. The client changed the original card to a completed state and rendered a fresh control card; the callback was also received and acknowledged over the authenticated WebSocket. |
| PASS | `/stop` | A safe delayed task was started and then stopped. The client showed interruption, health returned to zero active runs, and the late target marker was not delivered. |
| PASS | `/runs` | The authenticated client rendered run history, including persisted interrupted status after restart. |
| PASS | `/doctor` after fix | The real client rendered a completed diagnostic card covering WeCom, Codex, workspace, risk service, task store, and retry/circuit status. |
| PASS | Attachment receive | The bot acknowledged and correctly summarized the harmless 102-byte text fixture. |
| PASS | Attachment send | The bot returned that existing fixture as a real downloadable file row in the client. |
| PASS | Process restart / no replay | The process was terminated while a safe delayed Agent task was active, then restarted against the same temporary state. After waiting beyond the original delay, active/starting counts remained zero, the run stayed interrupted, and the forbidden late marker was not emitted. |
| PASS | WebSocket connect and controlled restart | Initial authenticated WebSocket connection and controlled process restart were exercised without duplicate execution. |
| PASS | Forced automatic WebSocket reconnect | The isolated process was suspended long enough for the server to close the socket with code `1006`, then resumed. The same process logged disconnect, reconnect attempt 1, a new socket, and successful authentication about one second later. The task ledger remained at 20 records with 16 done, 2 failed, and 2 interrupted; active/starting counts remained zero and no Agent task was replayed. |
| PASS | Successful read-only risk calculation | Computer Use submitted a hypothetical secondary-market purchase of CNY 1 for a uniquely resolved security against an existing reference product, confirmed the real card callback, and received the completed result table. The risk service completed all four phases in 48.551 seconds. State was isolated, the market-calendar input was copied read-only into temporary state, and no order or production transaction API was called. The exhausted default Spark allowance was bypassed only in the isolated process with `WECOM_RISK_INTENT_MODEL=gpt-6-astra`; no usage-reset credit was consumed and no repository/default configuration changed. |
| BLOCKED | Lark real client | The installed and logged-in Lark client was exercised with a synthetic marker, but the PR bridge could not authenticate and the message received no bot response. A direct request to Feishu's official tenant-token endpoint returned `code 10014` (`app secret invalid`) for the configured `codex` profile. Network reachability was separately verified, so this is an invalid external credential, not a fake-SDK pass or a PR-code result. |

The temporary PR instance was stopped after confirming zero active and starting runs. The original reference-workspace WeCom service was restored as a single background instance and reported connected with zero active/starting runs. The pre-existing Lark LaunchAgent was reloaded without modifying its plist, and the credential-bearing temporary Lark directory plus the WeCom test state/workspace were deleted after evidence was recorded.

## Findings and minimal fixes

1. `processMessageEvent` originally claimed the in-memory message dedupe entry before the durable task receipt. If the durable write failed, the task correctly did not execute, but an immediate platform redelivery with the same message ID was then discarded by the in-memory TTL cache. Commit `553874c` moves the memory claim after the durable claim/fail-closed block and adds a regression contract.
2. Authenticated `/doctor` initially failed at the WeCom API boundary with error `42035` because its template card contained seven `horizontal_content_list` entries while WeCom accepts at most six. Commit `8a920e9` caps facts at six in the central notice and interactive card renderer and adds a regression test. Rebuilding and repeating the same real-client `/doctor` check passed.

Both fixes are surgical and do not change the shared architecture or weaken tests, safety assertions, or timeouts. The final code tree passed all full and targeted gates listed above.

## Migration and rollback conclusion

- PASS (automated, temporary state): migration preserves legacy bytes, writes mode-`0600` content-addressed backups, does not repeat import once v2 exists, retries safely after backup-before-commit interruption, and refuses damaged input or conflicting backup content.
- PASS (design and tests): old WeCom cwd/policy-unverified mappings remain quarantined and are not blindly resumed.
- PASS (authenticated restart fencing): an already-started safe Agent task remained interrupted and was not silently replayed after the WeCom process restarted against the same temporary state.
- BLOCKED (production-state migration/rollback): no production state was copied or mutated, and the configured Lark credential was invalid, so an authenticated Lark migration/rollback drill could not be performed. Automated temporary-state coverage is the acceptance evidence for migration semantics.
- Rollback procedure remains: stop the new dedicated test process first; preserve v2 state, task receipts, legacy files, and backups; then run v0.8.0 against the legacy snapshot. The legacy snapshot may be stale, and uncertain external effects must be checked before any retry.

## GitHub and merge recommendation

At the initial tested PR head, GitHub reported macOS and Ubuntu / Node 20 checks successful and Windows / Node 20 checks failed. Windows is explicitly outside this acceptance scope and was not hidden, skipped, or modified. The repository reported no required checks and no branch protection for `main` at validation time. CI must be re-read after the final report push because earlier results do not substitute for the new head.

Code-level, offline, and the completed WeCom real-client checks are **PASS** after `8a920e9`; no additional code blocker was found. Real card callback execution, automatic WebSocket reconnect, and a successful read-only risk calculation are now also **PASS**. Overall acceptance remains **NOT READY / do not merge yet** only because the configured Lark `codex` App Secret is invalid, which prevents authenticated Lark client validation. Replace that external credential, repeat the Lark client matrix, and confirm the final PR head's in-scope CI before merge.

Operational note outside the PR code diff: the pre-existing `ai.lark-channel-bridge.bot.codex` LaunchAgent also contains an extra script argument after the installed `lark-channel-bridge` entrypoint, causing an `unknown command` restart loop. It was not edited as part of this surgical PR acceptance. Even with corrected launch arguments, the invalid App Secret must be replaced before the bot can connect.
