# 新版严格输入本地验收

```sh
/opt/homebrew/opt/node@24/bin/node docs/benchmarks/risk-live-2026-09-08/harness/risk-live-strict-chain.mjs \
  --root /private/tmp/wecom-live-20260908 \
  --cases /private/tmp/wecom-live-20260908/strict-chain-private.json \
  --out /private/tmp/wecom-live-20260908/NEW-STRICT-RESULT
```

在当前真实性能采样结束后执行。入口固定 after 提交并核对 src 未变；构建产物、客户端状态均在输出目录。私有用例包含 python、service 和 cases，cases 使用主 benchmark 的规范化 expected 格式。不要将实际文本用例提交 Git。

此模式在创建 AI adapter 前禁用模型调用。严格格式使用实际产品和证券查询、原始意图规范化、卡片构建、任务注册表以及 Router 正式测算；每例记录脱敏输入与业务哈希、真实方法次数和确认断言。

`expectFallback: true` 仅表示该文本必须要求 AI 回退且不能启动测算。它不提供任何 AI 输出，不证明真实模型能正确处理该文本。其通过条件为原始链路实际请求回退、工具明确中止回退、calculate_pretrade 调用次数为零。

这是候选版本功能验收，无旧版性能对照、无企业微信连接或真实卡片回调。首次与重复请求分别记录，但不能用这些单次功能样本计算上线提速收益。模型授权后仍须单独完成真实 AI 链路及配对样本。
