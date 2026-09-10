# Risk 实测与 CPU 热点优化（2026-09-10）

## 结论与状态

已完成三组各 31 次真实后端测算。以 r3 为比较基线，新增 CPU 优化版热态中位数从 2867.1365 ms 降到 1169.5445 ms（减少 59.21%），P95 从 3092.364 ms 降到 1237.599 ms。三个版本的 93 次标准申购测算业务结果哈希一致。

**本轮 CPU 优化尚未部署。** 线上仍是 `wecom-risk-perf-20260910-f69e76dd-r3`，WeCom PID 64122 / runs 1，risk 子进程原为 64125；Lark PID 36940 / runs 1 未变化。本轮未重启服务、提交、推送、下单或发送企业微信测试消息。

## 方法与可比范围

使用与线上相同的生产 Python、同一 risk-service 后端和真实数据库，通过现有 direct_bridge JSON-lines 接口执行已批准的固定单账户标准申购模拟。每个版本使用独立常驻进程及私有状态目录；PINS、行情缓存取自相同生产目录副本，PQ SQLite 缓存在每组开始时为空。没有读取或复制凭证配置，没有覆盖生产缓存或账本。

每组 31 次：首次单独列示，后续 30 次计算热态中位数及 nearest-rank P95。按 before → r3 → 新版顺序运行，并非随机化交错试验。没有将 profiler 下的耗时混入速度统计。P95 为这 30 个样本的经验分位数，不是服务 SLA。

范围是**真实后端测算 + bridge 请求返回**，不是从用户发送企业微信消息到收到卡片的完整体验；不包含自然语言解析、TypeScript 查询缓存和卡片网络发送。固定申购场景没有买入证券，禁投、关联方、授信买入检查阶段为零；不能把此收益外推为所有证券买入或多账户场景的收益。

实际数据日期在三组均为 2026-09-09。每次均得到 success 和新 run ID，未复用最终测算结论。业务哈希对 result 内容做键排序，仅剔除 timing 诊断字段，保留金融结果、规则比较、日期和问题清单。

## 结果

| 指标 | 优化前 bridge | 已部署 r3 | 本轮 CPU 优化版（未部署） |
| --- | ---: | ---: | ---: |
| 样本数（首次 + 热态） | 1 + 30 | 1 + 30 | 1 + 30 |
| 请求热态中位数 | 2795.359 ms | 2867.137 ms | 1169.545 ms |
| 请求热态 P95 | 2957.502 ms | 3092.364 ms | 1237.599 ms |
| 首次请求 | 21456.848 ms | 16164.093 ms | 20338.734 ms |
| 后端 end_to_end 热态中位数 | 2586.5 ms | 2634.5 ms | 922.0 ms |
| setup 热态中位数 | 17.0 ms | 16.0 ms | 12.0 ms |
| 规则和持仓阶段热态中位数 | 236.5 ms | 241.5 ms | 112.0 ms |
| 场景处理热态中位数 | 143.0 ms | 147.5 ms | 122.0 ms |
| 限额计算阶段热态中位数 | 2171.0 ms | 2226.5 ms | 667.5 ms |
| 每组唯一 run ID | 31 | 31 | 31 |
| 全部业务结果一致 | YES | YES | YES |

r3 在这轮固定热态场景中没有测到明显收益；其中位数反而比 before 高约 2.6%，不将该小幅差异单独归因为代码回退。r3 的 PQ L1 确实命中，但该场景的热态 PQ 消耗已很小。

**首次测算仍未解决。** 本轮 CPU 优化版首次约 20.34 秒，setup 14.655 秒，其中产品解析约 6.388 秒、最新持仓日约 8.268 秒；PQ miss 的 backend_ms 累计约 10.91 秒。首次每组只有一个样本，网络/数据读取波动明显，不宣称冷态提速，也不清空生产缓存来强行制造冷态。

## 真实 CPU 热点

在独立诊断进程对实际 `pretrade_scenario.run_pretrade_measurement` worker 做 3 次 cProfile；这些结果只用于定位热点，profiler 耗时不用于上表。

一个热态 profile 的主要调用数：

- `normalize_product_name`：275,945 次。
- `clean_text`：475,672 次。
- `canonical_product_name_for_holding`：12,530 次。
- 正则 `sub`：749,989 次。

别名匹配、持仓分组和测算前后两次核查反复转换同一批名称。此次热态瓶颈是 CPU 重复工作，不是历史样本中约 2.37 秒的 setup。当前 setup 已约 16 ms，继续针对它盲目增加数据缓存收益有限。

## 已实现改动

`src/wecom/risk/direct_bridge.py` 新增 `memoize_short_text` 与 `install_text_memoization`，仅对已检查为纯输入转换的 `clean_text`、`normalize_product_name` 使用有界 LRU。

每个函数最多 4096 项，且只缓存长度不超过 256 字符的精确内置 str。非字符串、字符串子类、可变对象、超长字符串继续原样调用原函数。异常不缓存。字符串返回值不可变，缓存不涉及持仓、评级、规则、日期、行情或风险结论。

不缓存 `canonical_product_name_for_holding` 的结果，保持可变别名映射的更新可见。保留原始函数实现及 callable 元信息，安装操作幂等。

同时修正 profiling 挂载位置：实际测算函数位于 `web.pretrade_scenario`，而非 `web` 的直接属性。补充 `limit_prepare`、`limit_evaluate`、`limit_pair` 耗时。函数/PQ 明细仍为 process_aggregate_window；并发时不可视为请求独占时间，各层嵌套时间不可相加。

## 验证

- 实际生产 Python：40 项 Python 测试全部通过，无跳过；包含 pandas 与 Polars 缓存兼容测试。
- 新增 8 项纯文本缓存回归：精确输入、可变值、字符串子类、大字符串、容量/淘汰、异常、并发、别名更新及元信息。
- WeCom risk：18 文件，217 项通过。
- TypeScript `tsc --noEmit`、`git diff --check`：通过。
- 未重新进行全库 build 或改动共享 dist；不将之前全量 CI 的结果当作本轮重新执行。

## 证据与复现

私有证据目录：`/private/tmp/wecom-risk-standard-input-CxXhJY`。包含 benchmark.cjs / memo.cjs、各组 summary、raw 样本、独立 cache 和诊断 profile；目录权限为 0700，结果文件为 0600。临时目录可能被系统清理。所有原始业务 payload 均保留在该目录，不进入仓库。

Git 基线仍为 `ddb99f650394e470c56bc214d77ec6b1af6adf9c`，有未提交改动。本轮 CPU 优化 Python bridge SHA-256：`cce6da1375c782050c3fe830ab3ac900e7ad4f713b0d06a1507f7ec282f5c389`。线上 r3 bridge SHA-256：`6ef23820198c3285e707fd5411ad5e11c1e41d37b18c9d08bf378a8c093f7d16`。

risk-service 及 linked_sources/portfolio_limits 当前不是可查询 Git HEAD 的仓库，因此此处不虚构后端 commit。测试使用同一实际后端目录；本轮未修改该目录源码。

## 未完成的验收

买入/持仓/证券搜索/授信扩展驱动的准备调用被平台安全检查阻止，未运行；不能用上述标准申购结果替代这些专项验收。多账户 concurrency=1/2/4 对照及企业微信原生客户端完整链路测试也未执行。

后续发布候选前应保留本轮对照证据、补足相关业务场景，再做仅 WeCom 的受控切换；当前线上 r3 不因本轮基准而自动替换。
