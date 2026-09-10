# WeCom v0.8.3 Production Acceptance

Acceptance window: 2026-09-10 11:27-11:51 CST

## 1. Baseline

- Git HEAD: `df511c9eb99fe6b39c0b76cc99dde04980ff7d50`
- Git `origin/main`: `df511c9eb99fe6b39c0b76cc99dde04980ff7d50`
- Release path: `/Users/guanglin/.lark-channel/releases/wecom-v0.8.3-df511c9`
- Loaded entry: `/Users/guanglin/.lark-channel/releases/wecom-v0.8.3-df511c9/bin/wecom-channel-bridge.mjs`
- WeCom LaunchAgent: `ai.wecom-channel-bridge.riskbot-codex`
- WeCom baseline PID / runs: `87355` / `1`
- Lark LaunchAgent: `ai.lark-channel-bridge.bot.codex`
- Lark baseline PID / runs: `36940` / `1`
- Health baseline at 11:27:43 CST: `healthy=true`, `reason=ok`, `phase=connected`, `connected=true`, `activeRuns=0`, `startingRuns=0`; heartbeat age 1.4 seconds.
- Baseline task ledger: schema version 1; 74 terminal tasks (`done=73`, `interrupted=1`), with no queued or running task.
- Only the loaded production WeCom LaunchAgent was used. No second Bot instance was started.

## 2. Test Matrix

| Case | Result | Evidence |
| --- | --- | --- |
| Normal chat | PASS | Message received at 11:44:37 CST; Codex run started at 11:44:38; first final output at 11:44:48; task reached `done` at 11:44:50. The client displayed the requested reply once and did not remain in processing. Health returned to zero active/starting runs. |
| Conversation queue | PASS | Long task created at 11:48:01 and remained running when the follow-up was created at 11:48:41. At 11:48:53 health showed `activeRuns=1`, `startingRuns=1`; ledger states were first=`running`, second=`queued`. The client displayed the queue notice and position 1. First task completed at 11:48:55, then the second run started; both reached `done` in order by 11:49:08. No message loss, duplicate execution, or residual queue was observed. |
| /stop | PASS | Long task started at 11:49:35. `/stop` was sent while it was processing at 11:49:43. The target task reached `interrupted`, the command task reached `done`, and the client displayed explicit stopped/interrupted feedback. No late complete 50-item answer appeared. |
| Post-stop recovery | PASS | Recovery task created at 11:49:59, returned the requested recovery reply at 11:50:07, and reached `done` at 11:50:09. Health returned to `activeRuns=0`, `startingRuns=0`. |
| Risk query | PASS | Existing acceptance-style credit query was used. Ledger `kind=risk` confirmed risk-intent routing without fallback to normal chat. The structured bridge event completed through `get_credit` in about 20 seconds. The client showed a structured risk result with date/unit headers and no explicit failure. Sensitive business values are `[REDACTED]`. |

## 3. Runtime Stability

- WeCom PID before / after: `87355` / `87355`
- WeCom runs before / after: `1` / `1`
- Final LaunchAgent state: running; last exit code: never exited.
- Final health: `healthy=true`, `reason=ok`, `phase=connected`, `connected=true`.
- Final health heartbeat was fresh in two consecutive samples; `activeRuns=0`, `startingRuns=0`.
- Final ledger: schema version 1; `queued=0`, `running=0`; all acceptance tasks were terminal.
- The new stdout/stderr segments contained no matches for uncaught, unhandled, reconnect loop, unknown command, crash, fatal, queue error, lingering recovery error, or duplicated execution.
- Stderr observation: six `run.post-done-exit-timeout` warnings occurred after successful Codex outputs. Each was followed by the expected child-run termination/exit sequence; tasks reached `done`, the production PID did not change, and no queue or running task remained. These warnings were non-fatal and did not affect the acceptance outcome.
- No restart loop or duplicate Bot execution was observed.

## 4. Lark Protection

- Lark PID before / after: `36940` / `36940`
- Lark runs before / after: `1` / `1`
- Lark remained running and was not stopped, restarted, or modified during this acceptance.

## 5. Issues

- No acceptance-blocking issue.
- Non-blocking observation: successful Codex runs emitted six `run.post-done-exit-timeout` warnings as described above; there was no production restart, failed task, or residual work.

## 6. Final Verdict

PRODUCTION ACCEPTANCE: PASS

No source code, tests, production configuration, LaunchAgent, environment file, state directory, session, task ledger, or logs were modified or cleared. No commit, push, PR, tag, release, package publication, or service restart was performed.
