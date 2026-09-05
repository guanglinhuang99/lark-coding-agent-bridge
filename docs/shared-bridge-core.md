# Shared bridge core — first convergence phase

Baseline: `cc96c5b44d7418cd3e19d065be20b52aaa9bd6ba` (`v0.8.0`).

## Architecture

Lark and WeCom remain separate entry points and independently configured processes.
They share an execution-engine implementation, not a singleton instance or a machine-wide concurrency budget.

```text
Lark SDK -> Lark batching / policy -> shared RunExecutor -> AgentAdapter
WeCom SDK -> conversation FIFO / risk routing
                                  -> shared RunExecutor -> CodexAdapter

src/bridge/
  process-pool         FIFO, capacity, queue deadlines, validated admission permits
  active-runs          scope reservation, active processes, interruption
  run-executor         prepare, spawn, event fanout, exit cleanup, optional ledger
  conversation-queue   ordered conversation work (currently consumed by WeCom)
  task-ledger          metadata persistence and configurable safe replay
  reliability          timeout, retry, failure classification and circuits
  session-store        legacy Lark session codec
  session-catalog      agent/workspace/policy-aware Lark session catalog
  thread-session-store legacy WeCom thread-binding codec
  workspace-store      named workspace and conversation bindings
```

Both WeCom agent paths (ordinary requests and risk-intent parsing) use `startWeComAgentRun`, a thin facade over the same RunExecutor used by Lark. No direct `codex.run()` call remains in the WeCom CLI. Its active-card map remains presentation state, not another agent startup implementation.

## Admission and cleanup

WeCom admits an entire operation before attachment reads, deterministic risk work, or agent startup. An agent inside it borrows the existing permit rather than acquiring a second slot. This works at concurrency one. Permits validate pool ownership and liveness, permit only one agent borrower at a time, and defer outer release until the borrower finishes. FIFO reserves capacity before waking a queued promise; releases are idempotent.

The executor rechecks policy expiry and reconnect state after admission and preparation. Acquisition, prepare and spawn failures release reservations. Rejected exit cleanup wakes subscribers rather than hanging streams. After a terminal event, it waits for process exit and stops a process that exceeds the grace period.

Lark debounce/batching and WeCom per-message serialization are preserved. Transport callbacks, card formats, encryption, risk semantics, credentials and permission decisions remain channel-specific.

## Persistence and privacy

WeCom keeps `WECOM_STATE_DIR/tasks.json`, v0.8 operation hashes and inbound dedupe through a compatibility facade. Its deterministic-risk replay exception is now a supplied policy. A generic ledger never assumes a task labelled risk is replay-safe. Live queued/running records are retained even when inactive history reaches its limit.

Lark's supervisor creates a ledger at `${appPaths.sessionsFile}.tasks.json` once per profile and reuses that object on channel reconnect. The executor records coarse lifecycle metadata, not raw prompts, model output or source operation IDs. Running tasks recovered after process restart are not silently replayed. Terminal ledger failures are logged without replaying the agent.

Lark integration is currently an **execution ledger**. Without a caller-supplied stable operationId it records run IDs; it does not add full inbound-batch deduplication. Neither ledger guarantees exactly-once external side effects such as mail sending or OA approval.

## Compatibility and limits

Old import paths re-export core implementations. Existing session paths, schemas, environment variables, CLI commands and card protocols are preserved. Credentials and histories are not copied across channels. The package version is unchanged; this branch is not a deployment or release.

Session/workspace implementations live in the shared library, but both session codecs are deliberately retained. WeCom has not yet switched to Lark's SessionCatalog or WorkspaceStore and still uses startup-fixed WECOM_WORKSPACE. Hot switching, session migration, a channel-neutral supervisor, unified commands and cross-process workspace locking are separate changes. Sharing code does not synchronize live bridge instances or prevent simultaneous edits to the same directory.

## Verification and Codex handoff

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

New `tests/unit/bridge` coverage checks dependency boundaries, compatibility exports, FIFO/dynamic capacity, overflow/timeout/shutdown, permit ownership, capacity-one WeCom execution, reasoning/model/sandbox/image forwarding, fanout, expiry after queueing, prepare failure, rejected cleanup, idempotent stop, ledger privacy/replay/retention, and old session-file compatibility.

Before deployment, validate on the existing Mac mini using an isolated state directory: ordinary conversation, stop/new/resume, runs/doctor, attachments, deterministic risk queries, WebSocket reconnect and process restart. Do not send real mail or submit OA actions. Do not point a second bot at the live state directory. Keep existing Windows-only baseline failures separate from regressions introduced here.
