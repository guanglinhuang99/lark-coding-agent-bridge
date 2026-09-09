# 多笔证券测算

`/测算` 支持同一账户的一笔或多笔交易，不固定为两只证券。自然语言清单由 AI 输出 `transactions`，逐笔核验证券和金额，全部确认后一次性提交后端 `actions`，计算整个组合的合并影响。旧单笔接口仍可用。

## 输入和确认

- 账户仍通过存续产品列表匹配；简称或歧义进入账户选择，不猜正式账户。
- 每笔保留证券、方向、金额及市场。`w/W` 按万元换算，`1000w` 对应 `0.1` 亿元。
- 明确的共享一级市场说明应用于列表；逐笔市场说明优先。某一笔的一级说明不会自动应用到下一笔；“二级资本债”不构成二级市场说明。
- 一级买入为 `buy + primary`，一级申购为 `subscription + primary`，两者均需核验证券。没有明确一级说明时按既有规则默认二级。
- 期限与收益率保留原文供确认，不作为价格或回购天数传入测算。
- 拟交易日期保留原文；后端继续使用自身测算基准日，本修改不提供指定未来日期的行情/持仓模拟。
- 所有明细在确认卡前完整发送；长清单分段展示，确认卡只显示账户和总笔数。
- 有歧义或缺金额时按“第N笔”补充，不能跳过该笔执行其余交易。任何动作未核验、金额无效，都不能提交整批。
- 可输入“第2笔金额改为3000万”“第3笔证券改为代码”“第1笔改为一级申购”等。未指定序号的金额修改需要澄清。证券变更会清除该笔旧证券匹配和期限/收益率备注。

## AI 输出约定

```json
{
  "account_query": "测试账户甲",
  "trade_date_text": "明天（9.9）",
  "transactions": [
    {
      "action": "buy",
      "security_query": "900000001.IB",
      "amount_text": "120w",
      "tenor_text": "3.21Y",
      "yield_text": "1.23",
      "source_text": "1、一级市场 3.21Y 900000001.IB 虚构测试债券甲 1.23 120w"
    }
  ]
}
```

例中证券为虚构测试标识。`source_text` 必须摘录输入原文，供逐笔市场识别。AI 不提供已核验证券对象，也不输出风控结论。初始入口会检查原文证券代码覆盖，拒绝漏掉末笔或把多个代码塞进不足数量的交易。名称形式清单的完整性仍依赖模型提取和用户核对确认。

## 验证入口

- `tests/unit/wecom/risk-batch.test.ts`：多笔、一级、混合市场、遗漏、逐笔修正、非法金额和整批一次提交。
- `tests/unit/wecom/risk-batch-cli.test.ts`：执行实际 CLI 选择回调，保留笔序，验证35笔明细完整展示后才注册确认卡；通讯为模拟。
- `tests/unit/wecom/risk-batch-harness.test.ts`：harness 规范化输入、实际动作数组及旧单笔兼容。
- `tests/python/test_risk_dispatcher.py` 与 client 测试：验证单对象兼容、非空动作数组一次提交和非法数组拒绝。
- `docs/benchmarks/risk-live-2026-09-08/harness/risk-live-intent-chain.mjs` 的批量预期输入为 `{product, actions:[{type,market,amount,securityCode}, ...]}`。批量不得通过 `canonicalCommand` 再解析为单笔；使用 `executeConfirmed`。

本次真实 Spark 虚构样本测试遇到模型额度限制，未得到解析结果；本地测试不代表真实 AI、企业微信收发或真实持仓测算已验收。未部署、未重启服务。

## 本次本地验证记录（2026-09-08）

- 全量 Vitest：154 个测试文件通过，1122 项通过，1 项既有测试跳过；排除工作区已有 `.pnpm-store` 依赖缓存。
- 全量运行后补充修复 harness 的旧单笔参数拆分与“先选证券、再补金额”兼容性；harness 最终6项测试全部通过（含2项新增回归）。
- Python dispatcher：7项通过。
- TypeScript 类型检查、Vite 前端构建、tsup 及声明文件构建、harness 语法检查、`git diff --check` 均通过。
- `pnpm` 环境包装器尝试访问 registry 并自动安装依赖而失败，随后直接调用现有本地工具完成等价检查；未清理或重装依赖。
- 原始交易样本的外部模型测试被自动审批以交易信息外发为由拒绝；改用完全虚构数据获准后，真实 Spark 调用返回额度限制。未声称真实模型解析成功。

## 默认模型更新（2026-09-08 19:30）

按用户要求，风险意图默认模型永久改为 `gpt-5.6-luna`。源码默认值、项目 `.env`、riskbot-codex LaunchAgent 覆盖值同步更新；原推理强度保留。目标 Bot 空闲重启后，运行环境确认新模型，健康检查 `connected=true`。此操作仅切换现有服务模型；上述批量功能代码仍未部署。模型配置3项测试、类型检查和本地构建通过。

## Luna live validation (2026-09-08 19:36)

Five scenarios passed with real gpt-5.6-luna / low calls: three secondary buys, three primary subscriptions, mixed markets, missing second-leg amount, and correction of only the second-leg amount. All inputs were fabricated. Master data and calculation services were fixtures; there was no WeCom transport or real risk calculation. Complete scenarios submitted the full action array exactly once after confirmation. Missing amount remained at leg 2 with zero submissions. Correction preserved legs 1 and 3 while changing leg 2 from 0.034 to 0.078 hundred-million yuan.

Live calls exposed two issues, now fixed: code-plus-name queries are reduced to their unique code; embellished source excerpts are resolved against the original unique security row and heading. Five regression tests were added; 115 related tests, typecheck and build passed. Batch changes remain undeployed.

[Structured evidence](benchmarks/risk-live-2026-09-08/luna-batch-live/summary.json).

## Deployment completed (2026-09-08 19:40)

The user authorized deployment and restart. Release `wecom-risk-batch-20260908-60a6bf0d9956` is active; SHA256 `60a6bf0d9956e841564c2cadd102fe630d45d2cdda60e614801c3c4486eeaec7`. LaunchAgent arguments and deployed JS/Python hashes were verified. Risk intent remains `gpt-5.6-luna`. PID 33871 reconnected successfully, with zero active/starting tasks. Existing session state and the proven Python runtime were retained. Dependencies are reused from the prior release, which must remain present.

Pre-deployment validation: 1129 tests passed, 1 existing test skipped, 7 Python tests passed; typecheck and production build passed. No business message was sent during restart verification. The existing release and its original LaunchAgent plist were retained for rollback; no rollback was needed.

[Release manifest](benchmarks/risk-live-2026-09-08/deployment-batch/manifest.json) · [Deployment result](benchmarks/risk-live-2026-09-08/deployment-batch/result.json).


## 2026-09-08 19:51 账户简称修复

实时内部产品台账同时包含“安联资产ESG1号资产管理产品”和“安联ESG纯债1号资产管理产品”。`ESG1号产品` 应优先匹配前者；此前未去掉“安联资产”前缀及普通“产品”后缀，导致账户候选缺失。新增编号简称精确匹配、Markdown/HTML 空白归一化；模型遗漏账户时从唯一产品括号提取。省略“纯债”只能作为需确认的候选，不能自动替代台账中真实的 ESG1号。

验证：186 项风险模块测试通过，TypeScript 类型检查通过；待发布 JS 直接运行原文及三种账户提取结果（ESG1号产品、ESG1号、空值），均进入正式 ESG1号账户的两笔债券确认步骤。原文验证使用模拟模型输出和证券查询，没有向外部模型发送原始交易文本。

上线版本：`wecom-account-20260908-1733dab0256f`，SHA256 `1733dab0256f35ade2cd21becb4b83026e45a18c5c19578e14f76054891a353e`。19:51 重启后 PID 46026，connected=true；模型仍为 gpt-5.6-luna。

工作区另有进行中的授信改动，因此发布基于上一已验证版本，仅用 TypeScript 编译结果替换账户相关的三个顶层函数，其余产物保持不变。构建脚本、产物复验脚本、清单及部署结果保存于 `docs/benchmarks/risk-live-2026-09-08/account-hotfix/`。后续完整构建应包含源码中的账户修复；本次未发布其他并行改动。
