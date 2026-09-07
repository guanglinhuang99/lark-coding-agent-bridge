# Codex 交接：企业微信附件修复部署与真实回传验收

## 目标与当前事实

在 Mac mini 的 `/Users/guanglin/Sync/wecom-bot` 完成 PR #12 的企业微信附件修复受控更新及真实客户端复测。不要再次规划架构，也不要重复做“临时 job 首次迁移”。飞书保持运行。

- 仓库：`https://github.com/guanglinhuang99/lark-coding-agent-bridge.git`。
- PR：`https://github.com/guanglinhuang99/lark-coding-agent-bridge/pull/12`；分支 `feat/dual-bot-lifecycle`。
- 已验收代码提交 `19b9f246e2aca4f6b46efa4751ad612abe5a114f`；含完整报告的基线 `db669b6d799dcb222fdcda1a5c98b2f79a7c9b1a`。本次后续提交仅为交接文档和合成样本。
- 本轮已将参考工作区从 `82ea0e4` 安全快进至 `db669b6`，未覆盖原有未跟踪 `.pnpm-store/`、`AGENTS.md`。这只是源码同步，不是部署。
- `db669b6` 的 GitHub push `34093855603` 和 PR `34093859334` 三平台六项均 SUCCESS；历史完整测试为 147 文件 / 1063 用例，不能冒充本轮新跑结果。
- 本轮 `npm run typecheck && git diff --check` 于 `2026-09-07T07:39:34Z` exit 0。MCPX 对服务状态查询、专项测试及隔离构建返回额外确认要求，命令未执行，没有新 PID 或平台连接证据。
- 已创建本机忽略文件 `.codex-handoff/tsup.wecom-attachment.config.ts`，只构建 WeCom、`clean=false`、输出 `.codex-handoff/wecom-attachment-db669b6`。配置尚未执行，不存在已验证新产物的结论；在其他 worktree 使用时须重新核对或自行建立等价配置，不依赖这个目录已同步。
- 企业微信持久 job 切换已有历史 PASS。当前部署仍未应用附件修复；源码 HEAD 和正在运行的程序版本必须分开记录。

本轮核验的共享构建 SHA-256（必须在执行时重新检查，不能盲用）：

```text
dist/cli.js   c88649741ece69d905a418c85fb3a5ddf32de604e7a7ebcd48be7eda5be89370
dist/wecom.js 088d4cb65aedb8ece84d9202df77e75a2e38cee3afe8e956c93861f001535633
dist/index.js 5f765804b81cb7acdb74631d27f54a6ec1cb0db99a411635e7908f26eb54530f
```

## 工作范围与停止条件

本交接只覆盖企业微信附件修复更新、必要的同 label 有序重载和既有测试私聊的合成附件验收。按当前用户指令和执行环境的审批机制操作；遇到真实权限拒绝或待确认，记录并停止对应步骤，不伪造授权、不更换工具绕过限制，继续无依赖的准备工作。

目标：`ai.wecom-channel-bridge.riskbot-codex`。飞书保护对象：`ai.lark-channel-bridge.bot.codex`。不要使用历史 PID 执行 kill，不运行 restart/stop --all，不修改其他 LaunchAgent。生产重复 start --all 的旧专项 BLOCKED 状态不自动转为已批准；不为本任务退出登录、重启机器或放宽 read-only。

保持 PR Draft，不合并、发布、创建 tag/npm 包，不开启自动合并。保留全部既有 staged/unstaged/untracked 内容；禁止 reset --hard、git clean、自动 stash、force-push 或批量暂存用户文件。

## 1. 核验代码、构建和现场状态

先阅读适用 AGENTS.md、`docs/dual-bot-validation.md` 最新追加章节、`docs/dual-bot-start.md` 以及本交接。不要按旧 `codex-dual-bot-acceptance.md` 中“生产未切换”的历史描述重做首次迁移。

记录实际 PR HEAD、工作树 HEAD、当前分支和改动。若 PR 在本基线之后仅新增文档/样本，可沿用已验证代码；若 src、bin、依赖、锁文件、构建配置已变，则重新审查和验证，不能自动部署未经检查的新 HEAD。

重新核验目标 label 对应的磁盘与已加载 ProgramArguments、Node、工作目录、env 引用、实际 stateDir、日志路径和 PID，输出只保留允许的路径与状态字段。不打印完整 launchctl environment、.env、token、App Secret、业务消息或状态正文。`--health` 必须对应目标实际配置，不把默认目录的另一个实例当成目标。

至少两次新鲜 health 确认 connected、activeRuns=0、startingRuns=0，同时核对任务账本 queued/running、正在收取附件或执行风险操作的任务，以及目标子进程。账本缺失、陈旧、不认识的 schema 或观测失败不是“零任务”。不能证明安全空闲时停止重载，不清空账本或强杀来制造空闲。

## 2. 隔离构建，不清理共享 dist

`tsup.config.ts` 使用共享 dist 且 clean=true；不要在生产目录直接运行 pnpm build、npm run build 或裸 tsup。优先使用已有干净验收 worktree；否则建立独立 worktree，冻结锁文件安装并隔离 HOME、状态和配置，不加载线上凭证，不连接第二个同身份 bot。

使用 package.json 指定的 pnpm 10.33.0。工具缺失时明确记录，不升级依赖或全局安装。相关测试：

```sh
pnpm exec vitest run tests/unit/wecom/egress.test.ts tests/unit/wecom/received-artifacts.test.ts
pnpm typecheck
```

在独立 worktree 按项目完整配置构建，或使用本机已备的 WeCom-only 配置构建至独立目录。后一方式只提供单入口产物，不冒充完整包构建。若复用现有产物，核验其来源 HEAD、依赖、入口和摘要，不能只依据目录名称认定已验收。

新 `wecom.js` 必须语法检查通过；确认其导入和资源依赖可由现有生产目录满足，特别是未分包产物与现有 node_modules 一致。记录新的 SHA-256，核验 src/cli、src/daemon、其他运行资源、package.json、锁文件及 bin 与已部署版本没有未经处理的变化。

## 3. 仅更新企业微信，并有回退依据

在仓库外私有目录保留当前 wecom.js、现有 plist 和必要配置/状态备份，目录 0700、文件 0600；不提交这些材料。必须记录最新会话与账本的保护方式。回退默认只还原程序，不用旧状态快照覆盖上线后产生的新会话或任务。

再次检查空闲与飞书 PID/runs、共享 cli.js/index.js 摘要。先正常卸载指定 WeCom job，等待 job 明确不存在且旧进程与必要子进程均退出；查询失败或超时不能当作退出完成，不使用 SIGKILL 强制推进。

旧进程完全退出后，原子替换且仅替换 `dist/wecom.js`，保留已确认的同 label 持久 plist、env、stateDir、workspace 和权限。随后 enable/bootstrap 该目标，禁止新旧同身份连接并行。不要重写其他产物、依赖或飞书 job。

若启动失败，在确认新 job 和进程已退出后恢复旧产物并重新加载原服务；不自动重放结果不确定的任务，不清空 ledger。无法安全回退时停止并如实报告。

## 4. 部署后运行验证

核对磁盘 hash 与部署产物一致、启动时间晚于替换、新 PID/参数、目标 health connected，以及活动/排队任务状态。多次间隔采样 PID 和 launchd runs，观察新日志段中的 unknown command、持续退出或连接反复重试；不要将整个历史错误日志作为“本次新增错误”。保存摘要，不提交原始日志。

飞书必须保持原 PID/runs，共享 cli.js/index.js 摘要不变。运行 status --all 只证明进程观察，不替代平台与客户端收发。记录观察时长和采样结果；不得声称长期稳定已验证。

## 5. 真实客户端附件复测

使用原生企业微信已有 `riskbot@codex` 测试私聊和原先批准的客户端操作能力。不能唯一确认会话或 UI 不可用时，标为 BLOCKED，不改发到其他聊天。不要用内部 API 假装用户上传，不启动第二个机器人实例。

测试文件已在仓库提供：`docs/fixtures/wecom-attachment/input.txt`，只有合成内容。计算上传文件的 SHA-256；保留原始字节和文件名，不让模型重新生成它。

1. 更新重启后重新通过客户端上传该文件，因为已接收附件来源记录是进程内的，重启后需要重新登记。
2. 发送“请读取 input.txt，只回答 case、value_a 和 value_b，不要回传文件”，确认内容读对且没有收到额外附件。
3. 在同一会话的下一轮发送“请把 input.txt 原样回传给我”。
4. 必须看到真实文件附件卡片，保存返回文件并比对 SHA-256/字节一致；文本“已回传”、Markdown 本地路径或只有发送计数均不能单独证明通过。
5. 新建测试会话后不重新上传，提出相同回传请求，确认不能借用上一会话的附件来源。原测试会话不删除；不能可靠定位恢复项时不要随意点击相似标题，保留 /resume PARTIAL。

只读模式下生成新文件的限制与原附件回传是两个问题。本任务不放宽 sandbox、不授予任意工作区外文件读取权。登录自启、系统重启后启动、实际回退演练和生产重复 start 的旧未执行项继续单列，不需要为了本附件修复补做。

## 6. 交付

在 `docs/dual-bot-validation.md` 追加真实执行记录，区分源码、构建、运行版本；逐项写 PASS/FAIL/BLOCKED/NOT RUN，记录目标 HEAD、bundle hash、PID、参数、采样时长、两个文件 hash 和飞书保护结果。保留所有历史记录，只提交脱敏报告及必要的最小修复到同一分支/PR，不合并或发布。

发现实际缺陷时先写复现测试再做最小修复，修复后补足相关及完整检查；新的代码部署要重新遵守上述安全边界。不把“完成测试”当成“生产已通过”。最后分别报告附件链路是否通过、PR 是否具备转 Ready 的条件，以及仍未完成的事项。
