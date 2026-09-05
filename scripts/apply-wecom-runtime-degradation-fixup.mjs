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
  `  let durableTaskId: string | undefined;\n  if (messageId && frame.body) {\n    const claim = await taskStore.claimInbound(messageId, conversationKey(frame.body));\n    if (!claim.accepted) {\n      log.info('wecom-message', 'duplicate-durable', { status: claim.task.status });\n      reportMetric('wecom_duplicate_message', 1, { layer: 'durable' });\n      return;\n    }\n    durableTaskId = claim.task.id;\n    if (claim.replayed) {\n      log.info('wecom-task', 'replayed-after-restart', { taskId: durableTaskId });\n      reportMetric('wecom_task_replayed_after_restart', 1);\n    }\n  }`,
  `  let durableTaskId: string | undefined;\n  if (messageId && frame.body) {\n    try {\n      const claim = await taskStore.claimInbound(messageId, conversationKey(frame.body));\n      if (!claim.accepted) {\n        log.info('wecom-message', 'duplicate-durable', { status: claim.task.status });\n        reportMetric('wecom_duplicate_message', 1, { layer: 'durable' });\n        return;\n      }\n      durableTaskId = claim.task.id;\n      if (claim.replayed) {\n        log.info('wecom-task', 'replayed-after-restart', { taskId: durableTaskId });\n        reportMetric('wecom_task_replayed_after_restart', 1);\n      }\n    } catch (err) {\n      // Do not drop a valid user message because the optional durable ledger is temporarily unwritable.\n      // The existing in-memory dedupe remains active for this process; report the degraded state.\n      log.fail('wecom-task', err, { step: 'claim' });\n      reportMetric('wecom_task_store_failures', 1, { step: 'claim' });\n    }\n  }`,
  'degrade task-store claim failure',
);

replaceOnce(
  `async function replyDoctor(frame: WsFrame, key: string): Promise<void> {\n  const taskSnapshot = taskStore.snapshot();\n  const riskConfigured = Boolean(riskPython || configuredRiskServiceDir);\n  const circuitOpen = ['codex-history', 'media-download'].some(\n    (name) => operationRunner.snapshot(name).state === 'open',\n  );\n  const dependencies = [`,
  `async function replyDoctor(frame: WsFrame, key: string): Promise<void> {\n  const taskSnapshot = taskStore.snapshot();\n  const riskConfigured = Boolean(riskPython || configuredRiskServiceDir);\n  const codexAvailability = await operationRunner\n    .run('codex-health', () => codex.checkAvailability(), {\n      idempotent: true,\n      maxAttempts: 1,\n      timeoutMs: 6_000,\n    })\n    .catch((err: unknown) => {\n      log.fail('wecom-doctor', err, { dependency: 'codex' });\n      return undefined;\n    });\n  const circuitOpen = ['codex-health', 'codex-history', 'media-download'].some(\n    (name) => operationRunner.snapshot(name).state === 'open',\n  );\n  const dependencies = [`,
  'real codex doctor check',
);

replaceOnce(
  `    { name: 'Codex', status: 'ok', detail: effectiveModel(key) || 'default model' },`,
  `    {\n      name: 'Codex',\n      status: codexAvailability?.ok ? 'ok' : 'error',\n      detail: codexAvailability?.ok\n        ? codexAvailability.version || effectiveModel(key) || 'available'\n        : codexAvailability\n          ? codexAvailability.diagnostic.code\n          : 'health check failed',\n    },`,
  'codex dependency status',
);

replaceOnce(
  `      taskStore.recent(key, 5).find((task) => task.status !== 'queued' && task.status !== 'running'),`,
  `      taskStore\n        .recent(key, 10)\n        .find(\n          (task) =>\n            task.kind !== 'command' && task.status !== 'queued' && task.status !== 'running',\n        ),`,
  'prefer substantive recent task',
);

await writeFile(file, source);
await rm('scripts/apply-wecom-runtime-degradation-fixup.mjs', { force: true });
await rm('.github/workflows/wecom-runtime-degradation-fixup.yml', { force: true });
