# Spark 追加验收（2026-09-08）

> 最新追加：已改用GPT-5.5补齐四类30对真实采样，仍有数据日期异常与展示门禁，详见[GPT-5.5追加验收](risk-gpt55-completion-2026-09-08.md)。

本轮按用户要求将已部署 riskbot@codex 的风险意图模型切回 `gpt-5.3-codex-spark / low`，普通聊天配置未改。发布制品仍为 `40e196ce3872a0a616b195646a6561dbeaad204e5a8be95ed21ebc50e0403fed`，产品源码与中午通过的 1098 项测试制品一致；本轮不重复无关构建。追加采样因Spark额度停止；尚未完成全部上线验收，以下明确列出完成与阻塞项。

## 已完成平台验收

授权会话为“bot 测试”，目标 riskbot@codex。只做模拟测算，不提交交易或变更台账。

| 场景 | 实际观察 |
| --- | --- |
| 证券名称及多候选 | Spark 提取交易，显示多个国债候选；选择国债0115（100115.SZ）后仍需最终交易确认 |
| 连续点击确认 | 对最终确认按钮连续点击两次，仅观察到一次 calculate_pretrade；未观测平台是否交付两次回调，不能用此证明所有重复投递情形 |
| 完整业务状态 | 买入结果为 NO_DATA 1/PASS 6 → NO_DATA 1/PASS 8，保留授信数据缺失提示，未误报完整通过 |
| 仅修改期限 | 7天→14天，金额1000万元与账户/操作保留，再次确认，未调用 AI |
| 复合修改 | Spark 回退后正确为2000万元、21天，再次确认；实际测算 PASS 6→PASS 6 |
| 一级申购证券标识 | 确认卡包含一级市场和100115.SZ，未提前测算 |
| 同进程自然过期 | 16:19:48生成确认，五分钟后点击显示卡片失效；测算次数没有增加 |
| 重启前旧卡 | 旧确认卡回调被拒绝，无重复测算 |
| 终态 | 已完成结果保留，未被迟到进度覆盖 |

实际线上 Spark 输入：证券候选用例2050 token、复合修改2107 token；另一个独立提取探针1484 token，方向与金额正确。不同文本、环境的 token 数单列，不将1484当作所有线上请求的固定值。平台模型日志已确认 Spark，完整提示词不进 Git。

## 失败记录和数据边界

首个候选请求 `list_products` 76.107秒后报台账Pin读取失败，AI及正式测算均未执行。平台正确显示失败。随后沿真实 DirectRiskService 初始化链独立读取两个Pin元数据成功，再次平台请求产品查询4.738秒成功。代理访问502的诊断只能说明一种失败机制；桥接脚本已设 NO_PROXY，缺少首次失败的HTTP底层记录，不能断言线上失败必定由代理导致，也未擅自更改系统代理。

两个规则Pin仍为2784/2783，同一 release `money-rule-alignment-20260902T155318`，后端41个Python文件hash和依赖版本未变化。但当前数据源净资产已由[REDACTED]变为[REDACTED]，日期仍为2026-09-07；与旧基线的前两条采样因此失败，保留于 old-baseline-rejected。

为隔离数据变化，两固定版本各独立执行一次预批准只读测算，当前完整业务结果hash相同，新 baselineMetricsHash 为 `c9cecaf655dd0907f0ba2ea7497f1ca1cf4c28cd6cacb17caf74a1fd937998e7`。随后另起新组并严格检查该hash；不放宽数值容差，不将失败并入新组，不将源数据变化归因于补丁。其余基线字段变化未逐字段取回旧原值，因此不声称仅净资产一个字段发生变化。

## 性能采样

固定比较旧 `f00d635b36536dccac7ebeb73235e7dcf584d49b` 与新优化 `6d28a6a673b3d400f3d30e15018b5a5621d545cf`，不是线上后续上下文补丁。模型均为 Spark / low，独立Codex home、Python桥接路径和状态，依赖相同。目标自然语言、金额修改、期限修改、复合修改各30对，AB/BA交错。正式计算每次执行，逐对核对规范化输入和完整业务结果。

命令和可复现入口为 [Spark采样器](benchmarks/risk-live-2026-09-08/harness/risk-intent-spark-completion.mjs)。私有案例配置保留在验收目录；当前新组输出 `/private/tmp/wecom-live-20260908/spark-completion-current-live`。原始记录包含各次token计数和失败；未观测阶段继续使用null，不能解释为0。数据基线校准不计性能样本。

[平台摘要](benchmarks/risk-live-2026-09-08/spark-completion/platform-summary.json)、[环境核验](benchmarks/risk-live-2026-09-08/spark-completion/environment.json)、[模型探针](benchmarks/risk-live-2026-09-08/spark-completion/model-probe.json)、[旧基线失败](benchmarks/risk-live-2026-09-08/spark-completion/old-baseline-rejected/samples.jsonl)、[新基线校准](benchmarks/risk-live-2026-09-08/spark-completion/current-baseline/calibration.json)。

## 剩余门禁

固定版本充分配对性能因Spark额度停止；Spark 金额边界回归5/5已完成。排队取消、客户端关闭、过期不启动已有本地真实后端验收；运行中的数据库调用仍不能协作中断。无实际推送或合并。

## 追加发现

新基线首组自然语言已完成11个一致配对，第12对旧版因非回购申购被AI额外填入days=0，规范化输入与预期不符，未执行该条正式测算；同对新版通过。保留24条尝试（旧版11/12成功，新版12/12成功），不是30对验收完成。

Spark真实边界5/5通过：负数、零、含糊和中文金额均由实际Router拒绝，缺失金额必须进入freeform/amount，正式服务调用0。平台负数确认亦无新增测算，但先显示“测算完成”再显示通用失败，未明确说明金额无效。这是展示缺陷，不能将安全拒绝视为该交互项完全通过。

### 展示缺陷定位

`router.ts` 的执行前校验返回 `handled:true,intent:risk-error`；`cli.ts` 的确认执行分支将 handled 误作成功，无条件结束流为“测算完成”，随后才发送错误。`formatRiskError` 又把 invalid-amount/invalid-days 统一转成稍后重试，展示层因此容易把输入错误误解为业务风控不通过。未发生实际测算，也未据此修改正在验收的制品。修复应区分输入/服务错误和真实业务结论，并保持原有拒绝与零后端调用规则。

### 失败保留采样策略

新增独立组 `/private/tmp/wecom-live-20260908/spark-collected-live`，仅对执行正式测算前的 normalized-input-mismatch 继续收集，其余网络、额度、基线或业务结果异常仍停止。每场景目标30个完整一致配对、最多40次尝试，所有失败保留。最终性能仅由独立 `summarize-collected-pairs.mjs` 对完整一致配对计算；基础summary的单侧成功耗时不作为配对收益。

## 本轮最终采样结果

失败保留组共23次配对尝试、46条记录；前22对输入及完整业务结果一致，第23对两版本都返回Spark用量上限错误，进程退出1。自然语言每版本成功22/23（95.65%），失败各1；失败未纳入速度统计，但未从成功率分母剔除。

| 场景 | 有效配对N | median旧→新(ms) | nearest-rank P95旧→新(ms) | 绝对减少(ms) | 中位数減幅 |
| --- | ---: | --- | --- | ---: | ---: |
| 自然语言（当前独立组） | 22 | 10991.422→10632.561 | 16176.966→16089.301 | 358.861 | 3.265% |

未达到本组30对目标，未做显著性检验，不能据3.265%认定稳定提速。金额、期限、复合修改在此组未开始，不能记录为0耗时或已通过。之前首组11对保持独立，不与本组22对合并宣称完成30对。自然语言仍调用AI；此表是两个固定历史提交的对比，不是线上精简提示词补丁的性能表。

[全部尝试](benchmarks/risk-live-2026-09-08/spark-completion/collected/samples.jsonl)、[独立配对汇总](benchmarks/risk-live-2026-09-08/spark-completion/collected/paired-summary.json)、[额度阻塞](benchmarks/risk-live-2026-09-08/spark-completion/collected/blocker.json)。额度工具仅返回通用Codex窗口，未提供Spark恢复时间，不从通用窗口推断Spark额度。未消耗重置额度、未自动切换其他模型。

## 上线状态与后续

已部署制品及Spark模型配置保持运行，健康检查connected、无活动任务；“已部署”不等于全项验收通过。尚缺三个修改场景的充分性能配对、自然语言单组30对，以及负数错误展示纠正及回归；首次Pin读取失败也应持续观察。当前不宣布满足全部上线条件。

额度恢复或获得明确重置授权后，以同一模型及固定提交继续单场景采样，先核对数据基线，变化则重新校准并单列新组。不得静默合并不同数据版本，也不清空共享缓存。最小展示修复应独立构建验证后再按已授权范围更新制品。

现行制品、健康检查与原稳定制品回滚见[部署报告](risk-deployment-2026-09-08.md)。Spark配置和恢复到GPT-5.5的plist均已备份在发布目录；完整制品回滚入口为发布目录的`rollback.py`，只操作riskbot-codex单实例，不停止Lark。当前未执行回滚、推送或合并。
