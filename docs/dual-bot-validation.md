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

## Codex 独立验收（2026-09-07）

### 基线、隔离与授权边界

- 仓库核验：`origin=https://github.com/guanglinhuang99/lark-coding-agent-bridge.git`，PR #12，分支 `feat/dual-bot-lifecycle`。
- 安全 fetch 后 PR 实际初始 HEAD：`99f76017c4ae56879d5f8c3416288ccf88b99c1a`；`origin/main=2a5cfec78cfd605dbe9c908dd0ca63535c0bd972`。已读取 PR 描述、最新 CI 交接评论和适用 AGENTS.md。
- 使用 detached worktree `/private/tmp/wecom-pr12-acceptance`；参考工作区 `/Users/guanglin/Sync/wecom-bot` 保留原 HEAD、未跟踪 `.pnpm-store/` 与 `AGENTS.md`，不纳入提交。不在参考工作区安装依赖或构建。
- 自动化验收使用 fake launchctl、fake 文件系统/PID、fake SDK/agent；完整检查通过白名单环境执行，HOME、LARK_CHANNEL_HOME、WECOM_STATE_DIR 指向 `/private/tmp/wecom-pr12-state/`。没有复制生产凭证、加载线上 env 或启动相同线上身份的连接。
- 本机 Node `24.19.0`，pnpm `10.33.0`。首次 install 的 prepare 子命令解析到宿主 fallback pnpm，故该次不作为最终安装证据；之后用临时 PATH wrapper 固定全部 pnpm 子命令为 `corepack pnpm@10.33.0`，重新完成 `install --frozen-lockfile`（exit 0）。package.json、pnpm-lock.yaml 未改动，没有升级或全局安装依赖。

### 真实生产验收边界

| 项目 | 本次结果 | 原因 |
| --- | --- | --- |
| 企业微信临时 job 到持久定义生产切换 | BLOCKED | 本任务明确不授权卸载、重启或重新注册线上 job |
| 新持久定义真实冷启动、新入口及日志生效 | NOT RUN | 未实施生产切换；模拟测试不代替此项 |
| 登录自启 | NOT RUN | 未退出登录或重启机器 |
| 真实对话、追问、`/new`、`/resume`、安全停止、卡片回调、小文件回传 | BLOCKED | 本次没有已授权的真实客户端测试会话，未发送消息 |
| 生产状态迁移与回退演练 | NOT RUN | 未操作线上状态、ledger 或会话 |

后续只能在另行批准的维护窗口执行：重新确认活动及排队任务为零、指定 label 与身份、保存回退依据，等待旧 WeCom job 和进程完全退出后启动同身份新定义，核验 health、日志和真实消息；飞书保持运行。不得制造并行同身份连接，不清理 ledger 或重放结果不确定的任务。

### Windows 失败归因与最小修复

初始 PR push CI `34086925366` 和 pull_request CI `34087023612`：macOS、Ubuntu 成功；Windows 失败。PR 新增的 fleet 两个测试文件贡献 5 个失败：只模拟 `process.platform=darwin`，但 `node:path` 和 `process.execPath` 仍来自 Windows（包括 `node.exe`）。修复统一使用 POSIX path、固定 fake Node、fake UID，并恢复原始 process 属性；保留定义保护及副作用断言，没有删除或 skip 用例。

`main` 的 Windows run `34081386815` / job `101617183420` （HEAD `2a5cfec78cfd605dbe9c908dd0ca63535c0bd972`）汇总为 141 文件中 3 失败、138 通过；992 用例中 5 失败、986 通过、1 原有跳过。已存在其余 5 个失败：launchd-autostart 3 个（宿主 UID=-1），media 与 logger-redaction 各 1 个（Windows stat 不提供 POSIX 0600 权限语义）。三个测试文件的 Git blob 在 `main` 与初始 PR HEAD 完全相同。测试修复固定 macOS 模拟 UID；Windows 对真实 I/O 的包装器断言请求的 0600/0700 创建与 chmod 参数，macOS/Linux 保留实际 stat 权限检查，文件内容和脱敏断言继续执行。这不宣称验证了 Windows ACL。

本机试图仅模拟 win32 启动测试工具时缺少 Windows Rollup 原生包，不能作为真实 Windows 复现或通过证据；最终跨平台结果以 GitHub runner 为准。未改 CI 平台矩阵，未增加 skip、删除用例、升级依赖或延长全局超时。

### 缺陷复现与修复内容

源码/测试修复提交：`ff1a351b957598885b0128e32a3552faf3d9d6e1`。本次不更改双进程架构，不引入总控服务。

- 在独立临时旧源码副本（`git archive 99f7601`）运行新增 safety 测试中筛选的 8 项：8 项全部失败（exit 1；其余 11 项仅因 `-t` 筛选未执行，没有添加 skip）。复现包括 discovery 失败阻断健康同伴、EEXIST 配置竞争、存在的同名外部入口/Node 被接受、Lark 状态目录身份、工作目录/状态路径漂移、缺失 env 文件及多候选隔离。
- launchd query 新增 5 项在修复前为 4 失败、1 通过，修复后 5 项通过。查询超时、权限或 spawn 错误不再被当作“已卸载”；只认明确的 service-not-found 状态，查询有 5 秒上限，未修改服务启动等待阈值。
- fleet 查询失败同样保留“状态未确认”；服务发现失败也只使企业微信失败，飞书仍独立处理，总体返回非零。
- 对实际 Node、同包 bin/dist 入口和飞书状态目录做身份检查；保留 Label、脚本参数、shell、符号链接及文件存在性保护。WeCom env 引用必须为存在的绝对文件路径；创建竞争后重新核验最终定义的 env 身份。
- 新 WeCom 定义保持调用 cwd，以及已指定的 `WECOM_WORKSPACE` / `WECOM_STATE_DIR` 绝对路径。仅保存路径和 PATH，不复制 shell Secret 或 env 文件正文。原有定义不被覆盖，运行中的临时 job 不被卸载。

旧源码复现命令使用当前新增测试及 `vitest run tests/unit/daemon/bot-fleet-safety.test.ts -t 'discovery failure|env file after a concurrent wx|same-basename|different node executable|state root differs|keeps caller cwd|existing env file|ambiguous discovered|discovery fails'`，工作目录 `/private/tmp/wecom-pr12-before-safety`。修复后的完整测试覆盖所有用例，见下方最终检查。

### 最终本地检查

实际完整测试 HEAD：`1c3de5619ebd361381ae63c2753987cef3fbbe04`（上一提交为源码修复，当前提交仅修复媒体测试原名标记）。白名单环境启动命令经临时 pnpm wrapper 固定为 `corepack pnpm@10.33.0`；所有构建产物仅在隔离 worktree。

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm@10.33.0 install --frozen-lockfile` | PASS，exit 0；锁文件未变 |
| `pnpm exec vitest run tests/unit/daemon tests/unit/cli/service-profile.test.ts tests/unit/cli/kill-os-managed.test.ts tests/unit/cli/index-registration.test.ts` | PASS，exit 0；11 文件、89 用例 |
| `pnpm test` | PASS，exit 0；146 文件、1055 用例，无跳过 |
| `pnpm typecheck` | PASS，exit 0 |
| `pnpm build` | PASS，exit 0；Vite、CLI/WeCom/library bundle、声明文件全部成功 |
| `git diff --check` | PASS，exit 0 |
| 构建 CLI 冲突参数检查 | PASS，8 组全部 exit 1，临时 HOME 内没有文件变更 |

CLI 冲突检查逐项运行 `node bin/lark-channel-bridge.mjs`，参数为 `start --all --web-ui`、`start --all --agent codex`、`start --all --workspace /fake/workspace`、`start --all --app-id fake`、`start --all --skip-check-lark-cli`、`start --wecom-service ai.wecom-channel-bridge.test`、`status --all --web-ui`、`status --wecom-service ai.wecom-channel-bridge.test`。每次使用独立空 HOME、状态目录和工作目录。

保留失败记录：在 `ff1a351` 上首次完整回归为 145 文件通过、1 文件失败；1054 用例通过、1 失败。原有 `attachment-resolver.test.ts` 要求完整路径不含 `private`，与本次隔离路径 `/private/tmp` 冲突；源码输出的完整 hash 路径已经符合精确断言。将测试原文件名及“不泄漏原名”断言使用的标记统一改为 `attachment-private-sentinel`，保留完整 hash 路径、内容及 file key 安全断言。该文件在 main 与初始 PR 相同，没有改媒体生产代码。相关 5 项及上表完整检查已在 `1c3de56` 复跑通过。

### 验收清单映射（全部为离线模拟）

| 要求 | 结果与证据 |
| --- | --- |
| 两边运行时重复 start、只读 status | PASS；fleet coordinator/backend 保留 PID，无重复 start，无写入或管理操作 |
| 一边停止、两边停止 | PASS；两种单边停止均只启动必要服务；双停止分别 enable/bootstrap |
| 单边失败隔离、总非零 | PASS；配置/discovery、enable、bootstrap、启动后退出、观察失败均覆盖，不停止成功同伴 |
| loaded/running/连接区分 | PASS；外层状态、嵌套 coalition/environment、无 PID、死 PID、EPERM；查询失败保持未知；其他 PID 的注册不冒充当前平台连接 |
| loaded crash job / unloaded restart | PASS；重建、卸载等待、enable/bootstrap 顺序；配置解析失败不写定义；未知卸载状态不 bootstrap；连接超时非零 |
| 并发与身份 | PASS；同 env 重复调用、强制 EEXIST 异 env 竞争、强制 bootstrap 竞争赢家均覆盖；多个 WeCom 候选拒绝自动选择 |
| 定义保护 | PASS；错误 Label、额外脚本、shell、符号链接、消失的 Node/入口、同 basename 外部路径、不同 Node、Lark 状态根不一致均拒绝且不覆盖 |
| 临时 WeCom job 补建 | PASS；只创建缺失定义，0600/wx、env 路径引用，无 unload/kill；提示新参数尚未加载 |
| 配置、PATH、工作目录及状态目录 | PASS；保留调用 cwd 与必要路径，bin/dist 同包入口核验，env 不存在或非绝对文件引用拒绝；不读取 Secret 正文 |
| 单平台、supervisor、kill、CLI 参数 | PASS；相关集及完整回归通过，8 组 CLI 冲突在副作用前拒绝 |

这里的 PASS 不包括真实 OS 冷启动、生产迁移或客户端收发；这些项目的 BLOCKED/NOT RUN 状态保持不变。

### GitHub CI 与结论

已读取 `1c3de5619ebd361381ae63c2753987cef3fbbe04` 的真实 GitHub 日志，不能以本机模拟替代 Windows 结果。

| 平台 / Node 20 | Push CI | PR CI | 实际测试数量（两组一致） |
| --- | --- | --- | --- |
| macOS | PASS | PASS | 146 文件、1055 用例通过 |
| Ubuntu | PASS | PASS | 146 文件、1055 用例通过 |
| Windows | PASS | PASS | 146 文件通过；1054 用例通过、1 原有跳过 |

Push run：[34088733463](https://github.com/guanglinhuang99/lark-coding-agent-bridge/actions/runs/34088733463)。PR run：[34088737657](https://github.com/guanglinhuang99/lark-coding-agent-bridge/actions/runs/34088737657)。全部 install、test、typecheck、build 步骤成功。Windows 唯一跳过为原有 `tests/unit/bridge/conversation-bindings.test.ts` 中依赖可变 symlink 的用例，本轮未改该文件或跳过条件。

**代码与离线验收：PASS。** 本地完整验证及三平台两组 CI 均通过。此报告和使用说明作为后续纯文档提交，未改变已验证的源码、测试、依赖或锁文件；报告提交后的最终 HEAD / CI 另在 PR #12 的独立验收评论中记录。

**生产切换：满足进入维护窗口审批与切换准备的代码条件，但尚未完成生产验收，也未授权直接切换。** 冷启动、登录自启、真实客户端收发与回退演练仍按上表保留 NOT RUN/BLOCKED。唯一优先下一步是另行批准维护窗口，按既定有序卸载、单实例启动和回退预案进行 WeCom 迁移及真实验证。

修复已推送原 `feat/dual-bot-lifecycle` / [PR #12](https://github.com/guanglinhuang99/lark-coding-agent-bridge/pull/12)，保持 Draft；未合并、发布或部署。参考工作区仍为 `99f76017c4ae56879d5f8c3416288ccf88b99c1a`，仅有原先未跟踪的 `.pnpm-store/`、`AGENTS.md`。线上代码、dist、配置、会话和 job 未被本次验收更新。


### 第二任务独立复核归并（2026-09-07）

本节收口第二任务在 `/private/tmp/wecom-pr12-independent-1355` 的独立证据，保留上方第一任务记录。第二任务原报告提交 `6bab5e292a385f40ef59bd1a74c61be38875b5f9` 不整体 cherry-pick，避免重复章节；本次基于已发布报告 `1349c3278abbb2fcb58d5c275e10bdbebef1e2f3` 追加归并说明。

- 第二任务实际完整测试 HEAD 同为 `1c3de5619ebd361381ae63c2753987cef3fbbe04`：146 文件 / 1055 用例通过，相关 11 文件 / 89 用例通过；typecheck、build、diff 检查均 exit 0，8 组 CLI 冲突检查均非零退出且未生成文件。
- 使用 Node 24.19.0、pnpm 10.33.0，冻结锁文件安装，白名单环境和独立临时 HOME、LARK_CHANNEL_HOME、WECOM_STATE_DIR；未更改线上配置或连接。
- 独立核对 main/原 PR Windows 日志及最新三平台两组 CI，结论与主报告一致。第二任务首次沙箱完整测试 1042 通过 / 13 失败：12 个 UI 用例因本地监听 EPERM，1 个附件测试因 `/private/tmp` 与旧标记冲突；开放离线本地监听并使用 `/tmp` 后通过。之后在修正标记的 `1c3de56` 重新完成全部检查。
- 独立结论已发布于 [PR 验收评论](https://github.com/guanglinhuang99/lark-coding-agent-bridge/pull/12#issuecomment-5565761811)。本次归并仅修改文档，不改变源码、测试或依赖；最终文档 HEAD 的 CI 结果在 PR 收口评论记录。

### 下一阶段审批范围（仅预案，未执行）

当前可申请企业微信持久定义切换的维护窗口；“继续验收/归并报告”不表示已授权生产操作。审批需明确执行时段、上线代码版本和范围：是否批准更新参考工作区构建并将指定旧 WeCom job 切换到持久定义，以及是否批准指定测试会话的真实消息与小文件收发。PR 合并、发布不包含在此范围内。

批准后先只读核验 `ai.wecom-channel-bridge.riskbot-codex` 的实际定义、活动/排队任务为零、单一身份、当前构建和回退所需配置；记录并保护回退材料，不写入仓库。历史 PID 或已有 plist 不能代替现场核验，未核验生产当前状态前不生成可直接执行的卸载命令。

执行顺序为：确认回退依据可用 → 完成已批准的构建版本准备 → 停止并等待旧 WeCom job 与进程完全退出 → 同身份启动新持久定义 → 核验新 PID、参数、health、日志、无任务重放 → 在获准会话完成真实收发。飞书保持运行，全程不得出现同身份并行连接。更新共享构建前还需确认不会影响仍运行的飞书；否则停止该更新步骤并另行确定隔离部署路径。

新服务失败时先停止并确认新实例退出，再按已核验的旧定义和构建恢复；不清空 ledger，不自动重放执行结果不确定的任务。无法确认退出、身份、任务或回退依据时停止切换。登录自启仍单列 NOT RUN，除非另外批准相应验证。以上审批和现场核验尚未完成。


## 已批准生产切换（2026-09-07）

用户明确批准维护窗口生产更新、企业微信单实例切换及指定会话真实收发测试。以下记录替代此前“未授权切换”的当前状态，历史记录保留；真实测试会话尚未明确，未发送消息。

- 部署代码/文档 HEAD：`82ea0e4a6dc169e83b23271564ca19bda89f416b`。参考工作区从 `99f7601` 仅快进至该版本；保留原未跟踪 `.pnpm-store/` 和 `AGENTS.md`。
- 实际磁盘 `dist/wecom.js` 与隔离验收产物逐字节相同，SHA-256 `088d4cb65aedb8ece84d9202df77e75a2e38cee3afe8e956c93861f001535633`，未替换该文件或依赖。仅原子更新已验收 CLI，SHA-256 `c88649741ece69d905a418c85fb3a5ddf32de604e7a7ebcd48be7eda5be89370`；未在共享目录执行会清理 dist 的 build。
- 仓库外私有回退材料位于 `~/.local/state/wecom-cutover/20260907-pr12`，目录 0700、文件 0600，保存切换前定义、构建、env 和状态；没有把凭证、原始日志或会话内容提交到 Git。回退脚本未实际触发，回退演练仍 NOT RUN。
- 现场旧 job 为 `ai.wecom-channel-bridge.riskbot-codex`，PID 7807，临时 shell 提交；持久定义引用同一 env 文件和工作目录。只发现一个企业微信候选进程且无子进程，健康心跳新鲜，connected=true、activeRuns=0、startingRuns=0；间隔 5 秒重复确认。旧状态目录没有 tasks.json，因此无法从旧 ledger 独立量化队列，未把缺失文件冒充已验证的 ledger 零任务。
- 2026-09-07 14:16 CST：bootout 指定旧 job 后，确认 launchctl 返回明确不存在且 PID 7807 已退出，才 enable/bootstrap 同 label 的持久定义。新 PID 89496 在 14:16:43 获得 connected 健康状态；没有新旧同身份实例并行。
- 持久启动后的真实 launchctl 参数与 plist 一致，工作目录、env 引用、新 stdout/stderr 路径生效；只读 `status --all --profile codex --wecom-service ai.wecom-channel-bridge.riskbot-codex` exit 0。新 job PID 89496、runs=1；飞书 PID 36940、runs=1，未停止或重启飞书。
- 后续只读采样：health connected、activeRuns=0、startingRuns=0；新 stdout 有连接标记，stderr 0 字节，未观察到错误行。env 和 sessions.json 与切换前快照逐字节相同；未清空状态、ledger 或重放任务。

| 生产验收项 | 当前结果 |
| --- | --- |
| 受控旧临时 job → 持久 job 切换 | PASS |
| 新持久定义启动、新入口/工作目录/日志生效 | PASS；进程和平台连接证据，不代表真实消息收发 |
| 飞书连续运行 | PASS；PID/runs 不变 |
| 配置与已有会话保持 | PASS；字节比对一致 |
| 线上重复两次 start --all | BLOCKED；自动审批拒绝该命令组，认为重复生产启动未明确授权、存在并行连接风险；命令组未执行，已请求专项批准 |
| 指定会话真实对话/追问/会话卡片/小文件收发 | BLOCKED；待用户指定现有测试会话或手动发送测试消息 |
| 登录自启 / 系统重启后冷启动 | NOT RUN；未退出登录或重启机器 |
| 生产回退演练 | NOT RUN；已有回退材料，未触发回退 |

本次未合并 PR、发布包或创建新 PR。生产切换已成功，完整客户端与登录自启验收仍未完成，不能将这些项目标为 PASS。
