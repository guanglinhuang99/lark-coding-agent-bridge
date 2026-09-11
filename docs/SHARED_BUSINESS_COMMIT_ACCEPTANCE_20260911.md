# 共享业务重构：固定提交与隔离候选验收

日期：2026-09-11。全量 TypeScript 测试于 2026-09-11 04:34:02 UTC 完成。

## 结论

**LOCAL_COMMIT_CREATED / CLEAN_CHECKOUT_VALIDATION_PASS / NOT_DEPLOYED**。

本轮将之前数轮已实现的共享业务重构固定为本地 Git 提交，并从该提交建立独立工作树重新构建和验证。未推送 GitHub、创建 PR、合并、发布 npm 或 tag，也没有重启生产机器人。

| 项目 | 记录 |
| --- | --- |
| 分支 | `refactor/shared-business-core` |
| 代码提交 | `6e70f4d24ffd35e8d31d3ba98fef5fc86186991b` |
| 父提交 | `21af9cbfa1d2e4b8189a8c499b7d73d36fed8063` |
| 验收树 | `d0939e67d3f5d68bf193262fd0015f221d37f324` |
| 提交标题 | `refactor(risk): share business application and runtime across channels` |
| 文件范围 | 56 个明确列出的相关源码、兼容依赖、测试和验收文档 |
| 运行环境 | macOS，Node `v24.19.0`；复用现有 node_modules，没有重新安装依赖 |

该代码提交包含此前未提交的业务能力诊断和对应 Python 兼容测试，它们是共享桥接实现的相关依赖。没有复制外部业务后端进仓库。上一轮的两份后端迁移报告、两份基准 JSON 和三个外部后端 patch 均保留在原工作区，没有纳入本次提交，也未重复应用。

新增架构与验收指南：`docs/shared-business-core.md`。本轮业务实现未继续扩张，仅修正新增飞书适配器文件尾部空行；该问题是在首次完整暂存差异检查时发现的。

## 隔离验证方式

从代码提交创建 detached worktree：

`/var/folders/yz/f27434tj0x30rs3hxf97rmg40000gn/T/shared-business-candidate-77E1sp/checkout`

测试使用同级独立 HOME。Node 依赖是指向已安装 node_modules 的显式链接；没有复制原目录的 .env、Codex 登录文件、机器人凭证、缓存或状态。业务后端链接未解析到真实后端，因此本次也验证了缺少可选后端时可移植部分的行为。

前端先在隔离工作树构建，随后执行全量 Vitest、类型检查及服务端构建，生成该目录内的 dist。原工作区生产 dist 未重建。测试后代码提交及已跟踪文件无漂移；隔离工作树唯一额外未跟踪项为主动创建的 node_modules 依赖链接。

## 本轮实际结果

| 检查 | 结果 |
| --- | --- |
| 前端 Vite 构建 | PASS |
| 全量 TypeScript 测试 | **1305 通过、1 跳过、0 失败**；168 个文件通过、1 个文件跳过 |
| TypeScript 类型检查 | PASS，退出码 0 |
| 服务端构建 | PASS，生成 cli.js、wecom.js、index.js 和类型声明 |
| 三个 JavaScript 入口语法检查 | PASS |
| Python 桥接打包一致性 | PASS，打包资产与公共源码逐字节相同 |
| Python 可移植回归 | **26 通过、22 跳过、0 失败**，共发现 48 项 |
| 暂存内容检查 | 56 个文件范围正确；高置信凭证模式扫描 0 命中；未纳入私有配置 |
| Git 差异检查 | PASS |

TypeScript 跳过项是可选性能基准。Python 跳过项为 9 项依赖外部授信后端的测试、11 项依赖共享后端文本函数的测试，以及 2 项依赖 polars 的测试。此次没有接入外部后端或补装 polars，不能将跳过项计为通过，也不能用此前其他环境的测试数字替代本次结果。

本轮复用已有依赖，不等同于完成冻结锁文件的重新安装或其他操作系统验证。没有新的真实性能提升百分比。

## 候选构建哈希

| 文件 | SHA-256 |
| --- | --- |
| `dist/cli.js` | `e0cbae145518ebf28caf17b3bee4078b5ded75e4cf8c3dcc9f69cb10c95fbd01` |
| `dist/wecom.js` | `6f2c0108f77906ccc7277b9cd4d6d6a575531b5b581603a2b85158c387688697` |
| `dist/index.js` | `5f765804b81cb7acdb74631d27f54a6ec1cb0db99a411635e7908f26eb54530f` |
| `dist/risk/direct_bridge.py` | `0c87e1bf23d9cf4504a6dc2650beb40db77445611a4d38fbbc1432fd636645bc` |

候选为临时工作树中的已验证构建，不是已安装的生产 release，也不是包含 Python 后端和独立依赖的自包含发行包。机器可读记录见 `docs/benchmarks/shared-business-candidate-20260911.json`。

## 现有服务只读观察

2026-09-11 04:32:18 UTC，现有 `status --all --profile codex` 返回：飞书服务 PID 36940，企业微信服务 PID 77479，均为进程运行中，launchd runs=1。该结果仅表示当时进程存活，不证明平台连接或业务可用，也不证明已加载本次候选。

本轮未执行任何 restart、bootout、bootstrap 或生产配置写入。不要在相同生产机器人身份仍在线时启动第二个候选连接。

## 下一阶段

首先推送本分支并创建 PR，完成远端检查与独立审查；这些外部写入本轮尚未执行。随后在明确的测试身份和受控会话中，使用同一候选提交完成飞书与企业微信原生验收。没有独立测试身份时，需要单独获准的维护窗口，不能把进程状态或模拟测试当作原生验收。

业务配置迁移时必须确认飞书实际读取到 RISK_PYTHON、RISK_SERVICE_DIR 等公共配置，不能假定会自动继承企业微信 .env；两渠道用户允许名单仍分别配置。具体矩阵参见 `docs/shared-business-core.md`。

## 执行证据

- 验证批次：`op_cd02daed7a73d99138de01ad`，四步成功。
- 固定提交全量测试：`task_67282004fa674a44`，退出码 0。
- 类型、服务端构建及资产校验：`task_3e0cf8a672d18f70`，退出码 0。
- 初始隔离工作树与前端构建：`task_3ec2d1e823f8f9d9`，退出码 0。

历史报告保留其原验证时间及未提交状态。本文件记录后续实际创建代码提交和隔离候选验收；最终分支若再有纯文档提交，应与这里的已测试代码提交区分。
