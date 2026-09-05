# Codex 验收交接：共享 Bridge Core

## 任务

验收 PR #11 的公共核心、共享会话/工作区存储、兼容迁移和入站可靠性改造。核心代码已实现，本任务不是重新规划或重复开发；发现缺陷时，在同一分支最小修复并补回归测试。

仓库：`https://github.com/guanglinhuang99/lark-coding-agent-bridge.git`

分支：`refactor/shared-bridge-core`

PR：`https://github.com/guanglinhuang99/lark-coding-agent-bridge/pull/11`

Mac mini 参考工作区：`/Users/guanglin/Sync/wecom-bot`

本轮可核验的代码检查基线：`697223252712ef7ea93caaed846a5abe1d7532b2`。

GitHub CI：`https://github.com/guanglinhuang99/lark-coding-agent-bridge/actions/runs/33971070521`

该基线的 macOS、Ubuntu / Node 20 已完成完整 Test、Typecheck 和 Build。其后架构文档及本交接文件的提交以 PR 最新 HEAD 为准，不能用旧 HEAD 的通过结果代替新修改后的复测。Windows 不作为本轮验收目标；不得宣称全平台通过或删除 Windows 检查。

## 安全边界

保留当前所有未提交修改；不使用 `reset --hard`、`git clean` 或强推。不要为切换分支覆盖不相关工作。仓库不干净时优先使用独立 worktree，记录它与原工作区的关系。

先检查是否已有线上 bot。自动化测试用临时配置、临时状态目录、临时工作目录及 fake SDK/agent，不能直接让第二个 bot 连接线上机器人身份。即使状态目录分开，相同机器人凭证的第二条真实连接仍可能影响线上连接。只有已有专门测试机器人时才直接联调；否则完成离线和进程级验收，并将真实客户端测试列为 BLOCKED，不自动停止线上服务。

不读取或打印 App Secret、访问令牌、Codex 登录文件、环境变量全量内容、真实邮件、OA材料或会话正文。测试报告只记录必要的脱敏状态与错误。不要将状态文件、备份、日志原文或敏感附件提交到 GitHub。

不得发送真实邮件、提交 OA、执行生产交易、修改投后数据库、发布 npm、合并 PR、创建 tag/release，或把测试分支直接部署为线上服务。

## 一、定位与基线

记录 `pwd`、`git status --short --branch`、`git remote -v` 和 `git rev-parse HEAD`。核对仓库及分支，不要误操作 web-cli 项目。读取根目录和适用目录的 AGENTS.md；不存在时如实注明，不创建无关文件。

安全 fetch 远端，使用本 PR 最新分支；不要重新从 main 创建另一套实现。记录 origin/main、PR HEAD、实际测试 HEAD。阅读 `docs/shared-bridge-core.md`，明确共享代码不等于共享进程、状态或跨平台会话。

## 二、完整自动化检查

使用项目 packageManager 指定的 pnpm 版本，按锁文件安装，不升级依赖。记录 Node/pnpm 版本。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

另外单独运行关键测试，便于定位：

```sh
pnpm exec vitest run tests/unit/bridge tests/integration/bot/shared-durable-channel.test.ts
pnpm exec vitest run tests/unit/wecom tests/integration/executor tests/integration/session tests/integration/runtime tests/static
```

不要通过删除用例、改成 skip、放宽安全断言或全局延长 timeout 掩盖回归。若测试 fixture 没有产生预期事件，应修复 fixture，而不是改变生产代码的成功判定。真实 agent 测试缺凭证时标记 BLOCKED，不伪造通过。

## 三、迁移和会话边界

全部用临时文件构造测试，不使用线上状态。

核实两侧实际调用同一 `ConversationState` / `conversationViews` 后端，而非仅移动旧文件。检查 Lark foreground 与 supervisor 均传入共享路径，重连复用 writer；WeCom 使用 `WeComConversationBindings`。

覆盖以下验收：

- 平台、账号、部署实例、会话 scope、Agent、canonical cwd、权限 fingerprint 任一不同，不自动恢复另一绑定。含分隔符和 `__proto__` 的输入不能碰撞或污染其他 namespace。
- Lark 有效 catalog、命名 workspace、会话 workspace 和 idle-timeout override 可以迁移；`/new` 保留超时偏好。仅含 sid/cwd 而没有权限证据的旧 fallback 不能绕过新目录/权限边界。
- 旧 WeCom thread map 没有 cwd/policy 证据，因此保留到 unverified 区，不自动续接。这是预期行为，不应把它“修复”为盲目绑定当前 workspace。新会话和用户明确 `/resume` 选择后形成的有效绑定可以正常恢复。
- 迁移前后旧文件字节内容不变，备份可读；重复启动不会再次导入旧数据。中断于备份后、最终提交前可重试；损坏输入不覆盖原文件，不建立伪正常状态。
- 切换配置账号后不能重新把旧文件导入新账号 namespace。首次迁移前必须确认目录属于当前配置账号，不能凭旧文件推断历史归属。
- Agent 运行期间改变 binding，迟到 thread ID 和附件路径仍归属运行开始时的目录；符号链接改指向不自动复用原线程。
- 写入失败通过 flush 可见，不能带着未持久化的配置继续启动受保护任务。恢复磁盘后可通过新的完整快照恢复。

新状态路径为 `${sessionsFile}.bridge-v2.json`；备份为 `${legacyFile}.pre-shared-${hashPrefix}.json`。新旧文件并存不表示双写；旧文件随后会变成历史快照。

## 四、消息去重、批次和异常恢复

对 fake channel 注入事件，验证实际生产入口，不只测独立模块。

Lark 同一消息并发两次/重复投递只入站一次；不同消息仍按原 debounce 合并，批次内正文不重复。来源消息回执与 Agent 批次记录分别存在，批次 ID 不随消息到达顺序变化。

重连或进程重启后，已完成或开始执行的来源消息不能静默重跑。仅 queued、尚未执行且满足恢复条件的消息可以在平台重投时重新入队；本地没有保存正文，不应声称能自主恢复队列。不同账号和实例的相同消息 ID 不互相去重。

启动批次前，所有来源回执应一次原子转换为 running。模拟 claim 写盘失败、并发重复 claim、批次写盘失败、运行状态写盘失败：没有确认持久化就不能执行，内存不能留下伪已接收状态。

覆盖 `/new`、停止操作和卡片触发的取消；取消的排队消息不得在重连后复活。WeCom 会改变会话或停止进程的命令应先标记执行开始，不能一直保留为 queued。存储不可写时只保留受限诊断入口，附件/普通 Agent 工作不得无保护绕过。

模拟执行成功后发送回复或附件失败：任务仍是已完成执行，不触发 Agent 重试，也不提示用户重复执行写操作。终态落盘异常必须有日志，但不应把已经发生的操作当成尚未执行。

任务 ledger 不包含原始消息 ID、prompt、附件正文、模型输出或凭证；不要把保存操作元数据说成保存全部输入或 exactly-once 远端事务。验证保留期/历史容量不会误清除正在排队或执行的记录。

## 五、并发、超时与进程

测试并发上限为 1 时，WeCom 整体任务与内部 Agent 共用有效 permit，不重复占槽或死锁。用例还应覆盖 FIFO、同会话互斥、准备失败、启动失败、退出清理失败、取消排队、重复 stop/release 与重连暂停。

超时测试要同时验证底层取消和迟到结果：OperationRunner 发出 AbortSignal，本地超时不自动重试；底层仍活跃时阻止同 operation key 的重叠调用；迟到成功不能关闭由超时打开的熔断。忽略 AbortSignal 的永久悬挂操作会保持 fence，这不是已经终止底层操作的证明。

WeCom 相同 state directory 的第二个新版本进程要被锁阻止；退出后可再次获得锁。不要误认为这是跨 bridge 的 Git workspace 写锁。Lark 的任务恢复必须在 runtime/profile 锁取得后执行，获取第二把锁失败时要释放已持有资源。

## 六、真实客户端测试（具备独立测试凭证时）

在不影响线上实例的独立测试环境验证：

1. WeCom 普通对话、第二轮续接、`/new`、`/resume`、stop、model/reasoning、`/runs`、`/doctor`，以及模板卡回调、文字降级。
2. 使用无敏感信息的小文件验证附件接收和生成文件回传；不要改用线上材料。
3. `/测算` 使用测试或只读风险服务，确认仍走原确定性快路径，不执行生产交易。
4. Lark 群聊、话题引用、连续消息 debounce、工作区绑定、会话恢复、配置变化、权限拦截和卡片回调。
5. 控制测试进程断连/重启：已运行任务标为中断，不重放写操作；诊断状态准确。需要杀进程时先严格确认 PID 属于专门测试实例，不使用广泛 pkill。

缺少独立测试机器人、网络、登录或风险服务时，明确报告具体 BLOCKED 条件。不能把 fake SDK 测试当成真实企业微信/飞书验证。

## 七、修复、报告与交付

发现本次代码缺陷，最小修复、增加复现用例、重跑相关用例和全量检查，然后提交到同一分支，不 squash/force-push 现有历史。没有必要的修复就不做额外重构。Windows 问题另列，不为它扩大本轮范围。

把脱敏结果写入 `docs/shared-bridge-core-validation-results.md`，包括实际测试 HEAD、环境、每条检查的 PASS/FAIL/BLOCKED、测试数和命令退出状态、真实/模拟测试的区别、修复提交、迁移/回滚结论及剩余风险。保留日志在测试环境，不提交原始日志或状态数据。

最后更新 PR #11 的验证信息，返回最终 HEAD、报告路径及是否建议合并。不要合并、发布或部署。

回滚测试仅针对专用测试实例：先停止新进程，保留 v2 状态、ledger、旧文件和备份，再验证旧版本读取历史文件。旧文件可能落后于新状态，任务回执不能随意清空。遇到已执行但结果不确定的操作，先查实际结果，不自动重新提交。
