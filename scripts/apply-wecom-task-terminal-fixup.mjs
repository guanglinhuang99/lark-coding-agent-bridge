import { readFile, writeFile, rm } from 'node:fs/promises';

const file = 'src/wecom/cli.ts';
let source = await readFile(file, 'utf8');

function replaceOnce(before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) throw new Error(`Non-unique patch anchor: ${label}`);
  source = source.slice(0, index) + after + source.slice(index + before.length);
}

replaceOnce(
  `  } catch (err) {\n    if (!(err instanceof WeComConversationQueueError)) throw err;\n    reportMetric('wecom_conversation_queue_rejected', 1, { reason: err.reason });\n    await replyOnce(frame, '⚠️ 当前会话排队较多', [`,
  `  } catch (err) {\n    if (!(err instanceof WeComConversationQueueError)) throw err;\n    if (durableTaskId) await taskStore.markFailed(durableTaskId, err.reason).catch(() => {});\n    reportMetric('wecom_conversation_queue_rejected', 1, { reason: err.reason });\n    await replyOnce(frame, '⚠️ 当前会话排队较多', [`,
  'conversation submit rejection',
);

replaceOnce(
  `      await deliverErrorCard(frame, 'execution');\n      return;\n    }\n    reportMetric('wecom_conversation_queue_rejected', 1, { reason: err.reason });`,
  `      await deliverErrorCard(frame, 'execution');\n      if (durableTaskId) await taskStore.markFailed(durableTaskId, failureKind(err)).catch(() => {});\n      return;\n    }\n    if (durableTaskId) await taskStore.markFailed(durableTaskId, err.reason).catch(() => {});\n    reportMetric('wecom_conversation_queue_rejected', 1, { reason: err.reason });`,
  'queued execution terminal failure',
);

replaceOnce(
  `    reportMetric('wecom_run_rejected', 1, { reason: err.reason });\n    await stream.finish(`,
  `    reportMetric('wecom_run_rejected', 1, { reason: err.reason });\n    if (durableTaskId) await taskStore.markFailed(durableTaskId, err.reason).catch(() => {});\n    await stream.finish(`,
  'global run gate rejection',
);

await writeFile(file, source);
await rm('scripts/apply-wecom-task-terminal-fixup.mjs', { force: true });
await rm('.github/workflows/wecom-task-terminal-fixup.yml', { force: true });
