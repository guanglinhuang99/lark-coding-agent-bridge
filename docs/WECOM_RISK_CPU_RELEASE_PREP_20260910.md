# WeCom CPU 性能候选发布准备（2026-09-10）

## 状态

**本地验证 PASS；离线候选包检查 PASS；真实买入/查询矩阵 BLOCKED；未切换生产。**

本轮未改性能源码。Git 基线为 ddb99f650394e470c56bc214d77ec6b1af6adf9c；待固定版本包含本轮已授权的预热、PQ 缓存、纯字符串 CPU 优化及相关测试/脱敏报告。实际提交号以 Git 和候选包 manifest 的 source_commit 为准，不将基线当作最终版本。没有 GitHub 推送、PR、tag 或 npm 发布。

## 本地验证

隔离 worktree：`/private/tmp/wecom-risk-cpu-validation-COvQbq`。624 个普通文件与实际工作区逐一核验 SHA-256，一致；测试后再次核对也无源码变化。完整构建在隔离目录执行，未改 Lark 使用的共享 dist。

| 阶段 | 结果 |
| --- | --- |
| diff check | exit 0 |
| Web build | exit 0 |
| 全库 Vitest | exit 0；162 文件、1199 用例通过，1 项受控 benchmark 跳过 |
| TypeScript typecheck | exit 0 |
| server build | exit 0 |
| 生产 Python unittest | exit 0；40 用例 |

源码独立复核覆盖预热位置、内网 gate、产品无关路由、health 更新、缓存数据隔离、纯字符串有界缓存及函数 timing。未发现本轮变更取消确认步骤、扩大业务权限或缓存最终风险结论。真实功能矩阵未执行，因此不据此给出全面业务等价验收。

## 离线候选包

目录：`/Users/guanglin/.lark-channel/releases/wecom-risk-cpu-20260910-cce6da13`。

包内的 WeCom bundle 由上述隔离全量构建产生，SHA-256 为 `7316ebbb391df38d1ad50c3706df75dc85b6a16190e3cb8cdc310779eea05139`，与线上 r3 相同。CPU bridge SHA-256 为 `cce6da1375c782050c3fe830ab3ac900e7ad4f713b0d06a1507f7ec282f5c389`。

已从候选包的实际 `dist/wecom.js` 路径解析全部 8 个声明的 Node 运行依赖，防止再次出现只通过语法检查却漏带依赖的问题。JS 语法、Python AST、candidate/original plist 语法全部通过。此包延续线上 node_modules 链接和既有生产 Python 运行时，未安装或改动依赖；它不是完全自包含发行包。

候选包状态为 `PREPARED_NOT_DEPLOYED`，manifest 明确 `production_cutover_allowed=false`。没有替换 LaunchAgents 目录中的 plist，也没有执行 bootout/bootstrap/restart。

回退材料是本轮冻结的当前 r3 plist，SHA-256 `5d96bb0ee9e34deed18d603c1591ade7630c51734f7239ef45e008b4272842fc`，不是更早版本的回退定义。实际业务状态继续使用原目录，禁止用旧账本/状态快照覆盖运行态。

## 私有证据

持久目录：`/Users/guanglin/.lark-channel/acceptance/risk-cpu-20260910-cce6da13`。

已将之前 93 次申购模拟的原始结果、汇总/驱动与本轮 CI 日志等 107 个文件复制并核对哈希，目录 0700、文件 0600。临时原件保留。没有复制凭证、生产缓存或会话账本；原始金融结果不进入 Git。此归档没有新增真实买入/查询结果。

## 尚未满足的上线条件

主流程已确认主机 VPN 为 IAMC-Office Connected。本机 Codex workspace-write 会话的 `endpoint-vpn --json doctor` 路由检查被拒绝，返回 `Operation not permitted`；该会话的 HTTP 探针又在所配置的本地代理前失败，未到达内网目标。没有修改权限、沙箱、路由、代理或重复尝试绕过拒绝。

以下 6 类真实功能对照仍为 NOT RUN：持仓查询、证券搜索、授信查询、单证券模拟买入、改金额重算、两笔模拟买入。多账户并发和原生企业微信端到端也未运行。之前标准申购中位数下降 59.21% 的证据保留原范围，不外推到未测场景。

## 剩余任务交接

在已获得所需内网访问授权的本机 Codex 会话中读取本文件和 `WECOM_RISK_CPU_ACCEPTANCE_20260910.md`，复用 `.codex-handoff/risk-cpu-acceptance-20260910/task.md` 的 A/B 测试边界。仅补 6 类真实只读/模拟矩阵，每类最多 3 对 r3/候选结果，业务字段严格比较，金额变化必须形成新任务与对应新输入。不得通过关闭沙箱/审批、清空生产缓存或替换业务结果来获得通过；若需要额外权限，走正常授权流程。

当前源码不变时不要重跑已通过的 93 次历史申购样本或全库 CI。所有功能通过后核对候选包 source_commit/hash 与当前 Git 一致，记录新鲜空闲/健康状态，再按已授权范围仅切换 WeCom；保留 r3 回退，不操作飞书。切换后仍须验证实际 Python bridge、健康、任务退出和原生查询/确认/改金额交互，任何未执行项目保持未验收。
