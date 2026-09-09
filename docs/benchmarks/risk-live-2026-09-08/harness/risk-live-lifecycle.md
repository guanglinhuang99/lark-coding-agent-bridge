# 真实风险桥接生命周期验收入口

`risk-live-lifecycle.mjs` 是独立的本地验收入口。它固定检查 after checkout 的
`6d28a6a673b3d400f3d30e15018b5a5621d545cf`，从该 checkout 打包
`RiskDirectClient` 和 `RiskProgressRelay`，并通过固定的
`src/wecom/risk/direct_bridge.py` 调用真实 risk-service。它不连接企业微信，不启动
任何 Bot，不发送消息，也不执行交易或修改业务台账。默认的后端查询只有真实的
`list_products`、`search_securities` 和桥接 `ping`。

先在没有测试/构建/负载并行运行的窗口执行。输出目录必须是新的验收目录；脚本会写入
脱敏的 `environment.json`、`samples.jsonl`、`events.jsonl`、`protocol.jsonl`、
`raw-protocol.jsonl`、`summary.json`，以及运行时 bundle、wrapper 和隔离 state。
查询内容只以 SHA256 哈希记录。原始 bridge 协议请求有独立的 watchdog（max(wait-ms, 请求 timeout 加 5 秒)，默认至少 180 秒；排队过期回包要等实际占位调用结束，不能用 100ms 过期阈值限制观察窗口）；
桥接 child 的 EOF/退出会拒绝全部未完成 Promise，关闭超时会升级终止这个验收器自己创建
的 child，避免失败时静默挂起。

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/opt/node@24/bin/node \
  docs/benchmarks/risk-live-2026-09-08/harness/risk-live-lifecycle.mjs \
  --root /private/tmp/wecom-live-20260908 \
  --python /Users/guanglin/Documents/trae_projects/icube/bin/python \
  --service /Users/guanglin/Sync/risk-service \
  --out /private/tmp/wecom-live-20260908/lifecycle-<new>
```

默认依次运行五类真实/源码边界检查：

| 场景 | 证据与断言 |
| --- | --- |
| `fast-serial` | 在同一个真实 after bridge 中串行发送 8 个 `ping`，每个都必须回包；用于复核快速完成的 Future 不阻塞下一请求。它是 bridge admission 证据，不是 SQL 证据。 |
| `queue` | 用真实 `list_products` 占用单 worker；在它运行时提交一个短期限 `search_securities` 和一个随后取消的 `search_securities`。短期限请求应返回队列过期错误但没有进入 `DirectRiskService.call`；取消请求应无协议输出、无 backend.call 入口；该场景中任何 `search_securities` 入口都会使断言失败（避免参数哈希错配掩盖真实启动）；随后 `ping` 必须成功。若真实 blocker 没有超过期限，结果记为 `blocked`，不降级成通过。 |
| `timeout` | 用真实 `search_securities` 在单 worker 中运行，客户端以短 timeout 超时并发送同 id 的 cancel；跟随查询在前一真实 backend.call 结束后才能进入。断言包含真实入口、客户端 `direct-timeout`、cancel、backend 结束晚于 timeout、迟到终态不被客户端接受及跟随查询成功。后端没有协作取消 API，因此不声称数据库执行被中断。 |
| `close` | 用真实 `list_products` 进入 backend 后关闭客户端；关闭前 child 必须仍存活，pending 请求应以 `direct-process` 被拒，child 必须在 close 返回前退出；原始 child stdout 同时写入 `raw-protocol.jsonl`，用于观察关闭后是否有迟到终态，而客户端接受记录必须为空；新隔离客户端用真实 bridge `ping` 重新启动并回包。关闭会终止本验收器自己的 bridge child，无法从外部证明被杀进程中的后端调用是否继续。 |

`progress-contract` 只运行固定 after `RiskProgressRelay` 的源码契约检查：受控发送者在途时
调用 `finish()`，然后注入迟到进度，断言迟到内容不会出现在终态之后。它的结果标记为
`evidence: source-contract`，不能当作真实 risk-service progress、WeCom stream 或平台
收发验收。真实后端 `search_securities` 本身没有 progress 事件；若要补真实测算 progress，
应另行取得明确的只读测算授权并增加独立场景，不能用本契约测试代替。

可只运行指定场景，例如：

```sh
.../risk-live-lifecycle.mjs --scenario fast-serial,queue
.../risk-live-lifecycle.mjs --scenario timeout,close
.../risk-live-lifecycle.mjs --preflight-only --out /private/tmp/wecom-live-20260908/lifecycle-preflight-<new>
```

`--preflight-only` 只验证固定 checkout、源码无修改、Python 依赖并生成 bundle，不调用
risk-service。退出码为 `0` 仅表示所选场景全部通过；`1` 表示断言/脚本失败；`2` 表示
真实后端不可用或阻塞证据不足，或仍只有部分源码契约证据。只有
`summary.json` 中 `realLifecycleComplete: true` 且没有 `blocked/failed`，才可以把本地
生命周期三项视为完成；这仍不包含企业微信平台收发、真实 AI、人工确认或固定交易数据验收。

## 观测边界

脚本运行时生成的 `risk-lifecycle-observer.py` 导入固定 after bridge，并仅在
`DirectRiskService.call` 入口/出口记录方法名、参数哈希、线程 id、时长和结果类别。它不
替换风险服务方法，不注入延迟，不改变调度、取消或返回值。入口事件能证明请求进入
`DirectRiskService.call`，不能证明 SQL 语句数、数据库连接池状态或后端数据快照版本。

客户端侧增加运行时观测：记录送入 JSONL 的 request/cancel、客户端处理的消息类型，以及
child stdout 原始消息类型；不会把结果正文写入验收输出。close 场景使用原始 stdout tee，
因为 `RiskDirectClient.close()` 会先关闭自己的 readline；原始迟到终态可以出现在
`raw-protocol.jsonl`，但只有客户端处理记录才会影响 pending，验收要求关闭后没有被客户端
接受的终态，并检查 close 后 pending map 已清空。脚本同时记录 close 前 child 存活和
child exit 时序；产品 close 未能退出时，harness 只对自己创建的 child 做最终强制清理，
该情形不会被当作通过。

客户端与 Python wrapper 使用同一参数哈希约定：UTF-8、紧凑 JSON、对象键递归排序、SHA256；
没有把原始参数写入日志。queue 场景还对同方法的全部入口做零计数断言，因此哈希不匹配时
会失败而不是把真实启动误判成未启动。每次场景使用独立 state directory；脚本拒绝继承已有
`POST_TRADE_HISTORY_DB`、`PORTFOLIO_MARKET_CACHE`、`PINS_CACHE_DIR` 或 `PINS_DATA_DIR`，
避免把验收状态混入共享目录。

`lifecycle-live-2` 是 watchdog、原始 stdout tee 和强化断言加入前的原始运行产物，必须保留
并单独标注其证据边界；修改后的 harness 尚未由本文件声称已重新运行。
