# 39299bb：终态修复复审与原生复验预检

日期：2026-09-11。

## 当前结果

**LOCAL_FIX_COMMITTED / INDEPENDENT_REVIEW_COMPLETE / CANDIDATE_CHECKS_PASS / NATIVE_NOT_RUN_OS_ACCESSIBILITY**。

用户已同意继续独立审查和既有范围的受控原生复验。本轮完成原提交的独立审查、有效缺陷修复及新候选构建；原生界面访问遭 macOS 拒绝，因此没有暂停或替换任何生产机器人，没有发送真实测试消息，没有进行真实业务查询和 RPC 计数。

## 固定对象

| 项目 | 本轮记录 |
| --- | --- |
| 分支 | refactor/shared-business-core |
| 新本地 HEAD | 39299bb82e6129c261f1359899f0a003f27dd7fd |
| 新增提交 | 10 个相关文件；205 行新增、24 行删除 |
| 源码 tree | bd283eda67235b62eded9380e0d327b9e11434ad |
| 新候选 | /Users/guanglin/.lark-channel/releases/shared-business-39299bb-NdGdIV |
| 构建工作树 | /var/folders/yz/f27434tj0x30rs3hxf97rmg40000gn/T/shared-reviewed-candidate-TFRzJY/checkout |
| 资产清单 | 新候选目录内 candidate.json，12 项 SHA-256 |
| PR #20 | 最后查询仍为 26ccdb2、OPEN、CLEAN；新本地提交未推送 |

旧 55778ed 和 26ccdb2 候选均不包含本轮审查修复，不能作为当前复验对象。候选的版本字段仍为 0.8.5，应以完整提交及资产哈希识别。

## 独立审查与修复

55778ed 的独立只读 Codex 复审成功返回结论，任务 task_a5973446b4cc8adc，退出码 0。有效问题已核实修复：飞书退出无限等待取消回执；/new 残留原业务归属；企业微信取消回执挂起使请求不结束。另通过本轮回归发现并修复早到普通消息在异步识别后清除较新终态的版本缺口。

审查关于“飞书重复空闲回执”的判断不成立：普通不带参数的 /stop 在通用处理器中不回复，正式入口精确断言只有一条取消回执。没有为误判修改普通停止行为。详细记录见 SHARED_BUSINESS_TERMINAL_REVIEW_20260911.md。

共享状态增加明确 reset/resetScope；终态使用与草稿相同的单调版本隔离。两渠道复用现有 withTimeout，取消回执或其退出排空最多等候 1000ms；超时不重试业务，不宣称已送达，也不保证底层网络请求物理取消。

修复后的固定提交 39299bb 已完成最终独立只读 Codex 复审：任务 task_25865ef5dfa2e732，于 2026-09-11 09:34:22 UTC 结束，退出码 0、未超时，最终结论为“未发现新的可操作缺陷”。复审核对了五个相关源码文件、对应回归测试及飞书通用停止处理器，确认四类有效问题的修复。该结论属于限定范围的静态代码复审，不等同于 GitHub 人工审批或原生客户端验收。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| 相关业务、两渠道、普通命令回归 | 76 文件、681 项通过；零失败零跳过 |
| 新增回归 | 9 项，并加强已有飞书单回执断言 |
| TypeScript 类型检查 | PASS |
| 提交差异检查 | PASS |
| 新固定提交前端、服务端构建 | PASS；独立工作树和 HOME |
| JavaScript 三入口语法检查 | PASS |
| 两渠道 bundle 运行依赖解析 | 各 8 项 PASS |
| 新候选 12 项哈希重新核对 | PASS |
| Python 资产一致性与 AST | PASS |
| 无生产配置的 help/health | PASS；health 缺失时正确拒绝就绪 |
| 原生产 dist | 构建前后哈希不变 |

本轮没有重跑整个仓库全量 CI，没有触发远端检查。681 项是实际运行的相关集合，不把此前 1345 项全量结果当作新提交已经重跑。候选复用已有 node_modules，不内置外部风险后端、Python 环境或凭证。

核心资产 SHA-256：

- dist/cli.js：755b3a438de1b297d467e40a7502725e71ed6dd83864a0455bebeece94b387da
- dist/wecom.js：945491e315326145f69fd2185ee7bc6071ea57c858fa9e80653397539f51f2b8
- dist/risk/direct_bridge.py：0c87e1bf23d9cf4504a6dc2650beb40db77445611a4d38fbbc1432fd636645bc

## 原生预检限制

应用进程列表可见 Feishu 与企业微信，但读取两个窗口的辅助功能预检返回：accessibility=false；两个应用均报“osascript 不允许辅助访问”。这是 macOS 权限阻塞，不是测算业务失败。

没有修改辅助功能设置、绕过授权或改用其它工具规避限制。因为无法可靠定位受控用户会话与输入框，未暂停原服务，也未启动同身份候选连接。

| 原生项目 | 状态 |
| --- | --- |
| 确认完成后再次确认，普通 Agent / RPC 增量为零 | NOT RUN |
| 取消回执、取消后确认，RPC 增量为零 | NOT RUN |
| 新测算重新执行 | NOT RUN |
| /new 及普通聊天确认恢复 | NOT RUN |
| 真实 RPC 请求/响应 ID 精确计数 | NOT RUN |
| 旧确认卡回调、延迟、断线、跨用户、重投 | NOT RUN（保留原范围） |

## 生产与后续交接

09:32:39 UTC 收尾查询：飞书原 PID 58157、企业微信原 PID 57364，均 runs=1。没有合并、推送、修改生产 plist、配置、允许名单、凭证或生产数据；没有覆盖生产 dist。此处仅证明进程状态，本轮未重新核对业务子进程、真实平台连接和健康数据。

后续在已获辅助功能权限的本机执行环境中，沿用原批准的单实例、限定私聊和逐渠道恢复流程。读取旧交接的安全与计数要求，但将所有待测版本替换为本文件的 39299bb 候选。无需再重构或打包，除非发现新修改。先核对本地提交、candidate.json 及 12 项哈希；使用此前已核验的用户和金融样本，不扩大数据范围。

最小矩阵：原 100 万草稿改为 200 万并确认；结果完成后重复确认；新草稿 /stop 后确认；重新新建并确认；/new 后普通问答及普通确认。分别记录实际 Agent 启动和 calculate_pretrade 请求/响应 ID，不能用 PQ 缓存条数或“未看见第二份结果”代替计数。每个渠道验证后恢复原版本、原 plist 字节与权限并核对无候选残留。

## 本轮执行证据

- 55778ed 独立审查：task_a5973446b4cc8adc。
- 39299bb 最终独立复审：task_25865ef5dfa2e732，退出码 0，未发现新的可操作缺陷。
- 681 项回归、类型及差异：task_8f55b7a1205fc287。
- 新候选构建：task_d6a6b1bbf26bf905。
- 12 项哈希及离线入口：task_bd6295e8c6446239。
- 原生界面预检：op_cf5803013831e2efde3a9839 的 native-windows 步骤，命令退出码 0，但结构化结果明确两个应用均拒绝辅助访问。

本文件为本地新增未提交的验收预检记录，不改变候选源码或历史原生报告。

## 2026-09-11 本轮受控原生复验追加记录

本节只追加本轮实际记录，不改写上文历史结论。本轮沿用已核验的私聊、账户、标的及只读后端配置；未下单、未修改生产业务数据，未扩大允许名单，未关闭权限检查。

### 固定代码与候选资产验证

| 检查 | 结果 | 证据与限制 |
| --- | --- | --- |
| 分支、HEAD、源码 tree | PASS | `refactor/shared-business-core`；HEAD `39299bb82e6129c261f1359899f0a003f27dd7fd`；tree `bd283eda67235b62eded9380e0d327b9e11434ad` |
| 候选身份 | PASS | `/Users/guanglin/.lark-channel/releases/shared-business-39299bb-NdGdIV/candidate.json` 声明同一 commit/tree，包版本为 `0.8.5`，状态 `PREPARED_NOT_DEPLOYED`；以 commit/tree 和哈希识别版本 |
| 12 项资产哈希 | PASS | 重新核对 12 项，零不匹配；候选桥接脚本为 `dist/risk/direct_bridge.py`，SHA-256 `0c87e1bf23d9cf4504a6dc2650beb40db77445611a4d38fbbc1432fd636645bc` |
| 候选 Python 桥接生效路径 | PASS | 两渠道候选 plist 均显式指向上述候选桥接脚本；未因继承旧 `RISK_BRIDGE_PATH` 或 `WECOM_RISK_BRIDGE_PATH` 混用旧桥接脚本 |
| 源码工作树 | PASS | HEAD 和既有 10 组未跟踪文件保持不变；未覆盖、删除或清理用户文件 |

### 企业微信真实客户端与后端

候选实例时间窗口约为 18:00:00–18:06:17（Asia/Shanghai）；候选主进程 PID 70741，候选业务 Python 子进程 PID 70754。候选日志为本机临时状态目录下的必要元数据日志；日志没有提供可核验的入站用户消息 ID，也没有 JS→Python 精确请求/响应 ID。

| 矩阵 | 客户端收发与提示 | 后端/进程证据 | 结果 |
| --- | --- | --- | --- |
| A 草稿、修改金额 | 首次草稿出现确认提示；随后修改为 200 万，确认摘要更新；明确确认前未见测算结果 | 18:01:01 risk-intent 独立进程完成，18:01:16 `search_securities` 成功；无 `calculate_pretrade` | PASS |
| B 首次明确确认 | 客户端进入运行进度并显示完成结果；未记录结果正文 | 18:03:49 `calculate_pretrade` 方法事件成功 1 次；普通 Agent 启动增量为 0 | PASS（方法事件级） |
| C 完成后再次确认 | 客户端明确回复“该确认已处理”“不会重复执行测算” | 未出现第二个 `calculate_pretrade` 方法事件；普通 Agent 启动增量为 0 | PASS（方法事件级） |
| D `/stop` 及取消后确认 | `/stop` 明确回复“已取消风险交互”；随后确认明确回复该风险交互已取消，未仅返回空闲状态 | 取消场景无普通 Agent、无 `calculate_pretrade` 方法事件 | PASS |
| E 重新发起业务 | 新草稿明确确认后再次显示完成结果，证明结束标记未永久锁死 | 18:05:18 `calculate_pretrade` 方法事件成功第 2 次；风险意图解析仍独立 | PASS（方法事件级） |
| F `/new`、普通聊天及普通确认 | `/new` 显示会话已重置；普通问题和随后普通“确认”均获得普通聊天回复，未误判为风险确认 | 普通 Agent 启动 2 次（PID 71401、71500）；无风险测算事件 | PASS |

企业微信候选日志分别记录 risk-intent 进程 PID 71070、71269、71335；上述进程不计入普通 Agent。18:00:00 的一次中文输入方式不正确，形成了不属于矩阵的普通 Agent PID 70918，已清理并排除在上述计数之外；这是本轮测试操作限制，不作为金融矩阵结果。

企业微信真实用户消息 ID：NOT RUN（候选日志及客户端界面没有提供可核验入站 message ID）。`calculate_pretrade` 精确 RPC 请求 ID、响应 ID及终态：NOT RUN（本轮仅有桥接层方法事件，不能冒充 RPC 边界计数）。因此“2 次成功”是候选方法事件证据，不是精确 RPC 请求/响应计数。

### 飞书真实客户端与后端

候选实例时间窗口约为 18:08:14–18:12:14（Asia/Shanghai）；候选主进程 PID 71844。候选日志显示 WebSocket connected、profile-online、风险运行时 warmup-ready，且实际桥接路径为本候选 `dist/risk/direct_bridge.py`。候选业务 Python 子进程 PID：NOT CAPTURED。

| 矩阵/步骤 | 客户端收发与提示 | 后端/进程证据 | 结果 |
| --- | --- | --- | --- |
| 候选启动与 `/status` | 首次候选 `/status` 在真实私聊中显示临时 cwd、active run no、queue 0、owner API ok | 候选服务已连接并完成 `list_products` warmup；候选入口为候选目录 `lark-channel-bridge.mjs` | PASS |
| A 草稿、修改金额 | 两次真实 `/测算` 入站均被记录，但客户端未显示本轮确认卡；未发送修改或确认 | risk-intent 独立进程 PID 71929、72028；`search_securities` 方法事件成功 2 次；无 `calculate_pretrade` 方法事件 | FAIL（客户端未形成可继续的确认卡） |
| B–F | 因 A 未形成可核验确认卡，为避免盲发确认、误触发测算或把未建立步骤算作通过，未继续执行 | 无本轮确认、取消、重新测算或普通聊天矩阵事件 | NOT RUN |

飞书候选两次风险草稿的可核验入站消息元数据为：

- 18:08:48：`om_x100b65097dccc8bcb2aa7ebc60b7dcb`，trace `emgl2n15`，risk-intent run `57d8c5e1-f9e4-481e-8eb8-2ee0b35ca90d`；
- 18:10:10：`om_x100b650976eb146cb03600299fd5e16`，trace `f7rktx3c`，risk-intent run `8898eda6-c65e-44f4-98dd-6b8ead391670`。

随后诊断用 `/status` 入站消息为 18:12:12 的 `om_x100b6509710c04a4b15bc4f186cd317`；候选日志记录 command，但客户端没有新增可见回执。上述日志说明意图解析和证券查询到达了候选后端，但没有形成可用的客户端确认提示；本轮不据此推断具体源码原因，也不把它扩展成新的静态审查结论。

飞书普通 Agent 启动次数：0（本轮未进入普通聊天矩阵）；risk-intent 启动 2 次，单独计数。`calculate_pretrade` 方法事件：0。真实用户消息 ID已记录的仅为候选日志中的入站元数据；`calculate_pretrade` 精确 RPC 请求 ID、响应 ID及终态：NOT RUN。不得以方法事件为精确 RPC 计数。

### 原服务恢复

| 渠道 | 结果 | 恢复证据 |
| --- | --- | --- |
| 企业微信 | PASS | 候选于 18:06 后停止；候选主进程及业务子进程退出；原 plist `/Users/guanglin/Library/LaunchAgents/ai.wecom-channel-bridge.riskbot-codex.plist` mode 0600、size 2480、SHA-256 `4f21251b3f31086fa66fd302e6c14710c489cb9fccb563f4a9707997860b4985`，与冻结副本字节相同；原服务以 PID 71737 运行，原双 bridge 参数、原配置引用和原风险桥接路径恢复；健康状态 connected/ready、activeRuns 0，真实企业微信 `/status` 显示空闲、queue 0、owner API ok |
| 飞书 | PASS（服务级）；客户端恢复 `/status` 回执未捕获 | 候选 PID 71844 已停止且无候选 LaunchAgent 残留；原 plist `/Users/guanglin/Library/LaunchAgents/ai.lark-channel-bridge.bot.codex.plist` mode 0644、size 2158、SHA-256 `f1b6ebd5b11973bce0984bbbac4971700c2f9672b059e94849ccf2f9c8706608`，与冻结副本字节相同；原服务以 PID 72452 运行，原入口和原 `LARK_CHANNEL_HOME` 恢复；原 daemon 日志显示 connected/profile-online；生产任务文件仍为 20 项，其中 18 done、2 interrupted，无 queued/running |

飞书恢复后已从真实客户端发送 `/status`，客户端界面在本轮窗口内未显示新增回执，因此恢复后的真实客户端提示记为 NOT CAPTURED；这不改变已核验的 LaunchAgent、WebSocket、生产任务队列及无候选残留状态。企业微信恢复后客户端回执已捕获。

### 未执行与范围边界

以下项目继续保留 NOT RUN：飞书 B–F；两渠道 JS→Python 精确 RPC request/response ID 计数；旧确认卡回调、延迟、断线、跨用户、重投；任何未具备安全明确条件的额外原生场景。未执行全量测试、重新构建、远端 CI、发布、合并、推送、tag 或正式上线。本轮没有发现足以授权架构重构的新缺陷；飞书客户端确认卡未回执是本轮原生验收失败/阻塞证据，需在后续具备明确安全条件时单独诊断。

### 权限与候选收尾补充

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 飞书、企业微信辅助功能输入权限 | PASS | 本轮通过受控 CUA 读取并操作两个真实客户端的已核验私聊；上次 `accessibility=false` / “osascript 不允许辅助访问”阻塞已不再出现；未修改或绕过 macOS 权限 |
| 候选临时任务收尾 | PASS | 企业微信候选任务 14 项均为 done；飞书候选任务 4 项均为 done；两处 active queued/running 均为 0 |
| 生产账本与会话 | PASS | 未用旧快照覆盖生产状态；生产飞书任务仍为 20 项（18 done、2 interrupted），企业微信原生产状态及账本未被候选状态目录覆盖 |

### 飞书 A 项客户端证据更正（2026-09-11 18:27–18:29 界面复核）

追加更正，不改写前述当时的暂定记录：在候选停止并恢复原服务后，对真实飞书私聊的现有消息进行只读复核，确认 18:09 和 18:10 两条候选 `/测算` 入站消息各自已有一份可见的“请确认交易意图”回复，包含交易摘要、`confirm` 选项及“只有明确确认后才会执行测算”的提示。因而上述 A 项的客户端结果应更正为 **PASS**；此前标为 FAIL 是当时界面尚未加载出回复的观察误判。

该更正不改变 B–F 当时未发送、未执行的事实，也不改变本轮没有 `calculate_pretrade` 精确 request/response ID 的限制。为继续 B–F，需在候选重新接管后发送新的 A 草稿；本次重新接管期间未发送测试消息，已立即恢复原飞书服务。

### 飞书第二轮闭环复验（2026-09-11 18:46:50–18:52:17，Asia/Shanghai）

本节追加第二次候选接管后的实际闭环结果，用于完成上一节更正后尚未执行的 B–F；不改写前述历史观察。候选主进程 PID `76560`，候选实例显式使用本候选 `dist/risk/direct_bridge.py`。候选临时任务文件共 18 项，最终 `done=18`，无 active/queued/running。

| 矩阵 | 真实客户端证据 | 后端/进程证据 | 结果 |
| --- | --- | --- | --- |
| A 草稿、修改金额 | 消息 `om_x100b65098d2f00a8b4b4c5a9539d4ae` 建立 100 万草稿；消息 `om_x100b65098b5b9c84b046266adb9e96c` 修改后，真实客户端确认摘要显示规模为 200 万；确认前未显示测算结果 | risk-intent PID `76702`；未出现 `calculate_pretrade` 方法事件 | PASS |
| B 首次明确确认 | 消息 `om_x100b650988dc38b0b1f015861b2fbfb` 明确确认后，客户端显示完成结果 | `calculate_pretrade` 方法事件成功 1 次；后端 `pretrade_run=39ba13b52018416688d0b5fc03b81126`，终态 completed；普通 Agent 启动增量 0 | PASS（方法事件级） |
| C 完成后再次确认 | 消息 `om_x100b650987f118acb2ac9ee25ba1179` 后，客户端明确回复“该确认已处理／不会重复执行测算” | 无新增 `calculate_pretrade` 方法事件；普通 Agent 启动增量 0 | PASS |
| D 取消及取消后确认 | 新草稿消息 `om_x100b650984d5d0a4b1beecfc841aeed`；`/stop` 消息 `om_x100b6509854bdcacb1533d3bc78425d` 明确回复“已取消风险交互”；随后确认消息 `om_x100b6509829f0480b2995526e59a6ca` 明确回复该风险交互已取消，未仅返回空闲状态 | risk-intent PID `76824`；取消场景无普通 Agent、无 `calculate_pretrade` 方法事件 | PASS |
| E 重新发起业务 | 新草稿消息 `om_x100b650983e158a4b1adf2e809e34c4`，确认消息 `om_x100b650980871ca4b163105db34f6ce` 后客户端再次显示完成结果 | risk-intent PID `76893`；`calculate_pretrade` 方法事件成功第 2 次；后端 `pretrade_run=7e120cea42644d068a00e63b11099a9c`，终态 completed | PASS（方法事件级） |
| F `/new`、普通聊天及普通确认 | `/new` 消息 `om_x100b65099f9e9ca8b3bad3084bc6de3` 回复已开始新会话；普通问题消息 `om_x100b65099f2a8cb0b16e435d1b636c8` 正常回复；普通“确认”消息 `om_x100b65099dfec8a8b1024377816873e` 回复“好的” | 普通 Agent 启动 2 次（PID `77144`、`77267`），与 risk-intent 进程分开计数；无风险测算事件 | PASS |

本轮第二次飞书候选运行的已核验真实用户消息 ID 为上表所列 12 项；对应客户端 trace 及必要入站元数据保存在候选临时日志中，不保存用户身份明细、交易参数正文或结果正文。risk-intent 进程共 3 个（`76702`、`76824`、`76893`），普通 Agent 共 2 个（`77144`、`77267`），未混计。后端 `calculate_pretrade` 方法事件为 2 次成功；精确 RPC request ID、response ID 及终态仍为 **NOT RUN**，不能以方法事件冒充 RPC 边界计数。后端日志另有既存 PQ 产品视图缺失警告，但本轮两次业务调用均有 completed 成功终态，未据此扩大结论。

### 第二轮后原服务恢复

| 渠道 | 结果 | 恢复证据 |
| --- | --- | --- |
| 企业微信 | PASS | 原服务继续以 PID `71737` 运行；原 plist mode 0600、size 2480、SHA-256 `4f21251b3f31086fa66fd302e6c14710c489cb9fccb563f4a9707997860b4985`；未受飞书候选切换影响 |
| 飞书 | PASS（服务级） | 候选 PID `76560` 及本轮已记录候选子进程均已退出；原服务恢复为 PID `77909`，WebSocket connected/profile-online；原 plist mode 0644、size 2158、SHA-256 `f1b6ebd5b11973bce0984bbbac4971700c2f9672b059e94849ccf2f9c8706608`，与冻结副本字节相同；无候选 LaunchAgent 残留 |

恢复后只读核对：生产飞书任务文件共 21 项，`done=19`、`interrupted=2`，无 queued/running；未用旧账本快照覆盖测试期间记录。两渠道当前均为原版本，候选状态目录、候选连接及候选业务子进程均未留在生产运行面。

### 第二轮范围边界

本轮真实客户端 A–F 均完成并通过；企业微信此前已完成 A–F。本轮仍未取得两渠道 JS→Python 精确 RPC request/response ID 计数，相关计数项为 **NOT RUN**。旧确认卡回调、延迟、断线、跨用户、重投场景继续保留 **NOT RUN**，未用模拟回归替代原生验收。没有新源码变化，未重复构建、全量测试、候选打包或远端 CI；未推送、未合并、未打 tag、未发布 npm、未正式上线。
