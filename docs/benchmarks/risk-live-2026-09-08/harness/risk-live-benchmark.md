# 真实风险客户端 benchmark

默认仅做真实产品查询，不使用替身、不连接机器人平台、不写交易/业务台账。固定两个checkout的HEAD并检查src无修改、锁文件一致。依赖安装和完整CI必须先完成，采样时不要同时运行构建/测试。

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/opt/node@24/bin/node docs/benchmarks/risk-live-2026-09-08/harness/risk-live-benchmark.mjs \
  --root /private/tmp/wecom-live-20260908 \
  --python /Users/guanglin/Documents/trae_projects/icube/bin/python \
  --service /Users/guanglin/Sync/risk-service \
  --data /private/tmp/wecom-live-20260908/data-versions.json \
  --out /private/tmp/wecom-live-20260908/NEW-UNUSED-DIRECTORY \
  --samples 30 --cold 3
```

`--only-distinct-products`单独跑8个不同产品的限制查询（30配对默认），产品列表暖机另计。`--only-distinct`单独跑8个不同证券候选查询。两者不能用不同业务的时延直接比较，只用于各自before/after对比及请求合并范围核验。

`--securities`增加重复证券代码查询、8并发同查询、8并发不同查询。证券代码来自既有报告/回归用例，产品不依赖用户输入。必须可只读访问后端Pins/数据库；受限网络可能把权限错误呈现为Pin不存在，应先确认连通性，不能直接认定数据缺失。

每对样本AB/BA交错。首次进程场景为独立Python/state；不清除共享生产缓存，因此不是数据库冷缓存测试。暖查询使用持久客户端；并发miss场景仅清除新版client自己的lookup缓存，以观察在途合并。调用原方法做薄层计时，不改变返回值。backendRequests是客户端call方法调用数，不是数据库SQL执行次数；有缓存时为0。未观测阶段为null，无法证明具体数据库初始化耗时。

输出目录拒绝复用：`samples.jsonl`、`pairs.jsonl`、`summary.json`及隔离bundle/state。结果只保存完整查询结果SHA256，不保存产品清单、候选明文或持仓。业务哈希不同或任一版本失败立即停止后续配对；已记录失败保留，汇总N/成功率/median/nearest-rank P95，失败单列。P95在小样本时仅供参考；减幅=1-after median/before median。暖机样本单列，不并入正常场景。

## 可选真实AI与本地确认链路

复制`risk-live-benchmark.example.json`到验收目录填写私有用例，通过`--cases /absolute/private-cases.json`加载。不要把填写后的文件或原始提示词提交Git。`approvedForLocalCalculation=true`表示该用例已明确授权本地模拟确认并执行只读测算；不是平台用户点击确认的证据。

必须填写同一真实AI模型、Codex二进制和工作目录，并预先准备两个隔离的Codex home，具有相同认证/配置/规则，分别填入`ai.codexHomes.before/after`；不允许把共享home作为运行状态目录。认证文件仅放验收目录并保护权限，不能提交Git。启动前核对配置一致性。本工具不自动复制凭证或修改共享配置。

链路复用各版本的CodexAdapter、RunExecutor、startWeComAgentRun及原意图prompt/parser。新版使用resolveInitialRiskIntent；旧版使用真实AI再normalizeRiskDraft。候选回复由selections提供明确产品名/证券代码（不是UI序号）；corrections逐项走简单修改或真实AI回退。每次确认前严格核对expected的规范化交易输入（product/type/market/amount或quantity，以及适用的days/securityCode），零数值容差；未解析为confirm就拒绝测算。新版executeConfirmed；旧版canonicalCommand进入原Router。调用真实calculatePretrade并对结果result除顶层timings之外的完整语义JSON做哈希，展示markdown哈希单列。不剔除业务字段以强行通过。

`--preflight-only`只打包并加载两个版本入口，不查询、不调用AI。它不验证用例、模型权限或业务日期。真实AI发送仍待明确授权；纯客户端正式测算已经独立运行。准备阶段是含AI和lookup的总时间，阶段有重叠不可相加；展示/排队不能可靠分离时为null。失败样本的AI次数若未能收集写null，不能按0解释。

两个固定bridge没有将测算date传入后端，工具没有篡改这一行为。即使声明了Pin版本，仍不能声称持仓日/NAV/行情已冻结；交易完整验收必须先解决快照约束或逐项确认数据未变化。本地确认链路调用实际卡片与任务注册表，校验会话不匹配、无效选项、重复确认与过期；它不等同于真实平台回调。真实超时/排队取消由另一个 risk-live-lifecycle.mjs 验证，不能据此宣布平台矩阵通过。

## 不调用 AI 的真实正式测算

`--calculation-cases /absolute/private-cases.json --only-cases --samples 30 --cold 0` 使用 cases[].expected 直接调用实际客户端 calculatePretrade。此模式不经过意图或确认链路，不发送模型请求，必须单独报告。cases 可指定 samples 和 freshClient。每次真实调用次数、业务结果哈希、后端返回日期、基准 metrics 哈希和后端运行 ID 哈希均记录；运行 ID 哈希不进入业务一致性比较。

业务结果仅排除顶层 `$.timings`，其余数值、阈值、状态、提示和输入保留严格比较；展示哈希单列。`dataDate` 和 `baselineMetricsHash` 与实际返回值核对，变化即停止；它们是观测一致性，不代表冻结共享数据库。`baselineHash` 可选，包含 before.status_counts，可能因动作检查范围不同而不同，不能跨不同动作共用这一整体哈希。
