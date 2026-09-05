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
  `): Promise<void> {\n  const submittedAt = Date.now();\n  if (durableTaskId) await taskStore.markRunning(durableTaskId);\n  try {\n    await withReservation(startingRuns, key, async () =>\n      runGate.run(async () => {\n        const queueWaitMs = Date.now() - submittedAt;`,
  `): Promise<void> {\n  const submittedAt = Date.now();\n  try {\n    await withReservation(startingRuns, key, async () =>\n      runGate.run(async () => {\n        if (durableTaskId) await taskStore.markRunning(durableTaskId);\n        const queueWaitMs = Date.now() - submittedAt;`,
  'mark running only after global admission',
);

replaceOnce(
  `    active.state = markInterrupted(active.state);\n    await active.run.stop();`,
  `    active.state = markInterrupted(active.state);\n    if (active.durableTaskId) {\n      await taskStore.markInterrupted(active.durableTaskId).catch(() => {});\n    }\n    await active.run.stop();`,
  'slash stop durable state',
);

const callbackStop = `      active.state = markInterrupted(active.state);\n      void active.run.stop().catch((err: unknown) => {\n        console.error(\`Failed to stop Codex run: \${err instanceof Error ? err.message : String(err)}\`);\n      });`;
const callbackReplacement = `      active.state = markInterrupted(active.state);\n      if (active.durableTaskId) {\n        void taskStore.markInterrupted(active.durableTaskId).catch(() => {});\n      }\n      void active.run.stop().catch((err: unknown) => {\n        console.error(\`Failed to stop Codex run: \${err instanceof Error ? err.message : String(err)}\`);\n      });`;
const matches = source.split(callbackStop).length - 1;
if (matches !== 2) throw new Error(`Expected 2 callback stop anchors, found ${matches}`);
source = source.split(callbackStop).join(callbackReplacement);

await writeFile(file, source);
await rm('scripts/apply-wecom-reliability-fixup.mjs', { force: true });
await rm('.github/workflows/wecom-reliability-fixup.yml', { force: true });
