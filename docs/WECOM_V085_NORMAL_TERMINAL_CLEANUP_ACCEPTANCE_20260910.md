# WeCom v0.8.5 Normal Terminal Cleanup Acceptance

## 1. Baseline

- Git HEAD: `4d9f10726ccbcc5d59909cd1e2724710d6b13325`
- Git `origin/main`: `4d9f10726ccbcc5d59909cd1e2724710d6b13325`
- WeCom release: `/Users/guanglin/.lark-channel/releases/wecom-v0.8.5-4d9f107`
- Loaded WeCom entrypoint: `/Users/guanglin/.lark-channel/releases/wecom-v0.8.5-4d9f107/bin/wecom-channel-bridge.mjs`
- WeCom LaunchAgent: `ai.wecom-channel-bridge.riskbot-codex`
- WeCom baseline PID / runs: `26000` / `1`
- Lark LaunchAgent: `ai.lark-channel-bridge.bot.codex`
- Lark baseline PID / runs: `36940` / `1`
- Health baseline: `healthy=true`, `reason=ok`, `phase=connected`, `connected=true`, `activeRuns=0`, `startingRuns=0`
- Test log baseline at `2026-09-10 14:55:00 +0800`: stdout `2186` bytes; stderr `6359` bytes.

At the first pre-test observation, an unrelated task was already running (`startingRuns=1`, ledger `running=1`). No test message was sent concurrently. The acceptance test started only after that task finished naturally, the ledger had no queued/running task, health returned to 0/0, and fresh log offsets were recorded. The pre-existing activity is excluded from all counts below.

## 2. Test Results

All timestamps are CST (`+08:00`) on 2026-09-10. Each test had `activeRuns=0` and `startingRuns=0` after exit.

| Test | Business Result | Terminal | Finish SIGTERM | Exit | Terminal→Finish | Finish→Exit | Terminal→Exit | Timeout | Stop SIGTERM | Stop SIGKILL | Task State |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | PASS (`v085-finish-test-1`) | 14:55:37.165 | 14:55:37.165 | 14:55:37.171 | 0ms | 6ms | 6ms | NO | NO | NO | done |
| 2 | PASS (`493`) | 14:56:38.495 | 14:56:38.495 | 14:56:38.500 | 0ms | 5ms | 5ms | NO | NO | NO | done |
| 3 | PASS (one-sentence idempotency explanation) | 14:57:09.122 | 14:57:09.122 | 14:57:09.126 | 0ms | 4ms | 4ms | NO | NO | NO | done |
| 4 | PASS (three Git branch names) | 14:57:42.538 | 14:57:42.538 | 14:57:42.543 | 0ms | 5ms | 5ms | NO | NO | NO | done |
| 5 | PASS (`v085-finish-test-5`) | 14:58:07.088 | 14:58:07.088 | 14:58:07.093 | 0ms | 5ms | 5ms | NO | NO | NO | done |

Message-received and run-start timestamps:

| Test | Message Received | Run Start |
| --- | --- | --- |
| 1 | 14:55:24.348 | 14:55:25.410 |
| 2 | 14:56:29.371 | 14:56:30.471 |
| 3 | 14:56:58.500 | 14:56:59.541 |
| 4 | 14:57:31.209 | 14:57:32.319 |
| 5 | 14:57:58.859 | 14:57:59.941 |

The five Codex child PIDs were `29913`, `30107`, `30291`, `30435`, and `30564`. Each followed the expected normal path `run.completed → agent.finish-sigterm → agent.exit` and exited with SIGTERM 4-6ms after the terminal event. No normal completion was classified as interrupted.

## 3. Event Counts

- `run.completed`: `5`
- `agent.finish-sigterm`: `5`
- `agent.exit`: `5`
- `run.post-done-exit-timeout`: `0`
- `agent.stop-sigterm`: `0`
- `agent.stop-sigkill`: `0`

Only the five-test interval after the 14:55:00 baseline is included. The v0.8.5 release stdout/stderr increments contained no timeout, interrupted, failed, crash, fatal, uncaught, unhandled, fallback stop-sigterm, or stop-sigkill indicator.

## 4. Task Classification

- done: `5`
- interrupted: `0`
- failed: `0`

## 5. Runtime Stability

- WeCom PID before / after: `26000` / `26000`
- WeCom runs before / after: `1` / `1`
- Final `activeRuns`: `0`
- Final `startingRuns`: `0`
- residual Codex child: `NO`
- queue stuck: `NO`
- restart observed: `NO`
- multiple WeCom instances observed: `NO`

Two consecutive final health samples reported `healthy=true`, `reason=ok`, `phase=connected`, `connected=true`, `activeRuns=0`, and `startingRuns=0`. Final process inspection found only PID `26000` for the v0.8.5 WeCom entrypoint and no child process with PPID `26000`.

## 6. Lark Protection

- PID before / after: `36940` / `36940`
- runs before / after: `1` / `1`
- Lark remained running and was not stopped or restarted.

## 7. Comparison With v0.8.4

v0.8.4:

- timeout: `5/5`
- stop-sigterm: `5/5`
- terminal→exit: approximately `5012–5018ms` (average `5015ms`)

v0.8.5:

- timeout: `0/5`
- stop-sigterm: `0/5`
- expected finish-sigterm: `5/5`
- terminal→exit: `4–6ms` (average `5ms`)

Compared with the v0.8.4 production sample, average terminal-to-exit delay fell from approximately 5015ms to 5ms, an approximately 99.9% reduction (about 1000 times faster). All five prior timeout/fallback occurrences were eliminated in this sample while preserving `done` classification.

## 8. Conclusion

`V0.8.5 NORMAL TERMINAL CLEANUP ACCEPTANCE: PASS`

All acceptance criteria were met: 5/5 normal conversations succeeded, all five tasks remained `done`, every run used the expected `finish-sigterm` path and exited within 4-6ms, no timeout or fallback stop event occurred, runtime state returned to 0/0, and the WeCom and Lark services remained stable.

No source, test, environment file, LaunchAgent, timeout configuration, service definition, or pre-existing report was modified. No state, session, or task ledger was cleared, deleted, truncated, or manually edited; the service appended only the normal task records created by these five tests. No service was restarted. No commit, push, PR, tag, or release was created.
