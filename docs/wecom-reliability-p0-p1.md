# WeCom reliability P0/P1

This change hardens the WeCom bridge before more daily-work integrations are added.

## P0: durable tasks and recovery

Inbound WeCom messages are recorded in `WECOM_STATE_DIR/tasks.json` with atomic replacement and mode `0600`.

The task ledger stores only operational metadata:

- task id
- SHA-256 operation key derived from the WeCom message id
- conversation key
- task kind and coarse label
- queued/running/done/failed/interrupted state
- attempt count and timestamps
- normalized error kind

It does **not** persist the raw WeCom message id, prompt text, attachment contents, or model output.

On process restart, tasks that were `queued` or `running` are converted to `interrupted`. If WeCom redelivers the same message after that restart, the durable operation key permits at most one recovery replay. Already completed or failed duplicates are suppressed.

Configuration:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `WECOM_TASK_TTL_MS` | 7 days | Retain inactive durable task records |
| `WECOM_TASK_MAX_ENTRIES` | 2000 | Maximum retained task records |

## P0: idempotency

The existing in-memory message-id deduplicator remains the fast first layer. The durable task ledger is the second layer and survives bridge restarts.

Card selections keep their existing consume-once lifecycle. A stale or restarted card is rejected instead of being re-executed. Future mutating integrations such as sending mail, approving OA, or updating a work ledger should use the durable `operationKey` as the idempotency key at the service boundary as well.

## P0: shared reliability policy

`src/wecom/reliability.ts` owns common failure classification, timeout, retry, queue notices, and circuit-breaker behavior.

Automatic retry is deliberately limited to operations declared `idempotent: true`. Agent runs and future mutating business operations must not be silently replayed.

The first integrations are:

- Codex history lookup: bounded timeout + transient retry + circuit breaker
- attachment download/resolve: bounded timeout + transient retry + circuit breaker

Retryable classes are timeout, network, rate-limit, and HTTP 5xx. HTTP 4xx and unknown errors fail directly.

## P0: `/doctor`

`/doctor` returns a WeCom dependency matrix for:

- WeCom connection
- Codex availability/model
- workspace path
- deterministic risk service
- durable task store
- retry/circuit state

It also reports durable task counts and whether unfinished work was recovered during startup.

A disabled optional risk service is a warning, not a bridge-wide failure. A configured-but-unavailable risk service is an error for that dependency while the rest of the bridge remains usable.

## P1: home and recent tasks

The Home Card keeps the proven small button layout. It now exposes `/doctor` and `/runs` in the shortcut hint and shows the latest completed/failed/interrupted task as compact context.

`/runs` shows recent per-conversation tasks without retaining raw prompts.

## P1: `cli.ts` decomposition

This phase avoids a high-risk rewrite of the large WeCom entry point. Cross-cutting responsibilities have been extracted into focused modules instead:

- `src/wecom/task-store.ts` — durable task/idempotency state
- `src/wecom/reliability.ts` — retry, timeout, circuit breaker, failure classification
- `src/wecom/ui/doctor.ts` — Doctor and recent-task presentation

`src/wecom/cli.ts` remains the wiring/orchestration layer. Further daily-work features should continue this direction rather than adding new state stores or retry implementations directly to `cli.ts`.

## State semantics

A task remains `queued` while waiting for the per-conversation or global run gate. It becomes `running` only after the global run slot is acquired.

A user stop request immediately records `interrupted` before the agent process finishes stopping. Soft failures that are handled for presentation purposes (queue rejection, queue timeout, global capacity rejection, or an internally rendered execution failure) must still persist as failed tasks rather than being overwritten as `done` by the outer message handler.
