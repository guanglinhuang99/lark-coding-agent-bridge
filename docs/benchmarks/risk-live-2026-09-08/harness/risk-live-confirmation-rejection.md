# 真实 AI 无效确认拒绝回放

`risk-live-confirmation-rejection.mjs` 对 `risk-live-ai-guards` 已捕获的新版
`confirm` 状态做一个短回放。它加载固定 after bundle，检查 checkout 的
`HEAD=6d28a6a673b3d400f3d30e15018b5a5621d545cf` 且 `src` 无修改，然后调用真实
`WeComRiskRouter.executeConfirmed`。传入的 `RiskService` 每个方法都是立即失败的
trap；因此任何 `listProducts`、证券查询或 `calculatePretrade` 调用都会使该样本失败，
并且不会启动 Python、risk-service、AI 或交易。

## 输入与回放边界

必须提供 guard 的脱敏 `samples.jsonl` 和工作区外的私有 cases JSON。脚本要求
after 样本来自真实 AI，状态为 `risk-observed-invalid-confirmation`，处于 `confirm`，
且原 guard 已观察到零 `calculatePretrade` 调用。默认从私有 case 的产品、证券代码、
动作和金额类别重建 `confirm` 状态，再用与 guard 相同的递归键排序 SHA256 计算
`stateHash`、`draftHash` 和字段哈希；任一哈希不匹配就停止该样本，不进入 Router。
这使当前 guard 只保存哈希时仍能进行 fail-closed 的同状态核对。若后续另有私有完整
状态快照，可用 `--states` 提供 `states[].state`，脚本仍会执行同样的哈希核对。

当前固定用例的证券名称可通过私有 flag 传入；它不会写入输出。名称必须与 guard
状态中已哈希的证券对象一致，否则结果是 `state-hash-mismatch`，不能被当作通过。
cases、状态快照和模型原文都不进入 Git；输出只保存 hash、case ID、类别和计数。

## 运行

先确认主线程没有运行 AI、后端或性能采样，再使用一次新的输出目录：

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/opt/node@24/bin/node \
  docs/benchmarks/risk-live-2026-09-08/harness/risk-live-confirmation-rejection.mjs \
  --cases /private/tmp/wecom-live-20260908/ai-guards-private.json \
  --guard-samples /private/tmp/wecom-live-20260908/ai-guards-live-1/samples.jsonl \
  --security-name '国债0115' \
  --out /private/tmp/wecom-live-20260908/confirmation-rejection-live-NEW
```

如果采用完整私有状态快照：

```sh
.../risk-live-confirmation-rejection.mjs \
  --cases /absolute/private-cases.json \
  --guard-samples /absolute/ai-guards/samples.jsonl \
  --states /absolute/private-state-snapshots.json \
  --out /absolute/new-output
```

`--states` 的最小格式是：

```json
{
  "states": [
    {"caseId": "negative-amount", "state": {"stage": "confirm", "draft": {"...": "..."}}}
  ]
}
```

脚本不会写入已存在的输出目录，也会拒绝继承
`POST_TRADE_HISTORY_DB`、`PORTFOLIO_MARKET_CACHE`、`PINS_CACHE_DIR` 和
`PINS_DATA_DIR`。默认 bundle/root 指向固定 after 验收目录，也可用 `--bundle` 和
`--root` 显式指定后再由固定 HEAD 检查确认。

## 断言与结果

每个目标 case 依次执行以下检查：

1. guard 样本的真实 AI、`confirm`、无正数语义冲突和零测算调用条件成立。
2. 回放状态的 normalized state/draft/字段哈希与 guard 记录完全一致，金额类别仍为
   negative、zero、ambiguous 或保留中文金额。
3. 固定源的 `RiskSelectionTaskRegistry` 只消费一次 `confirm` 选项，重复消费得到
   `missing`。这是源码 registry 证据，不是企业微信平台 callback 证据。
4. `executeConfirmed` 返回 `handled=true` 且 `intent=risk-error`，并且 trap 记录的
   service 调用数和 `calculatePretrade` 调用数都为零。金额拒绝发生在 Router 的
   金额格式/正数校验之前，未调用真实后端。

输出包含 `environment.json`、`samples.jsonl` 和 `summary.json`。全部目标通过时退出
`0`；输入缺失、哈希不一致、guard 状态不符合条件或固定源不正确时退出 `2`。任何
Router 返回非错误结果或 trap 被调用也会被记录为失败并退出 `2`。

## 证据边界

这是“真实 AI 已捕获状态 + 固定 after Router”的哈希核对回放。它证明这些已捕获的
无效确认状态在当前 after 路由中被拒绝，且回放过程没有发起任何 risk-service 调用。
它不重新运行模型，不证明模型输出本身的重新生成，不证明企业微信卡片收发或人工点击，
也不证明持仓、NAV、行情快照或数据库执行被中断。当前 `ai-guards-live-1` 原始输出
只保存 hash；未提供 `--states` 时，case 重建字段必须先通过 hash 比对，不能把重建
本身称为原始 AI 文本快照。
