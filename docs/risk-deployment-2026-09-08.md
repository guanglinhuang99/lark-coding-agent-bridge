# 风险意图优化部署记录（2026-09-08）

> 最新追加：已改用GPT-5.5补齐四类30对真实采样，仍有数据日期异常与展示门禁，详见[GPT-5.5追加验收](risk-gpt55-completion-2026-09-08.md)。

> 本轮后续：模型已切回Spark，新增平台与边界验收、真实采样及额度阻塞见 [Spark追加验收](risk-spark-completion-2026-09-08.md)。

用户明确授权部署后，已更新 riskbot@codex，12:39:22（Asia/Shanghai）新版重新认证成功。风险意图使用 gpt-5.5 / low；普通聊天仍为原 gpt-5.6-luna / max。最终平台 `/status` 为 READY、排队 0，健康文件 connected=true、activeRuns=0、startingRuns=0，PID 65599。

## 发布制品与验证

- 发布目录：`/Users/guanglin/.lark-channel/releases/wecom-risk-20260908-40e196ce3872`。
- 制品 SHA256：`40e196ce3872a0a616b195646a6561dbeaad204e5a8be95ed21ebc50e0403fed`。
- 源码基于本地 HEAD `79f7a75faf54220f4f7b6d72064974c812b176e0` 加未提交的风险上下文和停止修复；具体文件 hash 见 manifest。未推送、合并或创建提交。
- 隔离 `pnpm run ci:platform` 最终退出 0：151 文件、1098 项通过，1 项受控 benchmark 跳过，类型检查和构建通过。Python dispatcher 4 项通过，diff 检查通过。
- 停止回归覆盖启动等待、运行中迟到 JSON、模型中断终态、正常完成。首次测试时序及 TypeScript 冗余判断失败已修复，最终 CI 为修复后的源码。
- Node 24.19.0、pnpm 10.33.0；Python 3.12.8，azpy 1.9.0、pandas 3.0.2、pins 0.9.1、openpyxl 3.1.5。

## 平台实际验证

在已授权的“bot 测试”群，仅向 riskbot@codex 发送模拟文本：

1. 自然语言申购正确进入确认，未提前执行测算；实际模型日志为 gpt-5.5。
2. 金额从 1000 万元修改为 2000 万元，账户/操作保留并再次确认；修改未再启动 AI。
3. 用户侧发送“确认”后，实际 calculate_pretrade 成功，耗时 22.897 秒（首次后台准备包含在内）。平台显示测算日 2026-09-07，2000 万元≈0.2 亿元，测算前 PASS 6、测算后 PASS 6，无新增超限。最终结果未被旧进度覆盖。
4. 下一次 AI 请求发出 `/stop`，实际分析 outcome=interrupted，子进程退出，未出现迟到确认卡、未执行第二次测算。此次停止与模型输出接近，验证了迟到结果抑制；启动等待由回归测试覆盖。
5. 随后 `/status` 显示 READY、排队 0。

平台本次自然语言输入 2297 token、输出 146（其中推理 104），缓存输入 0，来源为该调用的 Codex token_count。不能把隔离用例 1719 token 当作此次线上实测。Bridge JSON 日志中的 token 字段被现有通用脱敏器隐藏，因此此处从模型原始会话中只提取数字；原始提示词和完整会话不纳入 Git。

## 发布环境故障与处理

12:34 首次切换虽连接成功，但真实请求的 Python 启动超过 30 秒，立即回滚原配置并确认恢复连接。诊断表明 LaunchAgent 下解释器阻塞在读取虚拟环境配置，桥接脚本尚未执行；终端同环境 ping 正常。没有将超时归为 AI 或数据库耗时。

将原 Python 环境依赖复制到发布目录 `python-runtime`，保留原解释器版本和包版本。后台一次性诊断验证：启动 ready 约 0.388 秒，真实查询返回 251 产品。之后重新切换并完成上述平台测试。原 Documents 环境、共享 .env、主目录 dist、原状态均保留；第一次失败日志和状态保存在发布目录 `*-first-attempt`。未修改系统隐私设置，未停止 Lark 或其他 Bot。

## 回滚

原制品 SHA256：`434ec142377872e864c5298d9082cd5f2ce5015e13bb121548afa9f6c5f073a8`。原制品对应提交未确认，不将固定对比旧提交冒充原线上版本。

回滚命令（仅在决定回滚时执行）：

```sh
python3 /Users/guanglin/.lark-channel/releases/wecom-risk-20260908-40e196ce3872/rollback.py
```

脚本停止唯一目标 LaunchAgent，等待其 PID 退出，恢复 original.plist 后启动原制品及原状态。之后检查 `/Users/guanglin/.lark-channel/wecom/health.json` 的新 PID、更新时间和 connected=true，并在测试群确认 `/status` READY。原状态为切换前快照；上线后的新会话记录不会自动合并回原状态，需保留发布目录用于核对。第一次部署失败时已实际执行过此回滚流程并验证恢复。

## 证据与边界

[发布清单与源码指纹](benchmarks/risk-live-2026-09-08/deployment/manifest.json)、[完整 CI 日志](benchmarks/risk-live-2026-09-08/deployment/ci-final.log)。发布后的健康和平台冒烟通过，但不是完整平台矩阵验收：平台重复按钮回调、候选选择、确认过期及全部 30 配对 AI 性能场景仍未完成，既有本地测试和隔离证据继续有效。运行中数据库调用没有协作取消能力，不能声称 `/stop` 中断 SQL。
