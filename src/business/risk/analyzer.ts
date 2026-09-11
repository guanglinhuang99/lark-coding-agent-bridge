import type { AgentEvent, AgentRun } from '../../agent/types';
import { parseRiskIntentOutputPartial, type RiskAiDraft } from './intent';

/** Shared extraction semantics; channels own only process admission and presentation. */
export async function collectRiskIntent(run: AgentRun, input: {
  originalText: string; correction?: string; signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}): Promise<RiskAiDraft> {
  let output = '';
  let completed = false;
  const stop = () => { void run.stop().catch(() => {}); };
  input.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (input.signal?.aborted) throw new Error('Risk intent interrupted');
    for await (const event of run.events) {
      if (input.signal?.aborted) throw new Error('Risk intent interrupted');
      input.onEvent?.(event);
      if ((event.type === 'done' || event.type === 'error') && event.terminationReason === 'interrupted') {
        const error = new Error('Risk intent interrupted');
        error.name = 'RiskIntentInterruptedError';
        throw error;
      }
      if (event.type === 'error') throw new Error('Risk intent extraction failed');
      if (event.type === 'tool_use') throw new Error('Risk intent extraction must not execute tools');
      if (event.type === 'done') {
        if (event.terminationReason !== 'normal') throw new Error('Risk intent extraction did not complete');
        completed = true;
      }
      if (event.type === 'text') output += event.delta;
      if (event.type === 'final_text') output = event.content;
      if (output.length > 256_000) throw new Error('Risk intent response too large');
    }
    if (!completed || input.signal?.aborted) throw new Error('Risk intent extraction incomplete');
    await run.waitForExit(1500).catch(() => false);
    return parseRiskIntentOutputPartial(output, input.correction
      ? `${input.originalText} ${input.correction}` : input.originalText);
  } catch (error) {
    await run.stop().catch(() => {});
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', stop);
  }
}
