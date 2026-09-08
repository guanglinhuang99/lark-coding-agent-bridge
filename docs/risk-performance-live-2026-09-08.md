# 真实风险性能验收（2026-09-08）

> 最新追加：已改用GPT-5.5补齐四类30对真实采样，仍有数据日期异常与展示门禁，详见[GPT-5.5追加验收](risk-gpt55-completion-2026-09-08.md)。

> 本轮后续：模型已切回Spark，新增平台与边界验收、真实采样及额度阻塞见 [Spark追加验收](risk-spark-completion-2026-09-08.md)。

> 后续部署状态（2026-09-08）：已获授权并部署，详见 [部署记录](risk-deployment-2026-09-08.md)。本文“未部署”等表述保留其验收时点含义。

## 当前结论

**尚未达到上线条件。** 完整CI、真实查询配对、标准纯计算30对、8项交易功能配对、13项新版严格本地链路及强化生命周期检查均已完成。业务结果和规范化输入核对通过，正式测算每次实际调用。证券同查询8并发中位数19.19→2.61秒；不同证券8并发19.04→18.11秒；正式纯计算2.535→2.532秒，没有明显提速。不能用模拟比例或历史5.601秒推算本轮收益。

剩余门禁为真实AI正常场景的充分配对性能，以及新版在企业微信的真实确认/去重/进度终态。真实AI基本功能已覆盖；金额无效草稿进入确认的既有交互缺口另列，新版执行入口拒绝补验已通过。`riskbot@codex` 在“bot 测试”的旧构建 `/status` 基线已通过，收发授权已取得；新版临时单实例切换已准备，仍待明确重启授权。此前业务文本发送自动审批被拒绝；用户现已明确授权具体产品和模拟交易文本，真实AI采样已因Spark用量限额停止，失败保留；尚未更换模型或消耗重置额度。进度受控测试仅为source-contract，不能替代平台证据。

## 固定版本与环境

- 旧版：`f00d635b36536dccac7ebeb73235e7dcf584d49b`。
- 新版：`6d28a6a673b3d400f3d30e15018b5a5621d545cf`。
- 主工作区 HEAD：`79f7a75faf54220f4f7b6d72064974c812b176e0`，为后续交接文档提交，不参与性能对比。
- 独立 checkout：`/private/tmp/wecom-live-20260908/before`、`after`；主工作区未切换、重置、构建。原未跟踪 `AGENTS.md`、`.pnpm-store/` 保留。
- Node `24.19.0`、隔离 pnpm `10.33.0`；两个 checkout 均 frozen-lockfile 安装。锁文件 SHA256：`d4a95a8cc6c212d170b095dd021e409da85e6667de783f0cd90cdf68466f5008`。
- 风险 Python：`/Users/guanglin/Documents/trae_projects/icube/bin/python`，`3.12.8`；实际导入 azpy、pandas、pins、openpyxl 成功。dispatcher 验证用系统 Python `3.9.6`。Python包版本：azpy 1.9.0、pandas 3.0.2、pins 0.9.1、openpyxl 3.1.5。
- 后端：`/Users/guanglin/Sync/risk-service`，无 Git 元数据，不能提供虚构提交。41个 Python 文件按相对路径及内容聚合 SHA256：`9f0134f81a256e1ca2a5c4576974fcf93317f211634d0008cad964d6f84d245c`（排除 `.connect-package`）。这不是完整数据库快照指纹。
- workers `4`，客户端 timeout `180000ms`、startup timeout `30000ms`；两版本显式使用各自 direct_bridge.py，状态写入验收目录。平台基线使用已授权 `riskbot@codex` 测试，不重启机器人、不启第二实例；候选切换清单标记为 prepared-not-executed。
- 正式 Pin：scope `2784`、limit `2783`，release `money-rule-alignment-20260902T155318`；251产品、1373限制行。测算样本观察到2026-09-07及固定基线哈希/净资产，但bridge不能强制日期，市场数据快照仍未固定。

## 项目验证

按 package.json `ci:platform` 执行完整测试、类型检查、构建。受限环境首次运行：148文件通过、1文件失败、1跳过；1076测试通过、12失败、1跳过。失败根因为UI测试监听127.0.0.1受到EPERM限制，清理钩子随后出现handle未定义。

允许本地监听后，重新按顺序执行：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm run ci:platform` | 0 | 149文件、1088测试通过，1个受控benchmark跳过；类型检查、构建通过 |
| `python3 -B tests/python/test_risk_dispatcher.py` | 0 | 4项通过；日志中的排队过期TimeoutError是测试覆盖路径 |
| `git diff --check` | 0 | 通过 |

1088包含WeCom、性能及交互单测，不与上一轮282或38累加。单测使用替身的部分不构成真实数据库/AI/平台验收。

安装曾遇到离线缓存缺包、沙箱代理EPERM及网络ECONNRESET，最终使用隔离store成功完成锁文件安装。未改变全局pnpm。

日志在 `/private/tmp/wecom-live-20260908/ci-platform-network.log`、`python-tests.log`；退出码及构建产物SHA256见 [environment.json](benchmarks/risk-live-2026-09-08/environment.json)。构建产物仍在隔离 after/dist，未部署。

## 连通性证据边界

两个真实bridge启动均返回ready。受限网络下list_products报Pin不存在，但允许只读联网后两版均返回251产品，因此不能据初始错误认定正式Pin缺失。联网探针每版本仅1次，约8.76/8.73秒，包含启动和读取；不是配对性能样本，不计算优化收益。启动预检也仅1次，不宣称冷启动改善。

原始脱敏证据见 [startup-preflight.json](benchmarks/risk-live-2026-09-08/startup-preflight.json)、[query-network-probe.json](benchmarks/risk-live-2026-09-08/query-network-probe.json)、[data-versions.json](benchmarks/risk-live-2026-09-08/data-versions.json)。未保存产品清单、持仓或凭证。

## 真实产品查询结果

每场景AB/BA交错，各版本结果SHA256逐对完全相等，零失败。以下是实际风险客户端和真实Python/Pins，不含AI/平台网络。P95用nearest-rank，时间单位ms。

| 场景 | 每版N | 成功率旧/新 | median旧→新 | P95旧→新 | 绝对减少 | 中位数减幅 |
| --- | ---: | --- | --- | --- | ---: | ---: |
| 独立进程首次产品查询 | 3 | 100% / 100% | 8814.045 → 8828.784 | 8988.921 → 10718.483 | -14.739 | -0.17% |
| 同客户端重复产品查询 | 30 | 100% / 100% | 0.298 → 0.059 | 0.442 → 0.093 | 0.239 | 80.26% |
| 8并发同产品查询，应用缓存miss | 30 | 100% / 100% | 1.411 → 0.566 | 1.737 → 0.854 | 0.845 | 59.89% |

首次进程只有3对，数据库/服务器缓存未清除，不称为数据库冷启动。重复查询的累计客户端后端请求30→0；8并发累计240→30（每批8→1）。这里后端请求指client.call调用次数，不等于SQL或数据库实际执行次数。并发时间为整批8请求完成时间，不是单条P95。暖机1对单独保存、不计入正常场景。

结果表明应用缓存/合并对这一查询的绝对收益不足1ms；首次请求仍约8.8秒，3对样本没有显示改善。startup阶段单独观测，导入/数据库初始化/Pins获取无法进一步分离。不可据此推算交易测算收益。

[原始样本](benchmarks/risk-live-2026-09-08/products/samples.jsonl)、[配对一致性](benchmarks/risk-live-2026-09-08/products/pairs.jsonl)、[汇总](benchmarks/risk-live-2026-09-08/products/summary.json)。

## 真实证券候选与不同产品并发结果

已完成的各场景每版本30个有效配对样本，已完成样本成功率均100%，逐对完整结果哈希一致；8个不同证券场景另列于下文。证券行情/主数据没有可用快照版本，记为未固定；仅能证明采样时返回结果相同，不能证明数据源被冻结。正式Pin版本在记录中另列。

| 场景 | median旧→新（ms） | nearest-rank P95旧→新（ms） | 绝对减少（ms） | 中位数减幅 | 后端请求总数旧→新 |
| --- | --- | --- | ---: | ---: | --- |
| 同客户端重复证券候选 | 2614.567 → 0.100 | 3060.469 → 2804.636 | 2614.467 | 99.996% | 30 → 3 |
| 8并发同证券候选，应用缓存miss | 19194.309 → 2611.825 | 21435.846 → 3134.394 | 16582.485 | 86.393% | 240 → 30 |
| 8并发不同产品限制查询 | 47.002 → 46.991 | 55.499 → 48.729 | 0.011 | 0.023% | 240 → 240 |

重复证券查询的新版30次中仍有3次真实后端请求（初次/缓存过期等miss），所以median接近0.1ms，但P95仍约2.8秒；不能宣称所有重复请求都接近零耗时。同证券并发的中位数约19.19→2.61秒，下降86.39%，是本轮真实候选查询证据，不是正式测算收益。不同产品限制查询维持每批8次后端调用，中位数约47ms，未显示有意义的速度改善；这验证的是不同产品限制查询，不能替代8个不同证券候选的同类负载对照。

初始额外混合证券场景配置包含重复代码，实际只有7个不同查询，不能充当8不同查询验收。完成30对有效同证券并发样本后，受控停止该采样器（退出143），未把取消场景当成功或普通业务失败。停止瞬间可能已有一批额外请求提交，完成情况未观测，单列取消记录；两个由验收器创建的Python子进程均已核实退出。随后单独完成上述不同产品查询。没有停止任何Bot服务。修正后的8个不同证券查询已另行完成30对采样，全部结果一致，见下文独立汇总。

证券采样中的产品暖机/重复/并发是单独的重复运行，原始记录保留，主产品表只引用第一次products目录结果，不跨运行混合取样。所有采样均在CI结束后进行，未与测试/构建同时运行。

[证券原始样本](benchmarks/risk-live-2026-09-08/securities/samples.jsonl)、[证券汇总及取消项](benchmarks/risk-live-2026-09-08/securities/summary.json)、[受控停止记录](benchmarks/risk-live-2026-09-08/securities/controlled-stop.json)、[不同产品原始样本](benchmarks/risk-live-2026-09-08/distinct-products/samples.jsonl)、[不同产品汇总](benchmarks/risk-live-2026-09-08/distinct-products/summary.json)。

## 8个不同证券并发补充验收

30对AB/BA批次全部成功，逐对完整结果哈希一致；每版本240次真实候选请求，未合并不同查询。整批8请求的median为19041.173→18109.145ms，nearest-rank P95为20164.017→19862.365ms，绝对减少932.029ms，中位数减幅4.895%。按240请求除以该版本各批耗时总和计算的批处理吞吐为0.433→0.441请求/秒（不包含两版本之间的切换间隔）。未作显著性检验，不把这组小幅变化解释为不同查询获得了缓存/合并收益。

[原始样本](benchmarks/risk-live-2026-09-08/distinct-securities-live/samples.jsonl)、[汇总](benchmarks/risk-live-2026-09-08/distinct-securities-live/summary.json)、[独立重算](benchmarks/risk-live-2026-09-08/evidence-validation-additional.json)。后者同时重算了标准纯计算和8项交易功能矩阵，该次重算136条新增配对样本；最终加入首次纯测算后共142条，见[最终独立校验](benchmarks/risk-live-2026-09-08/evidence-validation-final.json)。

## 真实标准纯计算与交易功能结果

标准纯计算场景完成30个AB/BA配对；before、after均为30/30成功，结果哈希和输入哈希逐对一致，`calculate_pretrade` 每样本调用1次。中位数由2535.469ms降至2532.235ms，绝对减少3.234ms，减幅0.128%；nearest-rank P95由2957.830ms降至2672.658ms。样本的业务日期均为2026-09-07，基线哈希为`991dd6721c16b381316ee84d8229329ff89cdeed6110d980ba7a92c37d58a684`，净资产为[REDACTED]；bridge不能向后端传入日期参数，因此这是采样时返回的同一日期/基线观察，不是可强制重放的历史快照。

标准场景记录`aiCalls=0`、`confirmationChecks=[]`、`humanWaitMs=null`，且AI、准备、证券候选、排队、展示阶段未观测。它验证的是固定输入直接执行的真实风险测算，不是自然语言意图解析或企业微信用户确认。

交易功能矩阵另有8个用例（`calculation_case_0`至`calculation_case_7`），每个完成1个AB/BA配对；8/8用例两版本各1/1成功，`businessConsistent=true`，逐对业务结果哈希一致，且每次只观察到1次正式测算调用。用例依次为申购金额变更、赎回、7天正回购、14天正回购、7天逆回购、买入、卖出、带证券标识的一级申购。每项仅1对，作为业务一致性功能证据，不据此计算性能收益。它们同样是预批准本地状态测算，所有样本`aiCalls=0`且`confirmationChecks=[]`，不能解释为8项真实用户交易确认或AI链路通过。

上述两组测算已归档脱敏[标准测算汇总](benchmarks/risk-live-2026-09-08/calculation-standard-live/summary.json)和[功能矩阵汇总](benchmarks/risk-live-2026-09-08/calculation-matrix-live/summary.json)，各目录同时含样本及配对记录；私有state和用例留在隔离目录。

独立进程首次纯测算另完成3对，旧新版各3/3成功、业务结果一致，median为17355.856→17619.146ms，P95为17565.795→18182.844ms，绝对减少-263.290ms，中位数减幅-1.517%。每次独立Python/state，但没有清空数据库/共享服务缓存；样本仅3对，未显示首次耗时改善。Python启动阶段单独记录；导入、数据库初始化与远端读取未完全拆分，无法观测项为null。见[首次纯测算原始记录](benchmarks/risk-live-2026-09-08/calculation-cold-live/samples.jsonl)及[汇总](benchmarks/risk-live-2026-09-08/calculation-cold-live/summary.json)。

## 生命周期、平台与候选切换状态

初次生命周期工具5/5场景通过，其中fast-serial为真实bridge健康方法，queue、timeout-running-slot、client-close为真实backend路径，progress-contract为源契约；初次汇总为`status=pass`、0 blocked、0 failed。queue和timeout结果证明排队取消、超时后迟到结果抑制及运行槽位保持到后端返回；bridge没有协作中断数据库执行的接口，不能据此声称中断了SQL。随后已完成强化复验 lifecycle-live-4：原始stdout tee、close前存活、close后退出、pending清空及新客户端恢复断言均通过。真实后端queue/timeout/close三个场景通过；不等同于平台传输验收。`progress-contract` 的3项断言通过，但证据类型是`source-contract`，使用受控发送器，不是真实后端进度或企业微信传输。

脱敏证据已归档：[初次生命周期](benchmarks/risk-live-2026-09-08/lifecycle-live-2/summary.json)、[平台基线](benchmarks/risk-live-2026-09-08/platform-baseline.json)、[候选切换清单](benchmarks/risk-live-2026-09-08/platform-switch-manifest.json)。原始私有状态保留在验收目录。

已获授权的 `riskbot@codex` 在 `bot 测试` 群发送 `/status`，观察到 `READY; read-only; queue 0; status card rendered`，结果为PASS；该基线明确标注为既有旧版前端构建，不能当作新版候选的E2E证据。没有重启机器人，也没有启动第二实例。新版候选制品/服务切换清单为`prepared-not-executed`，候选提交为`6d28a6a673b3d400f3d30e15018b5a5621d545cf`，群消息收发授权已取得；候选版平台验收依赖另行授权的临时服务切换。

真实AI预检记录模型为`gpt-5.3-codex-spark`，两隔离Codex home的配置哈希及认证状态一致；此前向具体业务数据发送AI请求的自动审批被拒绝；用户随后明确授权，现已完成真实AI标准交易确认预检，旧版AI调用1次、新版0次，输入与确认结果一致。实测会话记录确认两版本均为 gpt-5.3-codex-spark / low。后续功能及性能矩阵正在执行，预检不代替完整验收。

候选版严格无AI链路13/13通过：6例实际确认与测算（首次/重复申购、买入、金额修改、期限修改、一级申购），7例负数、零、含糊金额、名称/代码混用、自然语言及复合修改被要求AI回退且没有启动测算。AI adapter在此模式创建前被禁用，因此“回退要求正确”不证明真实AI输出正确。实际卡片/任务注册表核对会话错配、无效选项、重复确认、过期确认；两次单字段修改另核对旧确认失效，并重新确认后测算。每次规范化输入、实际测算输入、日期及baseline metrics严格核对。首次与重复申购业务结果哈希相同，正式测算各调用1次且后端运行ID不同；产品查询1→0。该证据属于真实本地链路，不是平台用户点击。见[严格链原始记录](benchmarks/risk-live-2026-09-08/strict-chain-live-1/samples.jsonl)及[汇总](benchmarks/risk-live-2026-09-08/strict-chain-live-1/summary.json)。

## 完整矩阵状态

| 项目 | 当前证据 |
| --- | --- |
| 产品首次、重复、8同查询 | 真实客户端完成；首次3对，其他30对 |
| 证券重复、8同查询 | 真实客户端各30对完成 |
| 8不同产品限制查询 | 真实客户端30对完成，8→8调用 |
| 8不同证券候选查询 | 30对完成，240→240调用，零失败且结果一致 |
| 标准纯计算与交易功能测算 | 重复30对、独立进程首次3对、8项功能各1对完成；结果一致，不含AI意图和平台确认 |
| 自然语言、单字段/复合修改、证券歧义 | 单字段修改本地真实确认/测算通过；复合/歧义要求回退且不测算；真实AI输出与候选选择待验收 |
| 负数/含糊金额、一级申购、确认去重、过期、迟到进度 | 前四类及过期已由13项本地链路覆盖；迟到进度仅source-contract，平台未验收 |
| 真实超时、排队取消、客户端关闭 | after 固定bridge初次5/5通过；client-close强化stdout/退出时序复验通过；进度项仅source-contract，不等于真实平台进度 |
| 企业微信平台收发 | 已授权 `riskbot@codex` 测试 `/status` 通过，但为既有旧版前端构建；新版候选切换待授权、未执行 |

## 交易与交互验收限制

本轮标准纯计算及8项功能矩阵使用固定的本地预批准输入；真实测算返回的业务日期为2026-09-07，标准基线哈希为`991dd6721c16b381316ee84d8229329ff89cdeed6110d980ba7a92c37d58a684`，净资产为[REDACTED]。后端`start_pretrade_run`虽支持date，但两个固定bridge的`_calculate_pretrade`均仅传product/actions，不传date，因此现有客户端不能直接强制同一历史日期；后续若数据日期、净值或持仓变化，不能把差异全部归因于补丁。

标准纯计算30对及8项预批准本地测算已完成并逐对核验业务结果一致；记录显示无AI意图调用、无用户确认检查，故不覆盖自然语言AI、交互式金额/期限修改、复合修改、候选选择、负数/含糊金额或重复确认；一级申购仅覆盖规范化输入直调结果，不覆盖原话识别和用户确认。AI模型与隔离配置预检已完成，业务数据发送授权现已取得，真实AI链路正在按场景验收。此外13项新版严格本地链路已补充上述确定性输入、修改、拒绝直接执行和确认注册表证据，正式测算各实际调用1次；仍需真实AI输出及平台回调确认。

运行中后端调用没有协作取消能力：取消排队任务或抑制迟到输出，不等于中断数据库执行。after固定bridge初次真实生命周期5/5通过，但client-close强化stdout/退出时序复验通过；progress仅source-contract，候选版企业微信平台验收仍依赖临时切换授权，真实 AI 业务文本发送已获授权。

## 可复现工具与覆盖边界

- [查询采样入口](benchmarks/risk-live-2026-09-08/harness/risk-live-benchmark.mjs)、[使用说明](benchmarks/risk-live-2026-09-08/harness/risk-live-benchmark.md)、[真实AI本地链路模块](benchmarks/risk-live-2026-09-08/harness/risk-live-intent-chain.mjs)、[空白用例模板](benchmarks/risk-live-2026-09-08/harness/risk-live-benchmark.example.json)。
- 默认真实客户端查询；可选证券候选查询。AB/BA交错、逐对完整结果哈希核对、失败停止并保留记录，输出脱敏JSONL。
- 可选AI链路复用固定版本的CodexAdapter/RunExecutor/原prompt与parser，需已核实模型、隔离Codex home和私有用例。没有伪造AI草稿的默认路径。本轮两个固定版本的AI配置/认证预检一致，真实AI已在新增授权后运行；预检、纯测算和AI交互证据分别报告。
- 标准纯计算和8项功能矩阵使用预批准状态完成真实本地测算；该批准只控制本地测算，未模拟真实用户卡片确认、去重或候选版平台交互。生命周期的`progress-contract`仍是source-contract，不替代真实后端进度或企业微信证据。
- 原始提示词、候选明文及完整持仓不进入Git；AI原始状态必须留在隔离验收目录。

查询与证券证据中的432条已完成样本（含单列暖机和重复运行）符合AB/BA顺序，配对结果哈希一致，median和nearest-rank P95已独立重算；标准纯计算60条样本及8项功能矩阵16条样本另有独立汇总，不能与查询样本混为同一场景。额外取消场景单列、不计作成功。采样前后两个Pin版本及后端Python源码指纹一致；这不代表持仓/NAV/行情快照已固定。见 [证据校验](benchmarks/risk-live-2026-09-08/evidence-validation.json)、[结束Pin版本](benchmarks/risk-live-2026-09-08/data-versions-end.json)、[结束运行环境](benchmarks/risk-live-2026-09-08/runtime-end.json)。

## 剩余瓶颈的当前证据

产品首次获取约8.8秒，而暖产品获取小于1毫秒，提示初始化/首次远端读取仍是重要成本，不能由现有分段观测定位到具体数据库步骤。证券入口`portfolio_limits_web.py:350`调用`pretrade_scenario.security_suggestions`，没有传入其可选suggestions_cache；该函数`pretrade_scenario.py:198`进入真实run_db_read。因此应用层命中/在途合并可以减少真实候选查询请求。`check_portfolio_limits.py:480`的run_db_read还有并发信号量和重试路径，但本轮未分离信号量等待、远端路由与SQL时间，不据总时间断言某一层占比。

标准纯计算30对的真实`backendTimings`中位数显示，`end_to_end`为旧版2.5035秒、新版2.4935秒；其中`setup`为2.381→2.3685秒，`rules_and_holdings`为0.066→0.066秒，`limit_calculation`为0.051→0.052秒。`linked_sources/portfolio_limits/portfolio_limits_web.py:222-258`显示setup包含`resolve_pretrade_product_name`和`checker.latest_holding_date_for_product('pqread', product)`，之后才进入`run_pretrade_measurement`。当前观测未拆分这两个函数，因此只能说setup是稳定测算中占主导的已观测阶段，不能把它全部归因于SQL或某个单独后端步骤。

后续若要改进：先给后端查询、并发等待和远端数据库读分别增加可脱敏观测，再确定是否优化证券详情复用或日期/快照缓存。任何缓存都要明确数据版本和新鲜度失效策略；本轮未改这些产品实现。

## 待审批上线与回滚方案

已只读核实持久服务定义：`~/Library/LaunchAgents/ai.wecom-channel-bridge.riskbot-codex.plist`，label `ai.wecom-channel-bridge.riskbot-codex`，工作目录为本仓库，入口 `bin/wecom-channel-bridge.mjs`，Node `/opt/homebrew/Cellar/node@24/24.19.0/bin/node`，env文件引用本仓库`.env`。未读取/展示凭证，未变更服务；plist存在不证明当前运行进程使用了这份定义。


1. 8个不同证券的30对采样已完成；继续补齐AI具体业务数据、候选版平台收发及其余真实交互矩阵，核对数值、阈值、状态及输入；确认所有失败和收益不足场景后再决定上线。AI业务数据发送已获授权，候选版服务切换仍待授权。
2. 上线候选固定为6d28a6a及本报告校验的隔离构建产物；旧版f00d635是对比/回滚候选，**尚未核实它就是当前生产稳定版本**。审批前读取当前WeCom服务定义、实际运行路径和版本，保留该版本完整制品及原服务定义。
3. 经批准的维护窗口内，等待活动任务结束，仅停止目标WeCom实例；把经验证制品放入独立持久发布目录，复用原env引用和stateDir，确认bridge/Python/service绝对路径。保留Lark服务。不得在原Bot仍在线时启动第二实例。
4. 获得候选版切换授权后，用核实后的原WeCom服务管理方式恢复单实例；检查PID唯一、启动日志、Python ready、产品读取、测试会话确认及一次测算、超时和迟到输出。`node bin/lark-channel-bridge.mjs status --all --profile <已核实profile>`可只读查看两平台状态；不能把旧版基线的`/status`结果当作候选版通过，也不能把start --all当作升级命令。
5. 出现健康检查失败、确认/去重/新鲜度回归或错误率不可接受时，仅停新WeCom实例，恢复事先保存的稳定制品和服务定义，再按原方式启动一个实例并重复健康检查。状态兼容性应在上线前验证，不覆盖或回退业务台账。

当前没有推送、合并、部署或机器人重启；仅在已授权测试群发送了旧构建的 /status。已核实服务 label 和实际入口，原制品及 plist 已备份；原提交未知，不以固定对比旧提交冒充当前稳定版本。

审批通过且稳定制品/目标plist备份已验证后，目标服务的启停命令如下（**本轮未执行**）：

```sh
# 仅停止目标WeCom实例；先确认没有活动任务。
launchctl bootout "gui/$(id -u)/ai.wecom-channel-bridge.riskbot-codex"
# 在此按已审批方案切换持久制品和目标plist；保留原env/state引用。
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.wecom-channel-bridge.riskbot-codex.plist"
launchctl print "gui/$(id -u)/ai.wecom-channel-bridge.riskbot-codex"
```

回滚使用同一组目标服务启停命令，中间恢复备份的稳定制品/原plist。当前生产稳定制品尚未核实，故现在不具备安全执行中间“切换/恢复”步骤的完整参数；禁止以对比旧提交代替已确认的生产备份。

生命周期工具错误保留：[lifecycle-live-1](benchmarks/risk-live-2026-09-08/lifecycle-live-1/summary.json)为类初始化顺序错误，未执行业务检查；[lifecycle-live-3](benchmarks/risk-live-2026-09-08/lifecycle-live-3/failure.json)为过短观察watchdog和延迟挂接Promise拒绝处理。两者均属验收器问题，已修正；不能计为业务成功或隐去失败历史。最终强化证据见[lifecycle-live-4](benchmarks/risk-live-2026-09-08/lifecycle-live-4/summary.json)。

无AI阶段结束时复核：正式Pin版本及后端41个Python文件指纹未变化，见[data-versions-final.json](benchmarks/risk-live-2026-09-08/data-versions-final.json)及[runtime-final.json](benchmarks/risk-live-2026-09-08/runtime-final.json)。新增142条配对记录已独立重算；严格本地链13条另核对，不能与性能配对或CI测试数混算。最终harness语法及隔离after的diff检查均为0，未修改产品源码，因此未重复已通过的完整CI。原机器人PID仍为55401，无本轮验收Python子进程遗留，见[process-final.json](benchmarks/risk-live-2026-09-08/process-final.json)。所有制品、私有状态及凭证留在隔离目录；Git内仅新增待审阅文档与脱敏证据，未提交。

## 真实AI追加验收（Spark额度阻塞剩余采样）

用户已明确授权使用具体产品和模拟交易文本。只向模型发送解析所需文本，不发送持仓、净值、凭证或完整台账。首次自然语言用例使用中文数字“一千万元”，两版AI均原样返回中文amount_text，而金额解析器不支持此格式；两版均被验收器在正式测算前以normalized-input-mismatch拦截。此失败保留为既有兼容性缺口，不称优化回归，也未修改期望数值使其通过。另建“1000万元”用例继续正常功能矩阵，不混合统计。

真实AI功能追加结果：阿拉伯金额自然语言、金额/期限修改、复合修改、证券名称、名称/代码混写后的明确代码澄清、9候选中的明确选项选择，以及中文金额改成阿拉伯金额后重新确认，均已完成旧新版配对且输入/业务结果一致（功能用例各1对，不据此计算提速）。金额与期限修改AI次数旧2→新0，复合修改旧2→新1。初次名称/代码混写未提供澄清步骤，停在证券选择而被harness记为unresolved-confirmation；补充步骤作为独立用例保留，原失败不删除。

一级申购存在经确认的旧版缺陷：真实AI及首次确认得到完整证券标识，但旧Router.runCalculation的subscription分支不传security_name；输入拦截器观察到缺失securityCode，拒绝调用后端。新版executeConfirmed保留证券标识并真实测算通过。这是修复行为差异，不能强求无效旧输入与新版结果一致；不得用直调客户端的一级申购通过结果掩盖旧路由问题。精确证据见[最后功能矩阵](benchmarks/risk-live-2026-09-08/ai-final-functional-live/samples.jsonl)，旧版errorCategory为calculation-input-mismatch且missingInputFields为securityCode。

真实AI冷进程标准交易已完成3对：中位数26093.49→17685.17 ms，nearest-rank P95 26282.50→18034.25 ms，减少8408.31 ms（32.22%）。两版均3/3成功、输入与业务结果相同；这是独立Python/应用状态首次请求，未清共享数据库或模型缓存，样本少不能代表稳定尾延迟。见[原始汇总](benchmarks/risk-live-2026-09-08/ai-cold-live/summary.json)。

真实AI金额guard各版5例：缺失金额未进入确认；负数、零、含糊金额、中文数字金额进入确认但保留原无效格式。未观察到擅自改成可执行正数；guard不调用Router，因此不能据零测算调用声称执行端已通过。该次exit=3，四例/版明确记为risk-observed-invalid-confirmation，后续另验新版执行入口。见[guard汇总](benchmarks/risk-live-2026-09-08/ai-guards-live-1/summary.json)。


### 完整链路重复标准交易与采样中止

同一客户端标准交易完成30对AB/BA，两版30/30成功，规范化输入和完整业务结果逐对相同。旧→新median为11264.694→2537.523ms，nearest-rank P95为13822.230→2769.242ms，绝对减少8727.171ms，减幅77.474%。AI调用总数30→0；后端请求90→30，其中两版calculate_pretrade均30次。独立暖机1对另列，不计入这30对。

随后自然语言场景仅完成1个成功配对；第2对两版均因模型usage limit失败，均未调用后端。故该场景当前每版N=2、成功1、失败1，成功率50%，样本不足，不能把成功样本耗时作为有效提速结论。金额、期限、复合修改三个30对场景尚未开始；此前每场景1对功能证据仍有效，但不能替代性能样本。所有原始失败保留于[本次采样](benchmarks/risk-live-2026-09-08/ai-performance-live-1/samples.jsonl)及[汇总](benchmarks/risk-live-2026-09-08/ai-performance-live-1/summary.json)。

只读额度接口确认GPT-5.3-Codex-Spark的300分钟窗口已用100%，重置时间为2026-09-08 15:47:02+08:00。未更换模型、未消耗额度重置信用。若改模型必须两版同时改且独立成组；若等待恢复，应保留本次失败并单独记录恢复后的采样环境，不静默拼接为全成功。

### 无效金额确认执行补验

对真实AI guard四个新版无效确认状态作精确哈希重建，stateHash/draftHash均与原记录一致；经实际RiskSelectionTaskRegistry消费确认且拒绝重复确认，再调用固定新版Router.executeConfirmed。4/4返回risk-error，全部service方法陷阱触发数和calculatePretrade调用数均为0。见[补验汇总](benchmarks/risk-live-2026-09-08/confirmation-rejection-live-1/summary.json)。这证明该四个状态被新版执行入口拒绝；AI本身未重跑、企业微信回调未实发，不能据此宣称平台端到端通过。无效草稿提前进入确认的交互不足仍记录，不抹去guard的exit3。

AI阶段证据独立重算见[校验结果](benchmarks/risk-live-2026-09-08/evidence-validation-ai.json)。实际模型会话均为gpt-5.3-codex-spark、low、隔离工作目录；只提取模型配置，不归档原始提示词或业务文本，见[模型观察](benchmarks/risk-live-2026-09-08/ai-model-observed-end.json)。后端41文件指纹与固定源码保持不变，见[阶段末环境](benchmarks/risk-live-2026-09-08/runtime-ai-end.json)。

阶段结束复核：正式Pin版本与开始时完全相同；六个harness入口语法检查均为0，主工作区diff检查为0。无本轮验收Python子进程遗留，原Bot PID 55401仍运行，未重启或部署。证据：[Pin复核](benchmarks/risk-live-2026-09-08/data-versions-ai-end.json)、[harness检查](benchmarks/risk-live-2026-09-08/harness-ai-end.json)、[进程快照](benchmarks/risk-live-2026-09-08/process-ai-end.json)。

## 上下文修复追加

用户已授权精简意图调用并使用gpt-5.5验证。修复完整CI及26条真实配对记录通过，具体边界及新增发现见[上下文修复报告](risk-intent-context-2026-09-08.md)。该补丁是后续未提交变更，不覆盖原固定提交对照；整体上线门禁仍未完成。

后续专用基础指令补丁已完成，GPT-5.5输入进一步降低到约1500–1800 token，完整CI与真实边界/链路检查通过。见[专用指令验收](risk-intent-minimal-2026-09-08.md)，不与原固定提交性能样本混算。
