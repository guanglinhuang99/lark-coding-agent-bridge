# Codex 独立验收：双平台启动与服务生命周期

## 目标与代码基线

仓库：`https://github.com/guanglinhuang99/lark-coding-agent-bridge.git`

分支：`feat/dual-bot-lifecycle`，目标分支 `main`。通过 GitHub 查询该分支的实际 PR 和最新 HEAD，不猜测 PR 编号，不用基线提交代替新 HEAD。

Mac mini 参考工作区：`/Users/guanglin/Sync/wecom-bot`。

实现基于 `2a5cfec78cfd605dbe9c908dd0ca63535c0bd972`，增加 macOS 的 `start --all` / `status --all`，并修复 launchd 状态误报和停止状态下 restart 不重建 plist。两个平台仍使用独立进程、配置、状态、会话和连接，不引入另一个常驻 supervisor。

这是独立代码审查和验收，不是再次规划或重写功能。发现本次引入的问题时，先增加复现测试，再做最小修复。不要增加 stop/restart --all 或扩大到跨平台统一服务重构。

## 授权与安全边界

本任务允许读取相关源码、在隔离环境运行测试、修复本 PR 缺陷、更新脱敏报告，并将相关修复提交/推送到同一个分支、更新同一个 PR。不得 force-push、合并 PR、创建 release/tag、发布 npm 或部署测试分支。

参考工作区有在线机器人从这里加载构建文件。默认使用独立 worktree 和临时 HOME、LARK_CHANNEL_HOME、WECOM_STATE_DIR、测试配置与工作目录；不要覆盖参考工作区的 dist、.env、配置或状态。只有确认没有冲突时才复用原工作区。

所有未提交、暂存和未跟踪内容必须保留。不要 reset --hard、git clean、自动 stash、删除分支或批量 git add。原有 .pnpm-store/、AGENTS.md 不属于本 PR。不得打印、复制入报告或提交 App Secret、token、Codex 登录文件、完整环境变量、真实消息/附件、生产状态文件或原始日志。

不自动停止、重启、卸载或重新注册线上机器人。线上标签仅为定位线索：

- `ai.lark-channel-bridge.bot.codex`
- `ai.wecom-channel-bridge.riskbot-codex`

历史 PID 不是操作依据，任何观察必须重新确认。离线测试只用 fake SDK/agent、fake launchctl 或明确专用的无凭证测试实例。不能让第二个实例使用相同线上身份连接，即使它使用独立状态目录。

## 1. 重建当前事实

记录 pwd、git status --short --branch、HEAD、origin/main、PR headRefOid 和实际测试 HEAD。核验仓库身份、读取 AGENTS.md 及适用目录指令。安全 fetch，不覆盖用户修改；独立 worktree 的修复须提交到本分支，不让另一份同分支 checkout 被强制覆盖。

阅读：

- `docs/dual-bot-start.md`
- `docs/dual-bot-validation.md`（已有结果是历史证据，不是独立验收结论）
- `src/daemon/bot-fleet.ts`
- `src/daemon/launchd-status.ts`
- `src/daemon/launchd.ts`
- `src/daemon/service-adapter.ts`
- `src/cli/commands/service.ts`、`src/cli/index.ts`
- `tests/unit/daemon/`、`tests/unit/cli/service-profile.test.ts`

## 2. 锁文件安装与完整检查

按 package.json 的 packageManager 使用 pnpm 10.33.0，不升级依赖或重写锁文件。优先使用环境已有 Corepack；如工具缺失，报告具体限制，不静默安装或变更全局环境。

```sh
corepack pnpm@10.33.0 install --frozen-lockfile
corepack pnpm@10.33.0 test
corepack pnpm@10.33.0 typecheck
corepack pnpm@10.33.0 build
git diff --check
corepack pnpm@10.33.0 exec vitest run tests/unit/daemon tests/unit/cli/service-profile.test.ts tests/unit/cli/kill-os-managed.test.ts tests/unit/cli/index-registration.test.ts
```

如 Corepack 不可用但项目依赖已齐，可明确记录并使用现有 npm 执行等价 Vite/tsup/Vitest 检查；这不等于重新完成锁文件安装验证。已有实现曾通过 144 个文件、1019 个用例；不要把它当作本次实际测试数量。

读取 PR 最新 HEAD 的 GitHub CI。新增 --all 功能范围是 macOS；Linux/Windows 原有单平台命令不能被破坏。分别报告各 CI 结果，识别测试 fixture 的操作系统路径假设。Windows 的旧失败与本次新增回归需区分，不删除矩阵或 skip 测试掩盖问题。

## 3. 必须覆盖的行为

1. 两边已运行：反复 start --all 不重新启动或更换 PID；status --all 无文件/服务变更。
2. 一边停止、两边停止：只启动需要启动的一边；分别 enable/bootstrap，无额外总控进程。用隔离后端或无凭证测试服务验证，不能为此停线上 bot。
3. 一边失败：另一边仍处理、不回滚或停止已运行服务；总体返回非零。覆盖配置阶段、enable、bootstrap、进程立刻退出及观察失败。
4. loaded 与 running 分离：spawn scheduled、无 PID、死 PID、嵌套 coalition/environment 的 state/pid 不能误报。launchctl 查询超时、权限错误等不能默认为确定的“服务不存在”。
5. restart：已加载崩溃 job 和未加载 job 都能使用正确修复路径；配置解析失败不写定义；卸载完成前不能 bootstrap；enable 失败不得继续；连接超时非零。
6. 并发与身份：两个 start --all 同时执行，bootstrap 竞争不能产生重复实例或杀掉成功的一方；同 label 的不同 env 文件不能因创建竞争而被错误接受。多个 WeCom 候选必须显式选择。
7. 定义保护：错误 Label、多余脚本参数、shell 包装器、符号链接、入口/Node 消失、配置路径变化均不覆盖用户定义。不能只依赖宽泛 basename 就误接管另一个服务。
8. 临时 WeCom job：存活时补建缺失持久定义也不卸载旧 job，不声称新参数已生效；只保留 env 文件路径引用，权限 0600，不写 Secret。
9. 配置保持：持久启动保留实际所需 PATH、工作目录、配置和状态目录语义；不要根据 env 文件位置猜 workspace 或静默使用另一身份。包安装入口与源码 checkout 的路径均需覆盖。
10. 原有 start/stop/restart/status/unregister、supervisor 和 kill 保护逻辑不得因 isRunning 改变而回归；CLI 冲突参数应在变更前报错。

不要削弱断言、删除测试、统一拉长 timeout 或盲目扩大功能来使检查变绿。若发现实现边界不满足已声明保证，明确列为 FAIL，最小修复后复测。

## 4. 真实部署验收是单独阶段

本任务默认不进入生产维护窗口。先交付离线/CI 验收结果和操作预案，不要循环向用户索取确认而停止其他可做工作。

现有报告记录：企业微信仍由旧临时 job 运行，新持久 plist 已创建，但新入口、日志配置、冷启动、登录自启未实测。不得把“plist 存在”或“进程存活”标为这些项目通过。

只有用户另行明确批准维护窗口后，才可核验活动与排队任务为零、同身份无并行连接，保留配置/状态/回退依据，卸载指定旧 WeCom job，等待 job 和进程完全退出，再从新持久定义启动；飞书保持运行。核对 loaded 参数、新 PID、health、日志、稳定性和无任务重放。不要清空 ledger 或自动重试执行结果不确定的写操作。

真实对话、追问、/new、/resume、安全停止、卡片回调和无敏感小文件回传也应单列结果。没有已批准的真实测试会话、客户端能力或凭证时标为 BLOCKED；fake 消息测试不能冒充真实验收。登录自启未操作则为 NOT RUN，不要求为本任务退出登录或重启机器。

## 5. 交付

在 `docs/dual-bot-validation.md` 追加“Codex 独立验收”章节，保留原历史记录，写清实际 HEAD、环境、命令/退出码/数量、每项 PASS/FAIL/BLOCKED/NOT RUN、真实与模拟边界、最小修复提交及剩余风险。只提交本 PR 文件；修复后重跑相关测试和完整检查，再推送同分支并更新 PR 描述或评论。不合并、不部署。

最终分别给出“代码/离线验收是否通过”和“生产切换是否就绪”，不能用一个 READY 混淆两者；附最新 HEAD、PR、报告路径以及唯一最优先的下一步。
