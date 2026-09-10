# WeCom Release Candidate Validation

This document is the acceptance contract for a release-candidate validation of the WeCom bridge after the Card UI work through PR #6.

## Baseline

- Repository: `guanglinhuang99/lark-coding-agent-bridge`
- Branch under test: `main`
- Expected baseline HEAD: `2644bc52c9b74d176ddfd7efb5ae2ff3b31da6db`
- Do not introduce feature work during RC validation.

## 1. Repository and environment

Record:

- `pwd`
- `git status --short --branch`
- `git rev-parse HEAD`
- Node version
- pnpm version
- WeCom workspace path
- whether the real WeCom bot credentials/config are available

The working tree must be clean before release validation starts.

## 2. Automated validation

Run, in order:

```bash
pnpm test -- tests/unit/wecom
pnpm test
pnpm typecheck
pnpm run ci
```

All must pass. If a command is redundant with another script, still report the exact command and result.

## 3. WeCom connection smoke test

Start the bridge using the project's normal documented runtime method. Do not invent an alternate launch path.

Verify:

- bot authenticates successfully
- websocket stays connected during the test
- health check is healthy if the project exposes one
- no new recurring errors appear in logs

## 4. Home / control card

Validate in the real WeCom client:

- `enter_chat` shows Home Card
- `/menu` shows Home Card
- idle state shows `new` and `status`
- busy state shows `stop`, `new`, and `status`
- quick command hint includes `/model`, `/reasoning`, `/resume`, `/settings`
- buttons are fully visible on desktop and mobile if both are available
- no clipping or malformed card layout

## 5. Settings and selectors

Validate:

- `/settings` shows current workspace, model, reasoning, sandbox/permission when available
- `/model` opens model selector and applying a value affects only the current conversation
- `/reasoning` opens reasoning selector and applying a value affects only the current conversation
- invalid selection does not mutate state
- expired selector produces an understandable expired-card result
- duplicate selector click does not apply the change twice
- callback from another conversation does not mutate the original conversation

## 6. Session resume

Validate:

- `/resume` lists real Codex history when available
- session entries show workspace context
- relative-time hint is shown only when backed by real `updatedAtMs`
- selecting a session updates only the current conversation thread
- resume is blocked while the current conversation is busy
- no fake or guessed session timestamps are displayed

## 7. Normal Codex run

Run a small real Codex task that finishes successfully.

Verify:

- Markdown remains the primary answer surface
- streaming behavior is normal
- Result Card is sent after the Markdown result
- Result Card shows only reliable values among duration, tool count, file count, model, reasoning, thread
- Result Card does not duplicate the full answer
- `new` and `status` buttons work

## 8. Stop / interrupted run

Start a task long enough to stop manually.

Verify:

- `stop` requests interruption
- final state is stopped/interrupted rather than success
- Result Card uses stopped state
- no duplicate completion card is sent

## 9. Error path

Trigger only a safe, non-destructive known failure if an existing test mechanism is available. Do not intentionally damage configuration or data.

Verify:

- error uses the existing Error Card path
- an additional Result Error Card is not sent
- error message is understandable and does not expose secrets

If no safe real error trigger exists, record this item as not exercised rather than fabricating one.

## 10. Risk flow regression

Run at least one normal risk-query interaction that reaches a selection card if the local risk service is available.

Verify semantics remain unchanged:

- `selected` continues business flow
- `invalid` keeps the card interactive
- `mismatch` maps to invalid callback behavior
- `missing` / `expired` map to expired callback behavior
- existing RiskSelectionTaskRegistry behavior is preserved

If risk service is unavailable, run the complete risk unit-test suite and record the live-test blocker.

## 11. Message density / UX observation

Record concise observations from the real WeCom client:

- Home Card length
- selector readability
- Session list readability
- Markdown + Result Card density
- whether Result Card feels useful or redundant
- mobile button visibility
- any obvious place where manual commands are still awkward

Do not change UX during the RC run. Record findings for a later issue/PR.

## 12. Acceptance criteria

RC is PASS only when:

- automated tests pass
- typecheck passes
- CI script passes
- bot authenticates and stays healthy
- Home / selectors / Result Card work in real WeCom
- no cross-conversation state leak is observed
- no duplicate callback side effect is observed
- no Error Card + Result Error Card duplication is observed
- Risk regression is either live PASS or unit PASS with a documented environment blocker
- working tree is clean after validation

## Final report format

Return:

1. Start HEAD
2. End HEAD
3. Working tree status
4. Automated tests PASS/FAIL
5. Typecheck PASS/FAIL
6. CI PASS/FAIL
7. WeCom auth/health PASS/FAIL
8. Home Card PASS/FAIL
9. Settings/model/reasoning PASS/FAIL
10. Session resume PASS/FAIL
11. Successful run + Result Card PASS/FAIL
12. Stop/interrupted run PASS/FAIL
13. Error path PASS/FAIL/NOT EXERCISED
14. Risk flow PASS/FAIL/BLOCKED
15. Desktop/mobile UI observations
16. Any release blockers
17. Final recommendation: RELEASE / HOLD

Do not merge, tag, publish a release, or make feature changes during this validation unless explicitly asked later.
