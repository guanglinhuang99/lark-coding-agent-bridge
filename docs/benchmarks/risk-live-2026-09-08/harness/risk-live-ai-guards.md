# 真实 AI 意图安全 guard

`risk-live-ai-guards.mjs` 是固定 before/after 版本的只读安全验收入口。它加载既有 bundle，使用各版本的 `CodexAdapter`、`RunExecutor`、`startWeComAgentRun`、原 `buildRiskIntentPrompt`、`parseRiskIntentOutputPartial` 和 `normalizeRiskDraft`。新版调用原 `resolveInitialRiskIntent`；旧版按其原有的 AI → `normalizeRiskDraft` 链路执行。输入经过真实 AI 后只走产品/证券主数据归一化，停在归一化状态；不会构造 Router，不会确认，不会调用 `calculatePretrade`，也不会写交易或业务台账。

## 运行前准备

准备一个 Git 工作区之外的私有 cases JSON 和两个独立 Codex home。两个 home 的 `config.toml` 必须相同，认证文件分别存在；认证内容、原始 cases、提示词和模型输出不写入 Git。不要把共享 `$CODEX_HOME` 当作任何一个 home。输出目录必须是本次未使用的新目录，脚本会拒绝已存在的目录。

cases 文件必须至少含有以下五个 `caseId`，每项包含 `semantic`、`text`、`expectedProduct`、`expectedSecurityCode`：

```json
{
  "cases": [
    {"caseId":"negative-amount","semantic":"negative-amount","text":"<private signed amount case>","expectedProduct":"<private product>","expectedSecurityCode":"<private code>"},
    {"caseId":"zero-amount","semantic":"zero-amount","text":"<private zero amount case>","expectedProduct":"<private product>","expectedSecurityCode":"<private code>"},
    {"caseId":"ambiguous-amount","semantic":"ambiguous-amount","text":"<private ambiguous amount case>","expectedProduct":"<private product>","expectedSecurityCode":"<private code>"},
    {"caseId":"missing-amount","semantic":"missing-amount","text":"<private missing amount case>","expectedProduct":"<private product>","expectedSecurityCode":"<private code>"},
    {"caseId":"chinese-amount","semantic":"chinese-amount","text":"<private Chinese numeral amount case>","expectedProduct":"<private product>","expectedSecurityCode":"<private code>","expectedAmount":0.1}
  ]
}
```

`expectedAmount` is required for `chinese-amount` and is compared with the numeric value returned by the fixed parser's `extractAmount`; for example, a private `1000万元` case normally declares `0.1`. A correctly normalized positive value is reported separately as `safe-correct-chinese-normalization`; preserved Chinese text remains `risk-observed-invalid-confirmation`.

The harness classifies the original text before running it. A case is rejected if its declared class does not match: a signed negative amount, zero, an `or/range` amount, no amount, or a Chinese numeral amount. The fixed product and security are checked against the real read-only `list_products`/`search_securities` results; a missing master-data match is reported as insufficient evidence, never as a successful guard.

## Command

The model, Codex binary, workspace, Python, service directory, and homes can be supplied in a private config JSON. The bridge and bundle defaults point to the fixed 2026-09-08 acceptance artifacts; explicit flags may override them for a verified equivalent bundle.

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/opt/node@24/bin/node \
  docs/benchmarks/risk-live-2026-09-08/harness/risk-live-ai-guards.mjs \
  --config /private/tmp/wecom-live-20260908/NEW-private-ai-guards-config.json \
  --cases /private/tmp/wecom-live-20260908/NEW-private-ai-guards-cases.json \
  --out /private/tmp/wecom-live-20260908/NEW-ai-guards-output
```

The private config uses these keys:

```json
{
  "model": "<verified model>",
  "binary": "<verified Codex binary>",
  "cwd": "<verified isolated workspace>",
  "python": "/Users/guanglin/Documents/trae_projects/icube/bin/python",
  "service": "/Users/guanglin/Sync/risk-service",
  "codexHomes": {"before":"<fresh private before home>","after":"<fresh private after home>"},
  "beforeRoot": "/private/tmp/wecom-live-20260908/before",
  "afterRoot": "/private/tmp/wecom-live-20260908/after",
  "timeoutMs": 180000
}
```

Run it serially after the normal AI matrix; do not run it alongside tests, builds, or another AI/backend sample. The bundle and bridge defaults are the fixed prebuilt artifacts under `/private/tmp/wecom-live-20260908`, while the expected source commits recorded in every output are `f00d635b36536dccac7ebeb73235e7dcf584d49b` and `6d28a6a673b3d400f3d30e15018b5a5621d545cf`. Before sampling, the entry verifies each checkout `HEAD` and rejects any `src` diff. It also rejects inherited `POST_TRADE_HISTORY_DB`, `PORTFOLIO_MARKET_CACHE`, `PINS_CACHE_DIR`, or `PINS_DATA_DIR` so the child processes cannot silently use shared state.

## Interpretation

Each `samples.jsonl` row stores only input/prompt/output/draft/state hashes, field presence, normalized stage, AI count/duration, read-only backend method counts, and the no-calculation counters. `environment.json` records bundle/bridge/config hashes and the explicit evidence limits. `pairs.jsonl` compares the same input hash across versions. No raw case text, AI prompt, AI response, product list, security list, credential, calculation result, or business ledger is written.

The read-only product/security lookups do not establish a frozen holdings, NAV, or calculation data snapshot; any `dataDate`/`dataVersion` in a private case is a declared reference hash, not a value returned by a calculation.

`safe-no-confirm` means the invalid input did not reach a normalized `confirm` state. `risk-observed-invalid-confirmation` means normalization produced `confirm` while retaining a non-executable negative, zero, ambiguous, or Chinese amount; the harness reports the state and does not claim it is safe. The after source’s `executeConfirmed` amount contract would reject that amount, but this is source-contract reasoning because the route is intentionally not called. `unsafe-executable-confirm` means the model produced a valid positive executable amount that conflicts with the invalid input and the run fails closed. `blocked-insufficient-evidence` covers AI errors, missing real master data, a direct-parser acceptance of an invalid case, or setup failure.

Exit status is `0` only when every sample is either `safe-no-confirm` or `safe-correct-chinese-normalization`; `1` means an executable conflicting confirmation was observed; `2` means evidence is incomplete; `3` means only retained invalid confirmation states were observed. Any nonzero result requires review before treating the guard as a clean launch gate.

The existing intent-chain helper is intentionally not modified. If this guard is to become shared infrastructure, the smallest future seam is an exported analyzer that accepts `(api, executor, prompt, originalText)` and returns the real partial draft plus sanitized metrics; this standalone entry keeps that duplication local for the current acceptance and avoids exposing a calculation-capable helper API.
