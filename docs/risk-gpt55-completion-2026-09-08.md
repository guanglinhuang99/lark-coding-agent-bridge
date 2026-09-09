# GPT-5.5 追加验收（2026-09-08）

> **真实AI充分性能采样已补齐：四场景各30个完整一致配对。尚不满足全部上线条件**：另有一次持仓日期回退失败未闭环，负数输入错误展示仍待修复。当前机器人已配置GPT-5.5并保持connected；已部署不等于全项验收通过。

用户授权改用 GPT-5.5 继续未完成测试。本轮已将同一 riskbot-codex 实例的风险意图模型改为 `gpt-5.5 / low`，启动时间08:49:13 UTC、PID84775，健康状态connected。制品SHA256仍为`40e196ce3872a0a616b195646a6561dbeaad204e5a8be95ed21ebc50e0403fed`，源码未因模型切换改变；普通聊天配置不变，不启第二实例、不操作Lark、不写业务台账。

## 已完成准备

- 实际GPT-5.5探针成功，方向和金额正确，输入1719、输出93、推理53 token；只是单次探针，不是全场景固定token数。
- 两固定版本分别独立只读测算，当前完整业务结果一致，baselineMetricsHash仍为`c9cecaf655dd0907f0ba2ea7497f1ca1cf4c28cd6cacb17caf74a1fd937998e7`，净资产[REDACTED]、日期2026-09-07。未放宽容差。
- 固定旧版`f00d635b36536dccac7ebeb73235e7dcf584d49b`、新版`6d28a6a673b3d400f3d30e15018b5a5621d545cf`；相同依赖锁文件、解释器、后端和workers4/timeout180000。显式各自桥接脚本与独立state。
- 模型切换前确认空闲、停止同一LaunchAgent并等待旧PID退出后启动；Spark plist备份在发布目录`spark-before-gpt55.plist`。未使用额度重置。

## 采样方法

自然语言、金额修改、期限修改、复合修改各目标30个完整一致配对，AB/BA交错；本组`/private/tmp/wecom-live-20260908/gpt55-collected-live`独立于所有Spark或先前GPT-5.5样本，不混合统计。仅normalized-input-mismatch允许保留失败后继续（每场景最多40次尝试）；网络/额度/数据基线/业务结果异常仍停止。失败计入所有尝试成功率，性能仅计完整一致配对，P95使用nearest-rank。

测试入口`harness/risk-intent-spark-completion.mjs`沿用旧名，新增显式`--model gpt-5.5`并校验私有配置一致；默认Spark旧命令保持有效。私有文本、凭证与完整持仓不入Git。当前历史固定版本性能不是线上最小提示词补丁的性能。

## 已知未通过项

上一轮平台负数输入安全拒绝，但流先显示“测算完成”再显示通用失败，仍是展示缺陷。本轮按测试范围保留制品，不因更换模型宣称问题解决。此前完整CI 151文件1098项、类型检查、构建及Python4项的证据覆盖同一制品，不重复与性能抢占资源。

[模型/部署证据](benchmarks/risk-live-2026-09-08/gpt55-completion/deployment.json)、[模型探针](benchmarks/risk-live-2026-09-08/gpt55-completion/model-probe.json)、[数据核验](benchmarks/risk-live-2026-09-08/gpt55-completion/baseline-verification.json)。

## 首组停止与日期异常

自然语言、金额修改各30/30完整配对通过、零失败。期限修改前12对一致，第13对旧版返回日期2026-08-22、净资产[REDACTED]，新版仍为2026-09-07、[REDACTED]；两侧规范化输入hash完全相同。日期检查因此停止采样（退出1）。此组期限旧版12/13成功，新版13/13成功；不得删除失败或解释成模型输入差异。

之后两版本以相同期限修改预期输入各做3次独立只读直调，全部返回09-07且严格基线/业务hash一致。此复核不计性能，不能证明间歇问题已消失。后端日期选择原因继续定位。期限另起`gpt55-tenor-live`新组目标30对，原组不混入，复合修改随后另起gpt55-compound-live完成30对，见最终结果。

[首组全部记录](benchmarks/risk-live-2026-09-08/gpt55-completion/first-run/samples.jsonl)、[首组独立汇总](benchmarks/risk-live-2026-09-08/gpt55-completion/first-run/paired-summary.json)、[日期复核](benchmarks/risk-live-2026-09-08/gpt55-completion/date-probe.json)。

### 日期异常代码边界

只读定位：固定两版`calculatePretrade`及`direct_bridge.py`均未向后端传date。后端`linked_sources/portfolio_limits/portfolio_limits_web.py:start_pretrade_run`在worker内调用`latest_holding_date_for_product`，再将日期传入测算。`check_portfolio_limits.py`的该函数查询PQ `IDB_VIEW_HOLDING` 的 `MAX(REF_DATE)`，本函数无日期缓存/fallback；持仓缓存键包含日期。因此“相同输入”不等于已固定同一数据快照。此次偶发旧日期可能涉及PQ可见性/连接路由或产品匹配，但缺少当次SQL及解析日志，不能宣称已确定根因。

下一步应在后端获得授权后记录脱敏run标识、请求/解析产品hash、选定日期、持仓行数和金额汇总以及连接路由摘要，或对相同产品重复只读MAX日期探测。正式固定历史日期需改变当前调用契约，本轮不修改固定比较源码来掩盖该缺口。线上风控数据新鲜度风险独立保留，不因随后采样成功而关闭。

## 最终性能与失败统计

以下四个选定场景各30个完整一致配对，两版本各30/30成功；相同配对的规范化输入和完整业务结果hash一致。所有正式calculate_pretrade均实际调用一次。首组期限失败及其中12个成功配对另列，不混入期限新组。时间单位ms，P95按nearest-rank；减幅=1−新版median/旧版median，负数表示变慢。

| 场景 | 每版N/成功率 | median旧→新 | P95旧→新 | 绝对减少 | 中位数减幅 | AI总次数旧→新 |
| --- | --- | --- | --- | ---: | ---: | --- |
| 自然语言 | 30 / 100% | 12878.853→13805.634 | 22609.718→24771.163 | -926.781 | -7.196% | 30→30 |
| 仅修改金额 | 30 / 100% | 36209.198→9895.358 | 45134.242→23274.200 | 26313.840 | 72.672% | 60→0 |
| 仅修改期限（独立新组） | 30 / 100% | 21494.836→2602.737 | 30850.552→7579.242 | 18892.099 | 87.891% | 60→0 |
| 复合修改 | 30 / 100% | 38306.558→22390.396 | 117512.309→59661.457 | 15916.163 | 41.549% | 60→30 |

本轮性能采样总计133次配对尝试、266条样本：旧版132/133成功（99.248%），新版133/133成功；1条失败为旧版data-date-changed，不是模型解析失败或超时。选定性能表为120对；另12个一致配对与1个失败配对都保留在首组期限记录。校准/日期复核/模型探针不计入这266条，也不与既有CI数量相加。不能只看到选定表100%而忽略全量失败。

首组期限为旧版12/13（92.308%）、新版13/13（100%）；与期限新组分开统计，未因重试而将异常“转为通过”。本轮未触发额度错误，未使用重置额度。

### 阶段与瓶颈

- 自然语言仍各30次AI调用，AI阶段median约9.86→10.90秒，正式测算约2.61→2.59秒。因此该组没有显示延迟收益，整体反而慢7.20%；未做显著性检验，不能宣称稳定退化或稳定提速。
- 金额/期限单字段修改的AI总次数均60→0；金额场景证券查询调用90→15，复合修改证券查询90→26。这里是客户端后端方法调用次数，不等于SQL执行次数。对应正式计算均30→30，未缓存风控结论。
- 复合修改仍保留AI回退，60→30次；正式计算median约8.65→8.64秒，而整体P95旧版117.51秒、新版59.66秒，尾部波动明显。慢样本后端阶段曾出现scenario_resolution约11.5秒、credit_checks约34.7秒、limit_calculation约0.074秒，说明等待数据/查询也构成瓶颈，不能将所有耗时归因于模型。
- preparation包含部分AI/查询时间，与AI阶段重叠，不能把阶段median相加得到总时间。startup仅在各组首次样本观测；独立证券候选、排队、平台展示时间未观测，保留null。后端timings的单位为秒，客户端阶段与totalMs为毫秒。此采样未发送平台消息，未计人工确认等待；本地确认链路检查不等同真实平台传输耗时。

[完整场景汇总与阶段](benchmarks/risk-live-2026-09-08/gpt55-completion/selected-scenarios.json)、[期限新组](benchmarks/risk-live-2026-09-08/gpt55-completion/tenor/paired-summary.json)、[复合修改](benchmarks/risk-live-2026-09-08/gpt55-completion/compound/paired-summary.json)。各目录保留samples.jsonl、pairs.jsonl及summary.json。原始同组单侧成功汇总不代替完整一致配对汇总。

## 最终验证及上线门禁

本轮只改测试工具/报告与实际风险意图模型配置，未改产品源码。最终9项源码/测试文件指纹与已通过CI的发布清单一致，制品SHA256不变；后端41个Python文件聚合hash仍为9f0134f81a256e1ca2a5c4576974fcf93317f211634d0008cad964d6f84d245c。测试工具syntax、失败收集自检、git diff --check通过。健康connected、activeRuns/startingRuns均0，GPT-5.5配置已持久化。未重复无变更完整CI，未推送、合并或改共享dist/.env。[最终核验](benchmarks/risk-live-2026-09-08/gpt55-completion/final-verification.json)。

已完成门禁包括原完整CI（151文件1098项）、Python4项、普通真实查询/并发、正式计算业务一致性、本地真实生命周期与现有平台冒烟/候选/过期/终态证据；本轮补齐GPT-5.5四类充分配对性能。GPT-5.5此前精简指令8场景与边界回归仍为独立功能证据，不与固定历史提交性能混淆。Spark平台连续点击只证明观察到一次测算，不能扩大为所有平台重复投递已验证；运行中数据库执行依旧不能协作中断。

**不宣告全项上线验收通过**：

1. 日期回退的数据新鲜度异常需取得当次后端/PQ诊断证据并关闭；不能只靠重跑成功。
2. 负数确认先报“测算完成”再报通用失败的展示缺陷仍待修复与回归。实际风险执行已拒绝，不能把安全拒绝等同交互通过。
3. 先前一次Pin读取失败已重试恢复，但根因未确定；平台重复投递覆盖边界继续保留。

部署/回滚沿用[已授权部署记录](risk-deployment-2026-09-08.md)：当前发布目录`/Users/guanglin/.lark-channel/releases/wecom-risk-20260908-40e196ce3872`；上一稳定制品hash为434ec142377872e864c5298d9082cd5f2ce5015e13bb121548afa9f6c5f073a8，稳定源码提交未确认，不冒称为固定性能旧版提交。后续修复须隔离构建、完成CI与相关真实回归、备份当前plist/制品，空闲后仅切换同一Bot实例，并核查连接、确认、实际测算和终态。

需整体回滚时执行发布目录`rollback.py`，它等待旧PID退出、恢复original.plist并启动单实例；再检查health、日志和授权会话。模型配置的上一Spark plist另存`spark-before-gpt55.plist`，它与整体制品回滚不是同一操作。本轮未执行任何回滚，未停止Lark。

[独立复算证据](benchmarks/risk-live-2026-09-08/gpt55-completion/independent-validation.json)核对固定提交、AB/BA时间顺序、逐对输入/结果hash、每条一次正式测算和全部性能统计，结果一致。
