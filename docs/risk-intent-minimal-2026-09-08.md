# 专用风险解析指令验收（2026-09-08）

> 后续部署状态（2026-09-08）：已获授权并部署，详见 [部署记录](risk-deployment-2026-09-08.md)。本文“未部署”等表述保留其验收时点含义。

## 结论

已将上一轮约6000 token中的通用Codex编程指令替换为367字符的专用解析指令，并完成代码与GPT-5.5验证。当前需AI场景实测输入1499–1771 token；不需要AI的标准交易、金额/期限单字段修改及本次标准一级申购仍不调用模型。未部署或更改在线机器人模型。

本次基线为上一轮上下文精简补丁（约6000 token），修复版另加model_instructions_file；两者都使用gpt-5.5、low、相同真实后端及解释器，状态独立。本次不是最初f00d635/6d28a6a固定提交性能报告的替代。八场景各1对，仅用于正确性和输入量复核，不宣称稳定延迟、费用或额度按相同比例下降。

## 实现与验证

- 新增src/agent/codex/risk-intent-instructions.ts，明确只抽取JSON、不使用工具、不执行交易、不测算风控、不猜字段，保留无效/含糊金额原文。
- CodexAdapter仅对risk-intent生成专用指令文件；按内容hash命名，临时文件与目标同目录，写完后原子rename。正常异常路径清理临时文件。强制终止进程仍可能留下未发布的临时文件。
- argv仅在风险用途下传model_instructions_file，路径按单个配置参数编码；普通聊天不受影响。原权限和认证方式保持，未绕过审批/沙箱设置。
- 回归覆盖文件幂等、损坏恢复、无正常临时残留、带空格路径及普通请求不传覆盖参数。

隔离完整CI：`pnpm run ci:platform`退出0，150文件、1093项通过、1个受控benchmark跳过，类型检查和构建通过；`python3 -B tests/python/test_risk_dispatcher.py`退出0，4项通过；`git diff --check`退出0。

隔离目录 `/private/tmp/wecom-live-20260908/intent-minimal-validated`。主工作区产品源码及测试与隔离CI副本逐文件相等；构建只在隔离目录。日志为验收根目录`intent-minimal-ci.log`、`intent-minimal-python.log`。只读复核未发现本次文件/参数集成具体问题。

## 真实GPT-5.5结果

| 场景 | 输入token 原→新 | 验证 |
| --- | --- | --- |
| 标准交易预热 | 无AI | 配对输入/结果相等 |
| 自然语言 | 5997→1719（减少71.34%） | 配对输入/结果相等 |
| 仅修改金额 | 无AI | 再次确认、输入/结果相等 |
| 仅修改期限 | 无AI | 再次确认、输入/结果相等 |
| 复合修改 | 6049→1771（减少70.72%） | AI回退、重新确认、输入/结果相等 |
| 证券名称 | 5992→1714 | 实际候选归一化、输入/结果相等 |
| 多候选选择 | 5985→1499 | 实际选择步骤、输入/结果相等 |
| 标准一级申购 | 无AI | 证券代码完整、输入/结果相等 |

16/16条记录成功，逐对完整业务结果hash和规范化输入hash相等；正式测算每次实际执行。耗时及缓存输入/输出/推理token均保留于原始记录。此次未固定市场数据服务快照，测算日期/基线按原用例校验；不能将缓存输入视为未缓存输入，也不把输入减幅当作计费节省率。

另外5个真实AI边界用例全部通过：负数、零、含糊金额及中文数字金额在实际归一化后由实际Router确认执行入口拒绝；缺失金额进入freeform补充。调用边界全部设陷阱，因此这些边界用例正式测算/服务调用均为0。它们验证AI、只读主数据归一化与执行拒绝，不是企业微信平台回调测试。无效草稿进入确认阶段的既有交互表现仍然存在。

证据：[正常场景原始记录](benchmarks/risk-live-2026-09-08/intent-minimal-context-live-2/samples.jsonl)、[独立配对校验与统计](benchmarks/risk-live-2026-09-08/intent-minimal-statistics.json)、[金额边界汇总](benchmarks/risk-live-2026-09-08/intent-minimal-guards-live-1/summary.json)、[源码指纹及CI](benchmarks/risk-live-2026-09-08/intent-minimal-manifest.json)。

复现用正常链路harness `risk-intent-context-live.mjs`，配置`baselinePurpose: "risk-intent"`；传上一轮`intent-fix-client.mjs`和本轮`intent-minimal-client.mjs`，明确同模型对比。首个采样器漏设baselinePurpose，已受控停止并保留在`intent-minimal-context-live-1`，不计为6000token基线；正式结果仅用live-2。边界harness为`risk-intent-minimal-guards.mjs`。私有文本/配置及模型完整会话继续留在验收目录，不进入Git。

## 发布边界

本次修改和对应测试已完成，未提交、推送、合并、重启或部署。在线服务仍是旧制品。整体上线验收还需要原性能矩阵的充分采样、平台确认/终态测试以及已记录的既有风险AI用户停止映射缺口修复；本次没有更改该停止行为。
