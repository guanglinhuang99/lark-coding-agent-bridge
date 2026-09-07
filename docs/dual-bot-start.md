# 同时启动飞书和企业微信机器人

## 日常使用

从已构建的项目目录运行，避免误用全局旧版本：

```sh
node bin/lark-channel-bridge.mjs start --all --profile codex
node bin/lark-channel-bridge.mjs status --all --profile codex
```

已配置 active profile 时可以省略 `--profile codex`。安装的是包含本改动的包时，也可以直接使用 `lark-channel-bridge start --all`。

`--all` 是一个短生命周期的服务管理入口，不是新的 supervisor：飞书和企业微信仍有各自的进程、配置、连接和会话存储。此版本的 `--all` 只支持 macOS，且只增加 `start` / `status`，没有 `stop --all` 或 `restart --all`。原有单平台命令保留。

## 首次建立企业微信持久服务

飞书 profile 必须已经用原有 `start --profile <name>` 完成后台服务配置；统一入口不会再走扫码或创建账号。

企业微信凭证和运行设置应已经保存在一个现有的 env 文件里。首次运行时只传文件路径，不在命令行传 Secret：

```sh
node bin/lark-channel-bridge.mjs start --all --profile codex \
  --wecom-env-file "$PWD/.env"
```

如已存在多个企业微信服务，需要明确选中其中一个：

```sh
node bin/lark-channel-bridge.mjs start --all --profile codex \
  --wecom-service ai.wecom-channel-bridge.riskbot-codex \
  --wecom-env-file "$PWD/.env"
```

首次设置只在目标 plist 不存在时创建它，权限为 `0600`，不会覆盖原有定义。plist 使用当前包的企业微信入口和当前 Node，保存 `PATH`、`WECOM_ENV_FILE` 路径引用、调用命令时的工作目录与日志路径；不会复制或输出 env 文件里的凭证。已有定义与 `--wecom-env-file` 或当前 `WECOM_ENV_FILE` 指定的配置文件不一致时拒绝变更；创建竞争中也会重新核验最终定义的配置引用。

如果调用环境设置了 `WECOM_WORKSPACE` 或 `WECOM_STATE_DIR`，新定义仅保存这两个路径的绝对形式，保持工作区与会话目录语义；其他运行设置应写入指定 env 文件。不会根据 env 文件所在目录或包目录猜测工作区，也不会把 shell 中的 Secret 写入 plist。

新企业微信服务日志位于：

```text
<LARK_CHANNEL_HOME>/daemon/<WeCom service label>/stdout.log
<LARK_CHANNEL_HOME>/daemon/<WeCom service label>/stderr.log
```

默认 `LARK_CHANNEL_HOME` 为 `~/.lark-channel`。已有 Lark 日志路径不改变。配置文件及其引用的 Python、Codex、工作区路径应长期可用；统一启动核验当前包的实际入口路径、当前 Node 和飞书状态目录身份；移动目录、切换包或升级 Node 后需要先用单平台流程检查、修复服务定义，统一入口不会接管另一个同名脚本。

## 已有临时 job 的兼容方式

旧版可能通过 `launchctl submit` 和 shell 包装器运行企业微信，没有磁盘 plist。统一入口会识别这个已加载的 job，不再连接一次相同服务。

显式传入 `--wecom-env-file` 可以为同一个 label 补建持久定义，但**不会自动卸载正在运行的临时 job**。此时状态输出会明确提示：当前进程仍是旧临时 job，新入口和新日志设置要在下次受控卸载、重新启动后才被加载。仅生成 plist 不等于已完成运行实例迁移，也不证明登录自启或冷启动已经验收。

不要在旧 job 仍在线时手动再运行一个前台 `wecom-channel-bridge`。相同机器人身份的第二条连接可能影响已有实例。临时 job 的迁移应在没有活动任务的维护窗口单独进行，并检查新进程健康及平台连接。

## 返回结果与保护行为

| 场景 | 行为 |
| --- | --- |
| 两边都运行 | 保留 PID，不重复启动、不重启 |
| 一边停止 | 仅启动停止且有有效定义的一边 |
| 两边停止 | 分别 enable、bootstrap，检查进程存活；不创建总控进程 |
| job 已加载但没有进程 | 不自动再拉起一份，报告异常并返回非零；应先诊断或显式修复该平台 |
| 一边失败 | 另一边仍单独处理；不停止已成功的一边；整体返回非零 |
| 多个企业微信候选 | 要求 `--wecom-service`，不按名称顺序或最近使用猜测 |
| 旧定义有重复脚本参数、shell 包装器、错误 Label 或符号链接 | 拒绝从该定义启动，不覆盖文件 |
| `status --all` | 不安装、重写、enable 或 bootstrap 服务 |
| launchctl 查询超时或权限失败 | 状态未确认并返回非零，不当作服务不存在继续启动 |

这里的“运行”表示 launchd 外层 job 为 running，且 PID 存活。它不等同于平台在线，更不等同于真实收发成功；需要结合飞书 profile 状态、企业微信 `--health` 及客户端消息回执验证。`runs` 是 launchd 累计启动次数，不能凭单个快照认定或排除重启循环。

## 同轮生命周期修复

macOS 已加载和真实运行分开判断；停止、注销、重启仍会处理已加载但正在崩溃退避的 job。`restart --profile <name>` 在 job 已停止时也先重建 canonical plist，再启动。配置解析失败时不重写。`enable` 失败不继续 bootstrap，等待连接超时返回非零。

验证边界及执行结果另见 `dual-bot-validation.md`；不把 mock 用例当成真实飞书或企业微信客户端验收。
