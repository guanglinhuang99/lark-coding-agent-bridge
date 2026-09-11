# 风险查询/测算性能优化记录（2026-09-10）

## 范围与版本

- 工作区：`/Users/guanglin/Sync/wecom-bot`
- 优化起点：`main` HEAD `ddb99f650394e470c56bc214d77ec6b1af6adf9c`
- 源码修改仍未提交、推送；已按批准范围将候选版 `wecom-risk-perf-20260910-f69e76dd-r3` 切换到目标 WeCom 单实例，未操作 Lark。
- 不缓存正式测算结论；风险规则、阈值、持仓口径和确认流程的业务语义保持不变。

## 已实施优化

1. **内网探测正向缓存**：`RiskDirectClient` 默认复用 60 秒内成功的内网 TCP 探测，避免每个 risk call 重复检查 `10.8.11.57:80`。可通过 `WECOM_RISK_INTRANET_CACHE_TTL_MS` 调整。
2. **产品无关查询短路**：纯证券搜索和主体授信查询不再先加载完整产品列表，避免冷路径承担产品台账首次加载成本。
3. **Health 写盘退出关键路径**：风险选择/确认执行前后的 health 更新改为异步触发，原子文件写入不再阻塞用户结果。
4. **PQ 日缓存首次 miss 去掉自身 JSON 重建**：持久化后直接使用独立对象副本，不再把刚取得的数据完整 decode 一次。
5. **PQ 进程内 L1**：在原 SQLite 日缓存之前增加有界 LRU（默认最多 16 项、按持久 payload 估算最多 64 MiB）。同一 bridge 进程中的重复读取直接返回独立深拷贝；自然日过期策略与 SQLite L2 一致。
6. **pandas 持久缓存编码 v2**：DataFrame 不再在 Python 层逐单元包装类型，而是用向量化 `split + dtype` JSON，并仅对 Decimal、日期、bytes、pandas null 等特殊值打类型标签。旧 `dataframe` 缓存格式继续可读，日内升级无需清缓存。
7. **提前预热**：风险 Python warmup 从“企业微信 authenticated 后”提前到 daemon 初始化阶段，与 Codex 和 WebSocket 启动并行；本地 Python 预热与内网 gate 解耦，VPN 未连接时仍先启动本地 bridge，产品预取和所有业务查询仍必须通过内网 gate；authenticated 时保留幂等重试。
8. **选择卡固定延迟降低**：默认从 800 ms 降到 200 ms，并增加 `WECOM_RISK_SELECTION_CARD_DELAY_MS` 配置项，减少确认链路固定等待。
9. **低敏性能观测**：bridge ready 增加 startup 分段 timing；正式测算返回顶层 `bridge_timings`，统计 submit/poll、选定后端函数窗口和 PQ hit/miss/backend 耗时。指标只包含标签、次数和耗时，不包含 SQL、产品、证券或业务结果。并发请求下函数/PQ明细标记为 `process_aggregate_window`，不得误作单请求独占归因。

## pandas 缓存微基准

使用同一台 Mac mini、同一 Miniforge Python，对 2,000 行 × 8 列整数 pandas DataFrame 做相同 encode/decode 测试。该测试只衡量本地缓存编解码，不代表真实 PQ、企业微信或正式测算耗时。

| 指标 | 修改前 | 修改后 | 变化 |
| --- | ---: | ---: | ---: |
| encode + outer JSON | 3000.187 ms | 13.238 ms | -99.56% |
| decode + outer JSON | 61.790 ms | 19.838 ms | -67.89% |
| payload | 320,448 bytes | 102,254 bytes | -68.09% |
| deepcopy（参照） | 0.181 ms | 0.136 ms | 样本噪声，不作结论 |

50,000 × 8 的旧编码路径在超过 50 秒后仍未完成，测试被主动停止；该结果仅说明旧的逐元素递归编码存在明显规模效应，不用于推算线上耗时。

## 风险 Python 冷启动发现

早期隔离诊断曾检查 `/Users/guanglin/Documents/trae_projects/icube/bin/python`，该路径的启动表现异常；但部署前现场核验确认，**当前目标 WeCom 实际并不使用该解释器**。当前 `WECOM_RISK_PYTHON` 为 `/Users/guanglin/.lark-channel/releases/wecom-risk-20260908-40e196ce3872/python-runtime/bin/python`，因此不能用早期 icube 探针推断生产 cold start。

r3 实际单实例启动后，新的 bridge startup timing 已落盘：`total_ms=972.902`，其中 `import_azpy_ms=958.222`、`pq_cache_init_ms=0.537`、`import_checker_ms=7.179`、`import_credit_ms=1.376`、`import_web_ms=5.580`。这表明当前生产 runtime 的本地 Python/模块初始化约 1 秒，绝大多数时间在 `azpy` import，而不是此前隔离探针所见的几十秒。

## 观测设计

新增 startup timing：

- `import_azpy_ms`
- `pq_cache_init_ms`
- `import_checker_ms`
- `import_credit_ms`
- `import_web_ms`
- `total_ms`

新增正式测算 bridge timing：

- `total_ms`
- `submit_ms`
- `poll_ms`
- `functions.resolve_product`
- `functions.latest_holding_date`
- `functions.fetch_holdings`
- `functions.run_pretrade_measurement`
- `pq.memory_hit / hit / joined / miss / error`
- PQ miss 的 `backend_ms`

正式业务结果继续位于原 `result` 字段，`bridge_timings` 为顶层诊断元数据，不进入风险结论计算。

## 当前验证

第二批完成后的专项检查：

- Python：当时共 32 项，其中 30 项通过、2 项按环境跳过；覆盖 L1 隔离、SQLite L2 重启读取、新旧 pandas 格式兼容、并发/取消和测算 batch。
- WeCom risk：第二批基础版本 216 项通过；针对“VPN 不通也先预热本地 Python”的最终增量修正后，18 个测试文件、217 项通过。
- TypeScript `tsc --noEmit`：通过。
- `git diff --check`：通过。

第二批基础版本的最终等价 `ci:local` 已通过：162 个测试文件、1198 项测试通过，另 1 项受控 benchmark 跳过；web build、TypeScript typecheck、server build 和 `git diff --check` 均成功，最终命令退出码为 0。最终 prewarm 增量修正另行通过 217 项风险专项测试、TypeScript typecheck、server build 和 `git diff --check`。

## 尚未完成的真实性能证据

历史 2026-09-08 真实样本中，热态正式测算约 2.5 秒，其中后端 coarse `setup` 约 2.37 秒；这批数据早于当前 PQ L1/codec 和本轮代码，不能当作当前 HEAD 的实测结果。

由于第二个独立 risk-service 进程无法在不共享生产运行态的情况下复现生产 warm 环境，本轮没有用失真的 side-process 秒数冒充真实 benchmark。r3 已具备记录 `bridge_timings` 的能力，部署结束时因内网不可达未取得测算样本。VPN 恢复后已完成独立常驻进程的真实后端对照，详见 `risk-live-performance-2026-09-10.md`；不是线上 PID 的企业微信完整链路测试。

## 候选部署与回退记录

- 部署前实际生产基线为 `wecom-risk-fallback-20260910-ddb99f6`，目标 WeCom PID `51951`，risk 子进程 `51964`；health 为 connected、`activeRuns=0`、`startingRuns=0`，任务账本只有 `done=97`、历史 `interrupted=2`，无 queued/running。Lark 基线 PID `36940`、runs=1。
- 第一份 candidate `wecom-risk-perf-20260910-78cdcac1` 因发布包漏带 `node_modules` 解析入口，启动时报 `ERR_MODULE_NOT_FOUND`（`@wecom/aibot-node-sdk`）。发现 crash-loop 后立即恢复切换前完整 plist，WeCom 重新 connected；Lark 未受影响。该失败日志保留。
- r2 补齐与既有稳定发布一致的 `node_modules -> /Users/guanglin/Sync/wecom-bot/node_modules` 后启动成功，但因 `IAMC-Office` 内网未连接，产品 warmup 在 TCP gate 前失败，暴露出“本地 Python 预热被网络 gate 阻断”的设计问题。
- 最终 r3 新增 `RiskDirectClient.prewarm()`：只启动本地 bridge，不绕过任何业务查询的内网 gate。风险专项增量验证通过后再次单实例切换。
- r3 当前 WeCom PID `64122`、runs=1，health connected、0/0；persistent risk Python PID `64125`，明确使用 r3 `risk-bridge/direct_bridge.py` 和既有生产 Python/state。Lark 始终保持 PID `36940`、runs=1。
- r3 LaunchAgent `ProgramArguments` 同时清理为标准两项 `[node, candidate入口]`，不再延续历史 plist 中累计的无意义旧脚本 argv。候选发布保留稳定 fallback plist 作为回退基线。

## VPN 恢复后的实测更新

已完成 before / r3 / 本轮 CPU 优化版三组各 31 次标准申购测算。r3 热态中位数 2867.137 ms，本轮优化版 1169.545 ms，减少 59.21%；93 次业务结果哈希一致。实际热态热点为反复进行的产品名称标准化和文本清洗，而非旧样本的 setup。本轮新增有界纯字符串缓存及 worker/限额阶段 timing 修正，生产 Python 的 40 项测试全部通过，WeCom risk 217 项、typecheck 通过。

本轮 CPU 优化尚未部署，线上仍为 r3；买入/查询扩展专项及多账户并发未验收。方法、冷态限制与证据详见 `risk-live-performance-2026-09-10.md`。

## VPN 恢复前的历史阻塞

`endpoint-vpn --json doctor` 当前显示服务、路由和配置前置条件均 ready，但 `IAMC-Office` 状态为 `Idle`；对 `10.8.11.57:80` 的独立 TCP 检查在约 `1502.7 ms` 后超时。r3 因此可以完成本地 Python 预热，但产品预取按设计返回“公司内网不可用”。尝试从当前自动化会话执行 `endpoint-vpn connect` 时，CLI 以 exit 2 明确要求在交互终端输入 OTP；未修改 VPN 状态、路由或其他代理设置。

在内网未连接时不绕过 risk gate，也不把历史测算结果当作 r3 benchmark。下一步应在 `IAMC-Office` Connected 后，用同一批准的模拟场景连续采样，核对业务结果一致，再按 `bridge_timings` 判断实际瓶颈：若 PQ 已主要命中 L1 但 `setup` 仍占主导，继续评估 snapshot/latest-date 缓存；若 `pq.miss.backend_ms` 占主导，优先数据访问；若并发窗口显著重叠，再做 concurrency=1/2/4 对照，不直接提高 worker 数。
