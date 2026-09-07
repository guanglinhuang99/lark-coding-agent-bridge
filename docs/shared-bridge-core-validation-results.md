# PR #11 Shared Bridge Core Validation Results

Validation dates: 2026-09-05 and 2026-09-07 (Asia/Shanghai)

## Scope and tested revision

- Repository: `https://github.com/guanglinhuang99/lark-coding-agent-bridge.git`
- Pull request: `#11` (`refactor/shared-bridge-core` -> `main`)
- Reference and initial PR HEAD: `00a6a340a8ccd7486457f109ead672f99198cb9f`
- Initial acceptance-fix commit: `553874c` (`fix(wecom): retry after durable claim failure`)
- Actual code HEAD tested after real-client fix: `8a920e96b012e4d76738f6adc5c83b5d0f159e9b` (`fix(wecom): cap card facts for client limits`)
- Validation worktree: `isolated temp root`
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

At the user's explicit direction, the existing approved WeCom and Lark bot profiles were used during a maintenance window. The PR instance used an isolated temporary state/workspace root, with synthetic messages and synthetic text fixtures only; no second connection was run concurrently with the online service. No credentials, login material, message body, attachment, or raw state file is recorded here.

The isolated Lark PR instance authenticated successfully only after generic proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, including lowercase variants when present) were removed from its startup environment. The SDK's `respectProxyEnv` path did not honor `NO_PROXY`; this is an environment/startup prerequisite, not a product-code failure. Proxy endpoints and credentials are intentionally omitted.

| Status | Real-client check | Evidence and conclusion |
| --- | --- | --- |
| PASS | WeCom startup and authentication | The built PR process authenticated and connected using isolated temporary state/workspace paths and read-only Codex sandboxing. |
| PASS | WeCom ordinary conversation and continuation | A deterministic prompt and a second turn returned the expected synthetic marker from the same authenticated conversation. |
| PASS | WeCom `/new`, `/resume`, and `/stop` | Real reset, resume selection/callback, and safe in-run stop checks passed; stopped work did not emit its late marker. |
| PASS | WeCom `/doctor`, attachments, and restart fencing | The diagnostic card, harmless attachment receive/send, and restart/no-replay checks passed. |
| PASS | WeCom `/runs` | The real client displayed run history, including persisted interrupted status after restart. |
| PASS | WeCom controlled/automatic WebSocket reconnect | Initial connection, controlled restart, and the previously exercised automatic reconnect completed without duplicate execution. |
| PASS | WeCom successful read-only risk calculation | The isolated hypothetical risk check completed its result table without invoking an order or production transaction API. |
| PASS | Lark startup and authentication | The isolated PR instance connected successfully with the existing `codex` profile after clearing the generic proxy environment. Credentials were not rotated, printed, or committed. |
| PASS | Lark ordinary conversation and continuation | A synthetic ordinary prompt and follow-up continuation both completed successfully. |
| PASS | Lark `/status` | The real client returned the expected status response. |
| PASS | Lark card “new session” callback | Computer Use activated the card's new-session control; the real callback was received and acknowledged. |
| PASS | Lark `/new` | The real client completed the new-session flow. |
| PASS | Lark `/resume` list and click restore | The persisted session list rendered and clicking a real restore control resumed the selected conversation. |
| PASS | Lark in-run `/stop` | A running synthetic task was stopped; the client showed interruption and no late target marker was delivered. |
| PASS | Lark `/doctor` | Self-check, workspace, policy, and agent-echo diagnostics all completed successfully. |
| PASS | Lark attachment receive/send | A 108-byte synthetic text attachment was read inbound and returned outbound as a real downloadable attachment. |
| PASS | Lark `/reconnect` | The controlled reconnect completed, and a subsequent message was processed successfully. |
| PASS | Lark process restart / no replay | Before and after restart, task-state counts were unchanged; intake remained 18 and queued/running remained 0. New messages after restart all returned PASS, with no silent replay of an already-started Agent task. |
| N/A | Lark `/runs` | `/runs` is not a Lark built-in control command. It was handled as an ordinary Agent message and is excluded from the Lark control-command results; the real WeCom `/runs` check above passed. |

The authenticated checks used an isolated temporary root and workspace. The launchd plist was not modified, credentials were not rotated, and no credential-bearing files or raw test state were recorded in this report.

## Findings and minimal fixes

1. `processMessageEvent` originally claimed the in-memory message dedupe entry before the durable task receipt. If the durable write failed, the task correctly did not execute, but an immediate platform redelivery with the same message ID was then discarded by the in-memory TTL cache. Commit `553874c` moves the memory claim after the durable claim/fail-closed block and adds a regression contract.
2. Authenticated `/doctor` initially failed at the WeCom API boundary with error `42035` because its template card contained seven `horizontal_content_list` entries while WeCom accepts at most six. Commit `8a920e9` caps facts at six in the central notice and interactive card renderer and adds a regression test. Rebuilding and repeating the same real-client `/doctor` check passed.

Both fixes are surgical and do not change the shared architecture or weaken tests, safety assertions, or timeouts. The final code tree passed all full and targeted gates listed above.

## Migration and rollback conclusion

- PASS (automated, temporary state): migration preserves legacy bytes, writes mode-`0600` content-addressed backups, does not repeat import once v2 exists, retries safely after backup-before-commit interruption, and refuses damaged input or conflicting backup content.
- PASS (design and tests): old WeCom cwd/policy-unverified mappings remain quarantined and are not blindly resumed.
- PASS (authenticated restart fencing): an already-started safe Agent task remained interrupted and was not silently replayed after the WeCom process restarted against the same temporary state.
- BLOCKED (non-merge blocker; production-state migration/rollback): no production state was copied or mutated, and an authenticated production-state migration/rollback drill was intentionally not performed. Automated temporary-state coverage is the acceptance evidence for migration semantics; the production drill remains an operational follow-up.
- Rollback procedure remains: stop the new dedicated test process first; preserve v2 state, task receipts, legacy files, and backups; then run v0.8.0 against the legacy snapshot. The legacy snapshot may be stale, and uncertain external effects must be checked before any retry.

## GitHub and merge recommendation

At the initial tested PR head, GitHub reported macOS and Ubuntu / Node 20 checks successful and Windows / Node 20 checks failed. Windows is explicitly outside this acceptance scope and was not hidden, skipped, or modified. The repository reported no required checks and no branch protection for `main` at validation time. CI must be re-read after the final report push because earlier results do not substitute for the new head.

Code-level, offline, WeCom real-client, and Lark real-client checks are **PASS** after `8a920e9`; no additional code blocker was found. The Lark `/runs` item is **N/A** because it is not a Lark built-in command, while the real WeCom `/runs` check is **PASS**. Windows remains explicitly out of scope and was not hidden, skipped, or modified. Production-state migration/rollback remains **BLOCKED** as a non-merge operational follow-up because production state was intentionally not touched. Overall acceptance is **READY** to merge, subject to re-reading the in-scope CI result for the final report head after it is pushed.

Operational note outside the PR code diff: the pre-existing `ai.lark-channel-bridge.bot.codex` LaunchAgent also contains an extra script argument after the installed `lark-channel-bridge` entrypoint, causing an `unknown command` restart loop. It was not edited as part of this surgical PR acceptance. The isolated authenticated validation invoked the PR entrypoint with the required proxy-cleared environment instead of changing that plist.
