import type { AgentRun, AgentRunOptions } from '../agent/types';
import type { RunExecutor } from '../bridge/run-executor';
import type { RunPermit } from '../bridge/process-pool';

/** Permissions come from WeCom configuration; the shared executor owns the process. */
export async function startWeComAgentRun(
  executor: RunExecutor, options: AgentRunOptions, scopeId: string, permit?: RunPermit,
): Promise<AgentRun> {
  const execution = await executor.submit({
    runId: options.runId,
    scopeId: JSON.stringify(['wecom', scopeId]),
    policy: {
      prompt: options.prompt, cwdRealpath: options.cwd ?? process.cwd(),
      expiresAt: Number.POSITIVE_INFINITY,
      sandbox: options.sandbox, permissionMode: options.permissionMode,
      accessMode: options.sandbox ?? 'configured',
    },
    sessionId: options.sessionId, threadId: options.threadId, model: options.model,
    reasoningEffort: options.reasoningEffort, images: options.images,
    stopGraceMs: options.stopGraceMs, permit,
    observability: { profile: 'wecom', agent: 'codex', source: 'wecom', stage: 'agent' },
  });
  return {
    runId: execution.runId, events: execution.subscribe(), stop: () => execution.stop(),
    waitForExit: (timeoutMs) => execution.run.waitForExit(timeoutMs),
  };
}
