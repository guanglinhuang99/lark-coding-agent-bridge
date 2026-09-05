import { readFile, writeFile, rm } from 'node:fs/promises';

const file = 'src/wecom/cli.ts';
let source = await readFile(file, 'utf8');

function replaceOnce(before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Non-unique patch anchor: ${label}`);
  }
  source = source.slice(0, index) + after + source.slice(index + before.length);
}

replaceOnce(
  `    await handleMessage(frame, durableTaskId);\n    if (durableTaskId) await taskStore.markDone(durableTaskId);`,
  `    await handleMessage(frame, durableTaskId);\n    if (durableTaskId) {\n      await taskStore.markDone(durableTaskId).catch((err: unknown) => {\n        log.fail('wecom-task', err, { step: 'mark-done' });\n        reportMetric('wecom_task_store_failures', 1, { step: 'mark-done' });\n      });\n    }`,
  'outer successful terminal persistence',
);

replaceOnce(
  `      if (durableTaskId) {\n        if (state.terminal === 'done') await taskStore.markDone(durableTaskId);\n        else if (state.terminal === 'interrupted') await taskStore.markInterrupted(durableTaskId);\n        else await taskStore.markFailed(durableTaskId, state.terminal);\n      }`,
  `      if (durableTaskId) {\n        const persistTerminal =\n          state.terminal === 'done'\n            ? taskStore.markDone(durableTaskId)\n            : state.terminal === 'interrupted'\n              ? taskStore.markInterrupted(durableTaskId)\n              : taskStore.markFailed(durableTaskId, state.terminal);\n        await persistTerminal.catch((err: unknown) => {\n          log.fail('wecom-task', err, { step: 'mark-terminal', terminal: state.terminal });\n          reportMetric('wecom_task_store_failures', 1, {\n            step: 'mark-terminal',\n            terminal: state.terminal,\n          });\n        });\n      }`,
  'codex terminal persistence',
);

await writeFile(file, source);
await rm('scripts/apply-wecom-terminal-persistence-fixup.mjs', { force: true });
await rm('.github/workflows/wecom-terminal-persistence-fixup.yml', { force: true });
