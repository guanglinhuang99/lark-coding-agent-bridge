# 渠道无关的风险业务核心

适用范围：本仓库现有 `/测算`、`/授信` 和相关风险查询。飞书会议、普通编程对话及渠道原生导航不属于风险业务模块。

## 单一实现

```text
飞书消息 / 文本选项 ── src/bot/risk-adapter.ts ──────────┐
                                                     ├─ createRiskBusinessRuntime
企业微信消息 / 卡片 ── src/wecom/cli.ts + interaction.ts ┘   ├─ RiskApplication
                                                         ├─ RiskDirectClient → 同一业务后端接口
                                                         └─ 只读 Codex 意图解析 / 共享执行器
```

`src/business/commands.ts` 定义业务命令语法。`src/business/risk/application.ts` 统一业务分发、会话延续、修正、选择、确认和取消。解析、金额换算、查询路由及结果格式位于同目录；业务代码不得导入聊天 SDK 或渠道目录。

`src/runtime/risk-business.ts` 是两渠道的公共装配入口，统一客户端、应用、按需意图解析、预热、指标和关闭。`start()` 合并同时发生的预热请求；失败后下一次连接事件可以重试；`close()` 为终止操作，关闭后不会重新启动。

渠道仅提供可信身份、权限判断、消息/附件元信息和结果展示。企业微信的 starting/started/settled 回调只更新控制界面的任务显示，不决定业务规则。旧 `src/wecom/risk/` 路径中的兼容导出不是另一份业务实现。

新增业务能力应修改公共命令解析及应用/服务，并使用既有 RiskReply 类型返回 notice、intent、result 或 pages；这类能力不应在两渠道分别实现。新增原生交互形式仍需相应展示适配。架构测试和双渠道合同测试必须一起维护。

## 身份、状态与确认

共享代码不意味着共享权限或会话。会话键包含渠道、机器人/实例、聊天范围、用户和工作区。企业微信消息在渠道应答和排队前捕获 RiskIngress，确认只能作用于捕获时的草稿；旧卡片和更换后的草稿不能互相替代。飞书通过公共应用处理文本确认。

修改交易即撤销旧确认；修改失败不能继续执行旧稿。状态读取直接核对截止时间，不依赖定时器及时触发。关闭/停止禁止继续生成业务状态或正常展示迟到成功结果；已提交给后端的只读操作不保证可以物理中断。

两个进程分别拥有内存缓存。共用实现和预热策略不保证网络、渲染或端到端耗时相同；更新后必须把相同候选提交部署到两个实例才会生效。

## 配置

以下均为配置名称，实际值应保留在本机受控配置中，不写入 Git、命令历史或报告。

| 配置 | 含义 |
| --- | --- |
| `RISK_PYTHON` | 现有可用 Python 可执行文件的绝对路径 |
| `RISK_SERVICE_DIR` | 已安装业务后端目录；后端不是本包内置数据服务 |
| `RISK_STATE_DIR` | 业务运行态目录；默认放在各实例状态目录下，测试不要指向生产状态 |
| `RISK_BRIDGE_PATH` | 可选桥接脚本覆盖；安装包默认使用 bundle 旁的 `risk/direct_bridge.py` |
| `RISK_PREWARM` | `0` 关闭主动预热，`1` 开启；仍受渠道权限启用条件控制 |
| `RISK_DIRECT_WORKERS` | 业务桥接并发工作线程，默认 4 |
| `RISK_INTENT_MODEL` | 风险解析模型，不等同于普通聊天模型 |
| `RISK_INTENT_TIMEOUT_MS` | 解析时限，默认 180000 |
| `RISK_INTENT_EXIT_GRACE_MS` | 正常结束后等待进程退出的时限，默认 5000 |

企业微信在公共工厂中指定 `legacyPrefix: WECOM`，继续接受对应 `WECOM_RISK_*`；建议逐步迁移为统一的 `RISK_*`，不要同时配置互相矛盾的值。

权限不跨渠道继承：企业微信沿用 `USE_ALLOWED_LIST` 和 `WECOM_RISK_ALLOWED_USERIDS`；飞书使用 `LARK_RISK_ALLOWED_USERIDS`，并继续执行已有聊天准入及群提及策略。飞书默认没有允许用户时拒绝风险调用，不能用企业微信用户 ID 代填飞书 ID。不要为测试扩大允许名单或关闭权限检查。

飞书启动并不会自动读取企业微信的 `.env`。必须确认飞书实例实际获得了公共配置；仅在另一个渠道的配置文件中添加 `RISK_*` 不代表飞书已配置。

业务后端 `risk-service` 当前是仓库外部链接。Git 提交保存链接，不保存后端代码、数据库、Python 环境或凭证。旧后端可以工作但不一定具备优化能力；运行进程的 `businessCapabilities` 才是已加载能力证据，文件存在不等于能力已启用。

## 候选验收顺序

先固定提交，在独立目录构建两个入口。复用已安装依赖不等于重新验证锁文件安装；不得复制整个工作目录或私有 `.env`、缓存和状态到候选包。

候选必须记录 source_commit、两个 bundle 与 Python 桥接脚本的 SHA-256、Node 版本、业务后端版本/路径及测试状态目录。使用当前提交的构建，不复用历史 v0.8.5/CPU 候选包充当本次构建。

双渠道原生验收前必须有明确的测试机器人/会话及配置。没有独立测试身份时，不得启动第二个同身份连接；应等待获授权的维护窗口。`start --all` 只启动停止的服务，不会自动把运行中的旧版本升级为候选版本，也不能用作本次生产切换捷径。

| 验收项 | 必须记录的行为 |
| --- | --- |
| 标准查询与授信 | 两渠道进入公共服务，结果一致；不进入普通 Agent |
| 测算与确认 | 先显示摘要，明确确认后执行；重复确认不重复测算 |
| 修正及候选选择 | 成功后确认新稿；失败不能执行旧稿；旧卡片不可复用 |
| 排队与停止 | 提前确认不能绑定新稿；停止后排队任务不再启动 |
| 用户/工作区隔离 | 非发起人或新工作区不能确认原稿 |
| 过期与长结果 | 过期立即失效；长结果分页完整，核对最后一行 |
| 断线重投和退出 | 同消息只执行一次；退出不遗留本运行时进程 |

每项注明 PASS / FAIL / NOT RUN。真实消息收发、业务后端调用和离线模拟分别记录，不能互相替代。只读/模拟数据验收也需限制账户、样本和次数；不创建真实交易，不在 Git 保存原始金融结果。

目前没有获准执行生产切换。发布前还需独立代码审查、GitHub 检查以及原生双渠道验收；提交、推送、合并、发布和重启是不同阶段。

## 本地验证

```sh
node node_modules/vite/bin/vite.js build web
node node_modules/vitest/vitest.mjs run --reporter=dot --silent --maxWorkers=2 --minWorkers=1
node node_modules/typescript/bin/tsc --noEmit
node node_modules/tsup/dist/cli-default.js --out-dir <隔离候选输出目录>
git diff --check
```

构建和测试应在隔离目录进行，不能覆盖生产正在使用的 `dist`。历史验证记录参见 `SHARED_BUSINESS_CORE_ACCEPTANCE_20260911.md`、`SHARED_BUSINESS_CORE_REVIEW_20260911.md` 和 `SHARED_BUSINESS_RUNTIME_ACCEPTANCE_20260911.md`，各自只证明其记录的版本与范围。
