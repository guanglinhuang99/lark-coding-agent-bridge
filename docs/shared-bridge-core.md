# Shared bridge core

Baseline: `cc96c5b44d7418cd3e19d065be20b52aaa9bd6ba` (`v0.8.0`).
Implementation branch: `refactor/shared-bridge-core`, PR #11.

This document covers both the execution-core extraction and the subsequent shared conversation-state and inbound-durability implementation. It supersedes the first-phase statement that only session codecs had been moved.

## Architecture and ownership

Lark and WeCom retain separate entry points, SDKs, configuration, state directories, and independently running processes. They use the same core implementations, not a singleton service, a shared Codex thread, or a machine-wide concurrency budget.

```text
Lark SDK -> access/topic policy -> durable source receipts -> Lark debounce/batching
                                                              |
                                                              v
                                                     shared RunExecutor
                                                              |
WeCom SDK -> durable receipt -> conversation FIFO / risk routing|
                                            |                 |
                                   startWeComAgentRun ---------+
                                                              v
                                                         AgentAdapter
                                                        Codex / Claude

Lark session/catalog/workspace APIs -> conversationViews ----+
                                                            +-> ConversationState v2
WeComConversationBindings ----------> conversationViews ----+     (per deployment)

TaskLedger / OperationRunner / ProcessPool / ActiveRuns are shared implementations.
Platform messages, cards, media handling, authorization decisions and commands stay outside the core.
```

`src/bridge` contains:

| Module | Responsibility |
| --- | --- |
| `run-executor` | Prepare/spawn, event fanout, execution lifecycle, exit cleanup, optional task ledger |
| `process-pool`, `active-runs` | FIFO admission, permits, capacity, active scopes and interruption |
| `conversation-queue` | Ordered work within a conversation; currently used by WeCom |
| `identity` | Structured channel/account/instance/conversation/session keys and canonical workspace identity |
| `conversation-state` | One writer for namespaced session, preference and workspace state; validation and migration |
| `conversation-views` | Compatibility API views backed by that same writer, including Lark reconnect caching |
| `inbound-coordinator` | Durable Lark source-message receipts, stable batch operation IDs and cancellation bookkeeping |
| `task-ledger` | Atomic metadata persistence, serialized mutations, rollback on failed writes, safe recovery policy |
| `reliability` | Explicit retry policy, deadlines, cooperative abort, circuits and lingering-operation fences |
| `state-lock` | Single-writer ownership of a state directory; currently used by the WeCom deployment |
| `session-store`, `session-catalog`, `thread-session-store`, `workspace-store` | Legacy APIs/codecs retained for compatibility, imports and existing consumers |

Lark's production `startChannel` uses shared views when supplied the session/workspace paths by the normal foreground or supervisor entry point. Its command, run-flow and topic/comment consumers receive those views. Injected callers that omit the new optional paths retain the existing store contract.

WeCom's production CLI uses `WeComConversationBindings`, backed by `ConversationState` and the same views. Both its ordinary agent work and risk-intent agent parsing still go through the shared `RunExecutor`; there is no separate direct `codex.run()` startup path in the WeCom CLI.

## Execution admission and cleanup

WeCom admits an entire operation before attachment processing, deterministic risk work or agent startup. A nested agent borrows the operation's live permit, rather than acquiring a second slot. A concurrency limit of one therefore does not deadlock. Permits validate ownership and liveness, allow one borrower at a time, and defer outer release while borrowed. Capacity is reserved before waking a FIFO waiter; releases are idempotent.

The executor rechecks policy expiry and reconnect state after admission and preparation. Failed acquisition, preparation and spawn release their reservations. Cleanup rejection wakes event subscribers rather than leaving them suspended. After a terminal event the executor waits for process exit, then stops an agent that exceeds the grace period.

The Lark debounce/batching policy is not replaced by WeCom's per-message serialization. Card rendering remains channel-specific. The WeCom active-card map is presentation state, not another execution engine.

## Session and workspace binding

The shared session identity includes:

```text
channel + account + deployment instance + conversation scope
        + agent kind + canonical workspace + permission-policy fingerprint
```

Keys use structured JSON encoding, not delimiter concatenation. Two accounts, two platform channels, two deployment instances, two working directories or two permission policies do not automatically share a session. Workspace paths are resolved before using a binding for agent execution. A retargeted symlink cannot implicitly reuse a thread verified against the old canonical directory.

Lark keeps its existing policy evaluation/fingerprint, named workspace behavior and per-conversation idle-timeout override. A legacy session with only a session ID and cwd is not sufficient evidence of matching permissions; its automatic fallback is disabled in the new shared view. Valid legacy catalog entries that include the workspace and policy fingerprint are imported into the selected deployment's namespace.

WeCom captures the binding at run start and writes a returned thread ID against that captured binding. A late completion cannot attach the old project's thread to a newly selected project's binding. Generated-artifact handling also receives the captured execution workspace. The configured `WECOM_WORKSPACE` remains the default. The underlying binding API supports per-conversation workspaces, but this PR does **not** add a new hot-switch card/menu.

Account/profile namespace is fixed for each view. A Lark reconnect can create a new view over the same writer without re-importing old files into a newly selected account.

A fingerprint describes bridge-selected runtime options; it is not an independent detector of every external permission, local rule-file or agent configuration change. No credential material is stored in it.

## State files and migration

| State | Location / behavior |
| --- | --- |
| Shared Lark conversations | `${appPaths.sessionsFile}.bridge-v2.json` |
| Shared WeCom conversations | `${sessionFile}.bridge-v2.json`, normally within `WECOM_STATE_DIR` |
| Lark task/source receipts | `${appPaths.sessionsFile}.tasks.json` |
| WeCom task/source receipts | Existing `WECOM_STATE_DIR/tasks.json`; v0.8 operation-hash compatibility retained |
| Migration backups | `${legacyFile}.pre-shared-${sha256Prefix}.json` |

Conversation state uses schema version 2, partitioned into deployment contexts. Each context contains preferences, per-conversation workspaces, named workspaces, verified session entries and quarantined unverified legacy threads. Task-ledger schema version 1 remains separate.

On first open, the new writer validates **all** available legacy inputs before creating backups or committing the v2 file. The backups are content-addressed and written atomically with mode `0600`; a conflicting pre-existing backup aborts migration. Only after backups succeed is the v2 file atomically committed. A failure after a backup but before the final write is safe to retry.

The original files are not modified by migration. A valid existing v2 file is authoritative and suppresses repeated import. A damaged v2 file is not silently replaced by old data. Invalid legacy or v2 input fails with the original preserved.

The import owner is the account/profile configured for the deployment at first migration. Operators must verify that the state directory belongs to that account before upgrading; legacy files cannot independently prove historical account ownership. Do not move another account's legacy state into this directory.

### Visible compatibility change

Old WeCom thread mappings do not contain a workspace or permission fingerprint. They are preserved as unverified records, but **are not automatically resumed**. After upgrade, such a conversation starts fresh unless the user explicitly selects a suitable thread through the existing resume flow. That selection must still satisfy the platform's existing checks. New verified bindings can resume normally on subsequent messages/restarts.

Lark idle-timeout preferences and named/per-conversation workspace settings are retained. Clearing a session does not erase its idle-timeout override.

### Writer ownership

WeCom acquires a canonical state-directory lock before loading or migrating state. A second new-version process aimed at the same state directory fails instead of concurrently overwriting it. Lark uses the existing profile/runtime locks, with task recovery moved inside their ownership boundary. Reconnects reuse the writer rather than opening competing writers.

This does **not** make it safe to run an older bot alongside the new one. Stop the old process before migration. Nor does the state-directory lock serialize two independently configured bridges editing the same Git working tree; cross-process workspace locking is outside this PR.

## Durable source receipts and batch execution

Lark now distinguishes a source-message receipt from the execution record for a debounced batch. Source deduplication uses the platform/account/instance and stable parent-chat/message identity; it does not depend on a best-effort topic lookup. Batch IDs are hashes of the unique, sorted source identities within that deployment.

The production flow is:

1. Apply the existing access/mention/intake checks.
2. Durably accept the source and suppress a duplicate before dispatching a command.
3. Mark it running before command dispatch. If dispatch reports that it was not a command, return it to queued status before placing it in the existing debounce queue.
4. Atomically mark **all** source receipts running before batch work begins; pass the stable batch operation ID to `RunExecutor`.
5. Record execution outcome separately from delivery. Record canceled pending sources as interrupted, including queue cancellation invoked by card controls.

The ledger serializes mutations and rolls back tentative changes on failed persistence. A concurrent claimant cannot mistake an uncommitted first claim for a durable acceptance. Batch transition failure leaves every source unstarted. Terminal execution states cannot be downgraded by a later delivery error.

An unwritable claim/start record blocks execution rather than silently falling back to an unprotected agent launch. WeCom retains a narrow text-only degraded path for `/doctor`, `/status`, `/menu` and `/help`; attachments and normal work do not bypass the ledger on a write failure. WeCom slash commands are marked started before they can clear sessions or stop work.

Task state is metadata, not a durable copy of the message payload. After a crash, eligible queued tasks can be accepted on platform redelivery; there is no autonomous payload replay or promise that the platform will redeliver. Already-running agent work is not silently replayed. The WeCom deterministic-risk exception remains an explicit channel policy, not a generic assumption that any task labeled risk is safe.

Source deduplication is bounded by the configured receipt retention. It covers Lark IM intake and the existing WeCom intake, not every cloud-document comment, meeting event or callback in the ecosystem. Neither a receipt nor a local atomic file guarantees exactly-once remote effects such as mail sending, OA approval or publishing.

## Deadline and delivery semantics

`OperationRunner` accepts a cooperative `AbortSignal`. Only explicitly idempotent operations retry settled transient failures. A timeout generated by the runner itself is never automatically retried, because cancellation may not have completed.

If the timed-out promise is still alive, the runner fences new invocations with the same operation key until it settles. A late success only releases that fence; it cannot clear a circuit opened by the timeout. An operation that ignores abort and never settles can remain fenced until the underlying work is resolved or the process is restarted. The fence is per runner instance, not distributed.

Once an agent has completed, a failed response/attachment delivery does not make its writes safe to repeat. WeCom reports execution complete / delivery incomplete without reclassifying the completed run as an execution failure. Session persistence failures after completion are recorded diagnostically rather than inviting a replay of the agent.

## Privacy and compatibility limits

The task ledger does not persist original message IDs, prompt text, attachment contents, model outputs or credentials. It does retain operational metadata and conversation/deployment identifiers needed for isolation and status. Session state stores session/thread identifiers, workspace bindings and existing catalog metadata, so it is private local state, not a public report.

Unchanged boundaries include the independent CLI commands and entry points, platform SDKs, card protocols, media encryption, deterministic risk routing, model/reasoning controls, login configuration and authorization decisions. No additional service, database, framework, published package or release tag is introduced.

Not included: a channel-neutral supervisor, shared live processes or machine-wide capacity, cross-process working-tree locking, a new WeCom multi-workspace UI, universal inbound dedup for every platform event, automatic recovery of external side effects, or cross-channel sharing of conversation history.

## Validation and handoff

Run the checked-in commands without reducing the existing test matrix:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

New suites cover the shared executor/permits; namespaced session identity; old Lark/WeCom migration and backups; damaged-file protection; write-failure rollback; immutable captured workspace; state-directory locking; concurrent source deduplication; atomic batch starts; cancellation/restart receipt rules; timeout fencing; and the actual Lark production channel with durable state and a fake SDK/agent.

These automated checks are not authenticated end-to-end validation. The Mac mini acceptance procedure, safety boundaries and required report are in `docs/codex-shared-core-validation.md`.

For rollback, stop the new process first and preserve its v2 state, task ledger and original/backed-up legacy files. Returning to v0.8.0 uses the old session/workspace files, which are now snapshots and may be stale. Do not delete task receipts or rerun uncertain interrupted work merely to make a rollback look clean. Investigate any potentially completed external action before retrying it.
