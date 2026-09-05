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

On process restart, tasks that were `queued` or `running` are converted to `interrupted` and retain whether the interruption came from the queue or from actual execution. If WeCom redelivers the same message, replay is allowed only when it cannot silently duplicate a side effect: work that had not yet started (`queued`) may be replayed once, and a running deterministic risk calculation may be replayed once. A Codex or attachment task that had already reached `running` is **not** replayed automatically; the duplicate remains suppressed and the interrupted task is visible through `/runs` so the user can explicitly resend it if appropriate. Already completed or failed duplicates are suppressed.

If the durable task ledger becomes temporarily unwritable while the bridge is already running, a valid user message is not dropped solely because observability storage failed. The bridge reports the degraded task-store state and continues that message using the existing in-memory dedupe for the current process. Startup still fails closed on a damaged task JSON file so corruption is not silently overwritten.

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

- Codex availability/history lookup: bounded timeout and health probing
- Codex history lookup: transient retry + circuit breaker
- attachment download/resolve: bounded timeout + transient retry + circuit breaker

Retryable classes are timeout, network, rate-limit, and HTTP 5xx. HTTP 4xx and unknown errors fail directly.

## P0: `/doctor`

`/doctor` returns a WeCom dependency matrix for:

- WeCom connection
- live Codex CLI availability/version
- workspace path
- deterministic risk service
- durable task store
- retry/circuit state

It also reports durable task counts and whether unfinished work was recovered during startup.

The Codex row is a real availability probe rather than a configuration echo. A disabled optional risk service is a warning, not a bridge-wide failure. A configured-but-unavailable risk service is an error for that dependency while the rest of the bridge remains usable.

## P1: home and recent tasks

The Home Card keeps the proven small button layout. It exposes a deliberately short `/doctor`, `/runs`, `/resume`, `/model`, `/reasoning`, `/settings`, and `/测算` shortcut line that stays visible within the WeCom TUI text limit. The latest substantive completed/failed/interrupted task is shown as compact context; control commands themselves are not preferred as the "recent task".

`/runs` shows recent per-conversation tasks without retaining raw prompts.

## P1: `cli.ts` decomposition

This phase avoids a high-risk rewrite of the large WeCom entry point. Cross-cutting responsibilities have been extracted into focused modules instead:

- `src/wecom/task-store.ts` — durable task/idempotency state
- `src/wecom/reliability.ts` — retry, timeout, circuit breaker, failure classification
- `src/wecom/ui/doctor.ts` — Doctor and recent-task presentation

`src/wecom/cli.ts` remains the wiring/orchestration layer. Further daily-work features should continue this direction rather than adding new state stores or retry implementations directly to `cli.ts`.

## State semantics

A task remains `queued` while waiting for the per-conversation or global run gate. It becomes `running` only after the global run slot is acquired. Recording `running` is fail-safe: if that state cannot be persisted, execution does not begin, which protects restart idempotency.

A user stop request immediately records `interrupted` before the agent process finishes stopping. Soft failures that are handled for presentation purposes (queue rejection, queue timeout, global capacity rejection, or an internally rendered execution failure) must still persist as failed tasks rather than being overwritten as `done` by the outer message handler. After a successful/terminal user result has already been produced, terminal task-ledger writes are best-effort observability: a storage failure is logged and measured but must not turn an otherwise successful user-visible result into a second failure response.
