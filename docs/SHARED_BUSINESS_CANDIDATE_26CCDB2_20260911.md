# 共享业务重构：26ccdb2 双渠道候选与原生验收预检

日期：2026-09-11。候选构建完成于 05:33:25 UTC；隔离入口检查完成于 05:34:39 UTC。

## 结论

**PREPARED_NOT_DEPLOYED / OFFLINE_PACKAGE_CHECKS_PASS / NATIVE_ACCEPTANCE_BLOCKED**。

已从 PR #20 当前提交重新构建飞书、企业微信两个入口，并在独立发行目录完成依赖与资产检查。本轮没有继续改业务源码，没有提交、推送、合并或发布，没有重启任何生产机器人。原生验收尚未执行：现有飞书 profile 列表只有运行中的生产 codex，没有发现独立测试 profile，且尚未获准暂停生产连接进行候选替换。

## 固定版本与候选位置

| 项目 | 实际记录 |
| --- | --- |
| PR | guanglinhuang99/lark-coding-agent-bridge #20，目标 main |
| 分支 | refactor/shared-business-core |
| 源码提交 | 26ccdb2b01b4f7a9ad76922c5ccc9568148f6329 |
| Git tree | 2cb3e4277d702316aca4e3fe4c10e9b23529775f |
| 候选目录 | /Users/guanglin/.lark-channel/releases/shared-business-26ccdb2-Rx0yuR |
| 构建工作树 | /var/folders/yz/f27434tj0x30rs3hxf97rmg40000gn/T/shared-business-rc-26ccdb2-FFRfUW/checkout |
| Node | v24.19.0 |
| 候选清单 | 候选目录内 candidate.json |
| 包内版本字段 | 0.8.5；没有修改版本号，必须以源码提交和资产哈希识别本候选 |

候选目录包含 dist、bin、package.json、README、许可证及 ACCEPTANCE.md。它不包含外部 risk-service 后端、数据库、生产配置、凭证或独立 Python 环境。node_modules 是指向已有工作区依赖的链接，不是自包含安装包；本地没有重新安装依赖。

## 本轮实际验证

| 检查 | 结果与范围 |
| --- | --- |
| 固定提交独立检出 | PASS；没有复制原工作区未跟踪文件 |
| 前端构建 | PASS；在独立 HOME 和工作树执行 |
| 服务端构建 | PASS；同次构建生成飞书、企业微信、library 三个入口及声明 |
| JavaScript 语法 | PASS；三个入口分别执行 node --check |
| 发行目录依赖解析 | PASS；从飞书、企业微信实际 bundle 路径分别解析全部 8 个声明依赖 |
| Python 桥接资产 | PASS；包内脚本与公共源码逐字节一致，AST 解析通过 |
| 候选资产清单 | PASS；12 项文件 SHA-256 全部复核一致 |
| 飞书隔离入口 | PASS；在无生产配置 HOME 执行 --help，正常退出 |
| 企业微信隔离入口 | PASS；--health 返回 healthy=false、reason=missing 和退出码 1，符合缺失状态时的预期拒绝 |
| 生产构建保护 | PASS；构建前后三个原工作区 dist 入口哈希不变 |
| 源码工作树保护 | PASS；构建工作树已跟踪源码无变更 |

本轮未重复运行全量单元测试或性能基准。当前 26ccdb2 的既有远端 push/pull_request 两次 CI 共六个平台任务，在本轮重新查询时均为 SUCCESS；PR 为 OPEN、MERGEABLE、CLEAN。这些结果是当前提交的远端证据，不冒充本轮新跑的本地测试，也不能替代原生客户端验收。

## 核心资产 SHA-256

| 文件 | SHA-256 |
| --- | --- |
| dist/cli.js | 948a2661919bd48a7dd1ecdfa75200de56ee47cbd911bcb6fe6ef5efda18a216 |
| dist/wecom.js | 42a2247ffb47212a9d514e4c7d69cc9330d737a02abc9c85d58297b131715a2e |
| dist/index.js | 5f765804b81cb7acdb74631d27f54a6ec1cb0db99a411635e7908f26eb54530f |
| dist/risk/direct_bridge.py | 0c87e1bf23d9cf4504a6dc2650beb40db77445611a4d38fbbc1432fd636645bc |

旧报告中 6e70f4d 的候选哈希不能用于识别本候选。candidate.json 明确 production_cutover_allowed=false、native_channel_acceptance=NOT_RUN、live_backend_acceptance=NOT_RUN。

## 现有服务的脱敏预检

本轮只查询服务状态和 launchd 已加载参数，在内存筛选后输出配置存在性，没有输出完整环境或秘密。

| 项目 | 飞书 | 企业微信 |
| --- | --- | --- |
| 服务标签 | ai.lark-channel-bridge.bot.codex | ai.wecom-channel-bridge.riskbot-codex |
| 当时 PID / runs | 36940 / 1 | 77479 / 1 |
| 进程状态 | running | running |
| 风险配置可见性 | 未发现 RISK_PYTHON、RISK_SERVICE_DIR、LARK_RISK_ALLOWED_USERIDS 或 LARK_RISK_USE_ALLOWED_LIST | 可见 WECOM_RISK_PYTHON、WECOM_RISK_SERVICE_DIR，并引用现有 .env 和运行状态目录 |

上述仅说明 launchd 可见环境，不证明应用随后加载了哪些配置，也不证明当前平台连接、业务服务可用或已加载候选。未读取或复制生产 .env；没有自动将企业微信配置或用户 ID 转移给飞书。

原生验收前必须明确为飞书提供公共风险运行配置和飞书自身允许名单。只把两个入口替换为相同候选包，不代表两边已获得相同数据服务配置。

## 原生验收前置条件与执行边界

独立测试机器人和明确受控会话就绪后，可在隔离状态目录运行候选。没有独立测试身份时，必须另行批准受控维护：先记录并保留实际生产启动定义与回退方式，确认无运行或排队任务，再按渠道逐个暂停原连接、启动候选单实例、完成限定样本验收并恢复或按批准结果保留。不能同时运行同一机器人身份的生产与候选连接。

不得因验收关闭权限检查、扩大允许名单、绕过网络限制或重置生产账本。后端原始金融结果不进入 Git。任何配置缺失、网络不可达或权限不足均应停止相应测试，不用历史数据和模拟成功结果替代。

| 原生验收项 | 本轮状态 |
| --- | --- |
| 双渠道标准查询与单主体/多主体授信 | NOT RUN |
| 测算摘要、明确确认及重复确认 | NOT RUN |
| 金额修正、候选选择与旧确认拒绝 | NOT RUN |
| 早到确认、排队停止和取消后的迟到结果 | NOT RUN |
| 用户、工作区及话题隔离 | NOT RUN |
| 长结果完整性、断线重投和退出清理 | NOT RUN |
| 实际业务后端及性能对比 | NOT RUN |

## 证据与交接

- 固定候选构建：task_46054f69bed3ce36，退出码 0。
- 候选隔离入口与 12 项资产复核：task_7d57ee23c37eb92f，退出码 0。
- 双服务脱敏运行预检：task_08a5f2f2974fbeb2，退出码 0。
- 候选构建批次：op_40063c17caf1962752885b39。
- 隔离入口及服务预检批次：op_808375164ae3cfdca2cd9d2e。

本文件是对当前固定候选的新增验收记录，未纳入源码提交。下一阶段只补实际配置及原生验收，不重做已完成的重构或把候选准备等同于上线。
