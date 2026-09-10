# WeCom v0.8.4 Post-Done Exit Acceptance

## 1. Baseline

- Git HEAD: `b45bdc4b3409090689248ce84b798e832a2d3e33`
- Git `origin/main`: `b45bdc4b3409090689248ce84b798e832a2d3e33`
- Release path: `/Users/guanglin/.lark-channel/releases/wecom-v0.8.4-b45bdc4`
- Loaded WeCom entrypoint: `/Users/guanglin/.lark-channel/releases/wecom-v0.8.4-b45bdc4/bin/wecom-channel-bridge.mjs`
- WeCom LaunchAgent: `ai.wecom-channel-bridge.riskbot-codex`
- WeCom baseline PID / runs: `7564` / `1`
- WeCom stdout baseline: `683` bytes at `2026-09-10 13:40:37 +0800`
- WeCom stderr baseline: `0` bytes at `2026-09-10 13:40:37 +0800`
- Lark LaunchAgent: `ai.lark-channel-bridge.bot.codex`
- Lark baseline PID / runs: `36940` / `1`
- Health baseline: `healthy=true`, `reason=ok`, `phase=connected`, `connected=true`, `activeRuns=0`, `startingRuns=0`

## 2. Test Results

All timestamps below are CST (`+08:00`) on 2026-09-10. The exit delay is measured from the `run.completed` terminal event to the `agent.exit` event.

| Test | Business Result | Message Received | Run Start | Terminal Time | Process Exit Time | Exit Delay | Timeout Warning | Stop Fallback | Task State |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 1 | PASS (`v084-exit-test-1`) | 13:55:43.062 | 13:55:44.207 | 13:55:54.212 | 13:55:59.225 | 5013ms | YES | SIGTERM | done |
| 2 | PASS (`391`) | 13:56:39.093 | 13:56:40.143 | 13:56:48.441 | 13:56:53.455 | 5014ms | YES | SIGTERM | done |
| 3 | PASS (one-sentence idempotency explanation) | 13:57:03.471 | 13:57:04.468 | 13:57:12.884 | 13:57:17.896 | 5012ms | YES | SIGTERM | done |
| 4 | PASS (three Git branch names) | 13:57:27.305 | 13:57:28.446 | 13:57:37.801 | 13:57:42.819 | 5018ms | YES | SIGTERM | done |
| 5 | PASS (`v084-exit-test-5`) | 13:57:55.006 | 13:57:56.016 | 13:58:03.811 | 13:58:08.829 | 5018ms | YES | SIGTERM | done |

The five Codex child PIDs were `17957`, `18191`, `18329`, `18470`, and `18635`. Each emitted `run.completed`, then exhausted the 5000ms post-done grace period, received SIGTERM, and emitted `agent.exit` 11-17ms later. None exited naturally within the configured grace period.

## 3. Warning Count

- `run.post-done-exit-timeout`: `5`
- `agent.stop-sigterm`: `5`
- `agent.stop-sigkill`: `0`
- New-log crash / fatal / uncaught / unhandled indicators: `0`

Counts cover only data appended after the v0.8.4 test baseline; historical warnings were excluded.

## 4. Runtime Stability

- WeCom PID before / after: `7564` / `7564`
- WeCom runs before / after: `1` / `1`
- Final `activeRuns`: `0`
- Final `startingRuns`: `0`
- Restart observed: `NO`
- Multiple WeCom instances observed: `NO`; final process inspection found only PID `7564` for the v0.8.4 entrypoint.
- Residual Codex child process observed: `NO`
- Queue stuck: `NO`

Two consecutive final health samples reported `healthy=true`, `reason=ok`, `phase=connected`, `connected=true`, `activeRuns=0`, and `startingRuns=0`.

## 5. Lark Protection

- PID before / after: `36940` / `36940`
- runs before / after: `1` / `1`
- Lark remained running and was not stopped or restarted.

## 6. Conclusion

`V0.8.4 POST-DONE EXIT ACCEPTANCE: PARTIAL PASS`

All five normal conversations completed successfully and the runtime returned to an idle, healthy state without a WeCom or Lark restart. However, 5/5 Codex child processes failed to exit naturally within 5000ms. Every run emitted `run.post-done-exit-timeout`, required the SIGTERM fallback, and exited 5012-5018ms after its terminal event. This sample therefore does not show that v0.8.4 resolved or significantly reduced the post-done exit timeout behavior.

No source, test, environment file, LaunchAgent, timeout configuration, service, state/session/task ledger, or existing report was modified. No service was restarted. No commit, push, PR, tag, or release was created.
