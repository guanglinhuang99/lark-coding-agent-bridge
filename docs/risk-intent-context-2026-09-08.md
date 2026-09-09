# 风险意图上下文精简修复（2026-09-08）

## 结论

修复已实现并通过本地完整CI及真实GPT-5.5配对验证，尚未部署。自然语言输入token中位数16647→5997，减少63.98%；复合修改16699→6049，减少63.78%。两类各3对；不能将输入token减幅等同于费用、账号额度或端到端延迟减幅。

此次对照是优化版6d28a6a的原通用适配器与本次上下文补丁，均使用gpt-5.5、low。它不是原f00d635/6d28a6a性能对照的替代，也不与Spark历史样本混合。

## 修改

- CodexAdapter增加仅供风险解析使用的purpose；普通聊天仍追加bridge说明。
- 风险解析不追加5269字符的通用Lark说明，强制忽略用户配置和execpolicy规则，关闭项目说明与技能说明注入、技能搜索、orchestrator技能/MCP及不需要的应用、浏览器、shell等能力。审批仍never、沙箱仍read-only，保留认证home。CLI 0.153.2实际调用验证配置生效。
- 使用stateDir下独立解析工作目录；专用RunExecutor继续共享runGate.pool和进程关闭跟踪。实际解析显式使用low推理。
- 解析分支记录inputTokens、cachedInputTokens、outputTokens、reasoningOutputTokens及模型，不记录原文或凭证。未观测字段不填0。
- 未修改业务解析规则、确认规则、查询缓存或正式测算逻辑；未修改生产模型配置。测试显式使用gpt-5.5。

配置依据包含Codex官方[配置schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)的skills.include_instructions及orchestrator设置，并通过本机实际会话检查。首个探针使用skip_host_skill_discovery仍出现技能列表，已放弃该设置；第二探针确认技能块与bridge前缀消失。仍存在Codex基础指令/协议开销，当前并非只有数百token的裸API请求。

## 验证

隔离目录：/private/tmp/wecom-live-20260908/intent-fix-validated。主工作区未构建；固定before、after源码未覆盖。

| 检查 | 结果 |
| --- | --- |
| pnpm run ci:platform | exit 0；149文件、1090项通过，1受控benchmark跳过；类型检查及构建通过 |
| python3 -B tests/python/test_risk_dispatcher.py | exit 0；4项通过 |
| git diff --check | exit 0 |
| 真实GPT-5.5配对 | 四场景各3对，加预热1对，26/26条成功；规范化输入与完整业务结果逐对一致 |

第一轮CI因两处旧配置断言及一处绑定executor变量名的架构断言失败（1087通过、3失败）；同步断言后完整CI通过，保留两轮日志。最终CI后仅澄清一条注释的“进程关闭跟踪”措辞。

| 场景 | 每版N | AI调用总数 原→修复 | 输入token中位数 原→修复 | 本地链路median ms 原→修复 |
| --- | ---: | --- | --- | --- |
| 自然语言 | 3 | 3→3 | 16647→5997 | 11863.53→9562.20 |
| 金额修改 | 3 | 0→0 | 未调用AI | 10585.92→10590.88 |
| 期限修改 | 3 | 0→0 | 未调用AI | 2499.53→2579.81 |
| 复合修改 | 3 | 3→3 | 16699→6049 | 21069.02→17494.55 |

耗时仅为小样本观察；各次缓存命中情况不同，P95见统计文件，不宣称稳定尾延迟改善。每次正式测算仍真实执行，确认、重复确认拒绝和修正后旧卡失效由实际registry验证；无企业微信平台收发。

证据：[原始记录](benchmarks/risk-live-2026-09-08/intent-context-live-1/samples.jsonl)、[独立统计](benchmarks/risk-live-2026-09-08/intent-context-live-1/statistics.json)、[补丁指纹](benchmarks/risk-live-2026-09-08/intent-context-patch-manifest.json)。复现入口为[harness](benchmarks/risk-live-2026-09-08/harness/risk-intent-context-live.mjs)，参数依次为私有配置、原优化版bundle、修复bundle、新输出目录；私有配置及原始模型会话不进入Git。CI日志在验收根目录intent-fix-ci-final.log，失败首轮为intent-fix-ci.log。

## 上线门禁

本次上下文修复验证完成，整体上线验收仍未完成。原完整性能矩阵的剩余30对采样和新版平台测试仍待继续。

只读复核发现既有取消缺口：HEAD原代码和修复版的analyzeRiskDraft都使用随机risk-intent scope，未映射到按会话管理的activeRuns，因此用户/stop无法找到正在运行的风险AI；退出服务时agentRuns.stopAll仍可关闭。此问题不是本次专用executor引入，未在本次上下文修复中改变，需要另行修复并验证后才能按完整取消要求宣称上线就绪。

未提交、推送、合并、重启或部署；原AGENTS.md和.pnpm-store/保持未跟踪。此前GPT-5.5旧配置预检按用户要求停止，exit143，不把未完成样本计为成功。

后续专用基础指令补丁已完成，GPT-5.5输入进一步降低到约1500–1800 token，完整CI与真实边界/链路检查通过。见[专用指令验收](risk-intent-minimal-2026-09-08.md)，不与原固定提交性能样本混算。
