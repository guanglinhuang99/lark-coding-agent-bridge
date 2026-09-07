# 双平台启动与生命周期修复验证

## 代码基线与范围

验证日期：2026-09-07。机器：Mac mini / macOS。工作区：`/Users/guanglin/Sync/wecom-bot`。

基线 HEAD：`2a5cfec78cfd605dbe9c908dd0ca63535c0bd972`。

实现分支：`feat/dual-bot-lifecycle`。本报告记录初次验证时的基线 HEAD 加工作树补丁；当时尚未提交、推送或发布。随后整理为该分支的 PR，初次测试的时间与范围保持不变，实际验收以 PR 最新 HEAD 为准。没有改动 `package.json`、`pnpm-lock.yaml`；原有未跟踪 `.pnpm-store/`、`AGENTS.md` 保留，不纳入本轮提交。独立验收任务见 `codex-dual-bot-acceptance.md`。

本轮增加 macOS 的 `start --all` / `status --all`，复用独立的 Lark、WeCom OS job，不创建新总控进程。修复 launchd loaded/running 混淆、未加载时 restart 不重建定义，以及 enable/连接等待失败的结果处理。

## 自动化验证

MCPX 的执行环境未提供 pnpm 命令；没有安装全局工具或更改项目指定的包管理器。使用已安装依赖执行等价的构建步骤。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS，exit 0 |
| `npm run build:web` | PASS，Vite 构建成功 |
| `npm exec --offline -- tsup` | PASS，CLI、WeCom、库入口与声明文件构建成功 |
| `npm exec --offline -- vitest run` | PASS，144/144 文件，1019/1019 用例，exit 0 |
| `git diff --check` | PASS，exit 0 |
| `git diff --cached --name-only` | 空；没有暂存任何文件 |

初次完整类型检查、构建、测试及 diff 检查命令链于 `2026-09-07T05:03:58Z` 结束，exit 0。源码与测试在该命令前已完成；截至本报告整理入 PR，后续变更仅为说明、验证记录与独立验收交接。后续验收或修复应追加记录实际测试 HEAD，不能沿用本次通过结果。

新增回归覆盖：外层 launchd 状态解析、嵌套环境/coalition 不误判、PID 存活检查、停止后的定义重建、配置解析失败不写服务文件、卸载/enable/bootstrap 顺序、连接超时非零、双平台重复启动、部分失败隔离、临时 job 不重复拉起、配置冲突拒绝、符号链接拒绝和只读 status。后端用假的 launchctl、文件系统和 PID 检查验证副作用，不操作实际测试 LaunchAgent。

## 提交前复核

2026-09-07 整理 PR 前重新执行 `npm run typecheck && npm run test:unit && git diff --check`，于 `2026-09-07T05:26:07Z` 结束，exit 0；100/100 单元测试文件、745/745 用例通过。本次没有改变生产源码或测试逻辑，只补充交接和文档，不重启机器人、不修改 LaunchAgent。该结果不替代后续 Codex 在 PR 最新 HEAD 上的独立验收；此前完整回归仍为上节所记的 144 文件、1019 用例。

## 当前机器的无中断验证

目标只限：

```text
ai.lark-channel-bridge.bot.codex
ai.wecom-channel-bridge.riskbot-codex
```

本地最新 CLI 的 `start --help` / `status --help` 均包含 `--all`。多次执行 `start --all --profile codex` 和 `status --all --profile codex` 均 exit 0，无 stderr。没有通过全局旧 CLI 调用。

| 项目 | 实际观测 |
| --- | --- |
| 飞书 job | running，PID 36940，runs=1 |
| 企业微信 job | running，PID 7807，runs=1 |
| 重复启动 | 两边 PID 和 runs 均保持不变，没有重启 |
| 初始无配置参数的重复启动 | 两个目标服务定义的存在性/摘要前后不变 |
| 飞书 `status --profile codex` | exit 0，识别到 codex bot 注册，PID 36940 |
| 企业微信 `--health` | exit 0，healthy=true，reason=ok；PID7807、phase=connected、connected=true、activeRuns=0、startingRuns=0 |

WeCom health 的心跳时间为 `2026-09-07T05:05:25.902Z`，采样时 ageMs=25021。以上是采样时的进程/健康证据，不是永久在线保证。没有读取 env 文件正文或把原始健康错误、凭证、会话正文写入报告。

## 企业微信持久定义

发现的现有 WeCom job 是 `launchctl submit` 提交的临时 job：没有对应磁盘 plist，stdout/stderr 指向 `/dev/null`。只从已加载启动命令提取并核验了配置文件路径和入口路径，没有打印原始 shell 命令或凭证。

已执行：

```sh
node bin/lark-channel-bridge.mjs start --all --profile codex \
  --wecom-service ai.wecom-channel-bridge.riskbot-codex \
  --wecom-env-file /Users/guanglin/Sync/wecom-bot/.env
```

命令 exit 0，仅补建缺失的 `~/Library/LaunchAgents/ai.wecom-channel-bridge.riskbot-codex.plist` 和对应日志目录，没有改写飞书 plist。实际 `plutil -lint` exit 0，文件权限 `0600`，Label 匹配。

新定义中的 ProgramArguments：

```text
/opt/homebrew/Cellar/node@24/24.19.0/bin/node
~/Sync/wecom-bot/bin/wecom-channel-bridge.mjs
```

环境仅含 PATH 和 WECOM_ENV_FILE 路径引用；工作目录是该项目。配置文件正文没有复制到 plist。新日志位置是 `~/.lark-channel/daemon/ai.wecom-channel-bridge.riskbot-codex/{stdout,stderr}.log`。

**当前运行的仍是 PID7807 的旧临时 job。** 没有 bootout 它，没有对它 bootstrap 新定义，也没有为了检验而制造第二条线上连接。因此新入口与新日志设置尚未在这个运行实例上生效。不能把磁盘定义验证标成冷启动、登录自启或运行实例迁移通过。

持久定义创建后，省略 `--wecom-env-file` 的日常 `start --all --profile codex` 已再次实测通过；两个原 PID 仍保持不变。最终进程/定义核验于 `2026-09-07T05:08:33Z` 完成。

## 剩余验收与 Codex 交接

1. **真实客户端端到端尚未重做**：在用户已使用的飞书及企业微信会话，用无敏感内容测试普通对话、第二轮续接、`/new`、`/resume`、安全停止、卡片回调和小型文本附件。既有隔离实例验收记录不能代替本次部署结果；本轮没有发真实客户端消息。
2. **持久 WeCom 冷启动/临时 job 切换尚未执行**：在明确的维护窗口，先重新检查当前 PID、活动任务、实际配置与状态目录，再对同一个目标 label 完成有序卸载和新定义加载；禁止新旧同身份连接并行。检查健康心跳、PID、日志和新消息回复，确认没有任务重放。不要改动其他服务。
3. **生产状态迁移/回滚仍未演练**：不得清理任务 ledger、覆盖新旧会话数据或把失败任务直接自动重跑。跨平台 CI、发布/推送/合并不在本轮实际执行范围。

继续工作前核对工作树与适用 AGENTS.md，保留已有修改，不 reset/clean/stash 无关内容。补充真实检查结果时记录实际测试提交或工作树范围；不要把上述未执行项改成 PASS，除非获得相应证据。
