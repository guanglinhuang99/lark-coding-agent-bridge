# WeCom Codex Post-Done Exit Incident Closure

Date: 2026-09-10

## Summary

The WeCom production bridge had a non-fatal Codex child-process lifecycle issue after otherwise successful runs. The user-visible task completed, but the one-shot Codex child process remained alive until the bridge timeout path stopped it.

The issue was first observed during the v0.8.3 production acceptance, was isolated by the v0.8.4 experiment, and was resolved in v0.8.5 by separating normal post-terminal cleanup from user interruption semantics.

## Timeline

### v0.8.3 — issue observed

Production acceptance passed functionally, including normal chat, queued conversation handling, `/stop`, post-stop recovery, and the risk path. Runtime stability was good, but six `run.post-done-exit-timeout` warnings were observed after successful Codex outputs.

Evidence: `docs/WECOM_V083_PRODUCTION_ACCEPTANCE_20260910.md`.

### v0.8.4 — grace extension did not fix the lifecycle

The WeCom Codex post-done grace was increased from 2000ms to 5000ms. Five controlled normal-chat runs all completed successfully, but all five still waited for the full grace period and required the fallback stop path.

Observed results:

- `run.post-done-exit-timeout`: 5/5
- `agent.stop-sigterm`: 5/5
- `agent.stop-sigkill`: 0/5
- terminal-to-exit delay: 5012–5018ms, average about 5015ms
- task classification remained `done`

This showed that the problem was not simply an insufficient grace duration. The Codex one-shot process was not naturally exiting after the terminal event.

Evidence: `docs/WECOM_V084_POST_DONE_EXIT_ACCEPTANCE_20260910.md`.

### v0.8.5 — lifecycle semantics corrected

The normal completion path was changed so that:

1. `AgentRun` exposes an optional `finish()` hook.
2. After a successful normal terminal event, `RunExecutor` invokes `finish()` before fallback waiting.
3. `CodexAdapter.finish()` sends SIGTERM to terminate the completed one-shot process without setting the run result to `interrupted`.
4. Explicit `/stop` continues to use `stop()` and preserves `interrupted` semantics.
5. The post-done grace remains as a fallback for abnormal cleanup if the process still does not exit after `finish()`.

Production validation results:

- normal conversations: 5/5 PASS
- task state: `done=5`, `interrupted=0`, `failed=0`
- expected `agent.finish-sigterm`: 5/5
- `run.post-done-exit-timeout`: 0/5
- fallback `agent.stop-sigterm`: 0/5
- `agent.stop-sigkill`: 0/5
- terminal-to-exit delay: 4–6ms, average about 5ms
- WeCom PID/runs stable
- Lark PID/runs stable
- no residual Codex child, stuck queue, or restart loop

Compared with v0.8.4, average terminal-to-exit latency fell from about 5015ms to about 5ms, approximately a 99.9% reduction in the controlled production sample.

Evidence: `docs/WECOM_V085_NORMAL_TERMINAL_CLEANUP_ACCEPTANCE_20260910.md`.

## Final Semantics

A successful Codex terminal event does not imply that the one-shot child process will exit by itself. The bridge therefore performs immediate normal cleanup through `finish()`. This cleanup may use SIGTERM, but it is not an interruption and must not change a successfully completed task from `done` to `interrupted`.

`WECOM_CODEX_POST_DONE_EXIT_GRACE_MS` is retained as an abnormal-cleanup fallback window after the normal `finish()` action. It should not be interpreted as a normal delay during which every successful Codex process is expected to remain alive.

## Final Status

Current stable production release: `v0.8.5`

Release commit: `4d9f10726ccbcc5d59909cd1e2724710d6b13325`

Production acceptance: PASS

The incident is considered closed. No further grace increase is recommended based on the v0.8.5 evidence.
