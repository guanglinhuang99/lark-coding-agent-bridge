import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';
import { createRiskBusinessRuntime, type RiskBusinessSnapshot } from '../runtime/risk-business';
import type { ActiveRuns } from '../bridge/active-runs';
import type { ProcessPool } from '../bridge/process-pool';
import type { BridgeIdentity } from '../bridge/identity';
import { businessConversationKey, businessWorkspaceScope } from '../business/identity';
import { RiskApplication, riskIntentInputPrompt, type RiskArrival, type RiskIngress, type RiskRequest, type RiskReply } from '../business/risk/application';
import { buildIntentSelection } from '../business/risk/intent';
import { splitRiskMessage } from '../business/risk/presentation';
export { splitRiskMessage as splitLarkRiskMessage } from '../business/risk/presentation';

export interface LarkRiskAdapter {
  start?(): Promise<void>;
  snapshot?(): RiskBusinessSnapshot;
  markArrival?(): RiskArrival;
  capture?(msg: NormalizedMessage, scope: string, workspace?: string, arrival?: RiskArrival): RiskIngress;
  handle(msg: NormalizedMessage, scope: string, workspace?: string, ingress?: RiskIngress): Promise<boolean>;
  close(): Promise<void>;
}

/** No query/calculation rules here: this adapter maps identity and sends views. */
export function createLarkRiskAdapter(input: {
  channel: LarkChannel; identity: BridgeIdentity; stateDir: string;
  pool: ProcessPool; activeRuns: ActiveRuns; env?: NodeJS.ProcessEnv;
  application?: RiskApplication; authorized?: (senderId: string) => boolean;
}): LarkRiskAdapter {
  const env = input.env ?? process.env;
  // Deliberately do not inherit another channel's user IDs or disable its ACL.
  const allowed = new Set((env.LARK_RISK_ALLOWED_USERIDS ?? '').split(/[,，\s]+/).filter(Boolean));
  const authorized = input.authorized ?? ((id: string) => Boolean(id) &&
    (env.LARK_RISK_USE_ALLOWED_LIST === '0' || allowed.has(id)));
  const runtime = createRiskBusinessRuntime({ ...input, env,
    accessEnabled: () => env.LARK_RISK_USE_ALLOWED_LIST === '0' || allowed.size > 0,
  });
  const { application } = runtime;
  const keyFor = (scope: string, actor: string, workspace?: string) =>
    businessConversationKey(input.identity, businessWorkspaceScope(scope, workspace), actor);
  const requestFor = (msg: NormalizedMessage, scope: string, workspace?: string): RiskRequest => ({
    key: keyFor(scope, msg.senderId, workspace), text: msg.content, authorized: authorized(msg.senderId),
    hasAttachments: msg.resources.length > 0, maxMessageBytes: 3500,
  });
  const controlReplies = new Set<Promise<void>>();
  const send = async (msg: NormalizedMessage, content: string) => {
    for (const page of splitRiskMessage(content)) {
      await input.channel.send(msg.chatId, { markdown: page }, {
        replyTo: msg.messageId, ...(msg.threadId ? { replyInThread: true } : {}),
      });
    }
  };
  return {
    start: () => runtime.start(),
    snapshot: () => runtime.snapshot(),
    markArrival: () => application.markArrival(),
    capture: (msg, scope, workspace, arrival) => application.capture(requestFor(msg, scope, workspace), arrival),
    async handle(msg, scope, workspace, ingress) {
      const key = keyFor(scope, msg.senderId, workspace);
      if (['/stop', '/new'].includes(msg.content.trim().toLowerCase())) {
        const cancellation = application.cancel(key);
        ingress?.release();
        if (msg.content.trim().toLowerCase() === '/stop') {
          // Hand off to the ordinary stop handler immediately, not after a network reply.
          const delivery = (async () => {
            for (const content of renderLarkRiskReply(cancellation)) await send(msg, content);
          })().catch(error => log.fail('risk-stop-reply', error));
          controlReplies.add(delivery);
          void delivery.then(() => controlReplies.delete(delivery), () => controlReplies.delete(delivery));
        }
        return false; // The standard command handler still handles its agent/session state.
      }
      const reply = await application.handle(requestFor(msg, scope, workspace), ingress);
      if (!reply.handled) return false;
      for (const content of renderLarkRiskReply(reply)) await send(msg, content);
      return true;
    },
    async close() {
      try { await runtime.close(); }
      finally { await Promise.allSettled([...controlReplies]); }
    },
  };
}

export function renderLarkRiskReply(reply: RiskReply): string[] {
  if (!reply.handled) return [];
  if (reply.kind === 'pages') return reply.pages;
  if (reply.kind === 'notice') return [`**${reply.title}**\n\n${reply.lines.join('\n')}`];
  if (reply.kind === 'result') return [reply.result.markdown];
  const state = reply.state;
  if (state.stage === 'freeform') return [riskIntentInputPrompt(state)];
  const selection = buildIntentSelection(state, Date.now() + 300_000);
  return [`**${selection.title}**\n\n${selection.subTitle}\n\n` +
    selection.options.map(option => `\`${option.key}\`：${option.label}`).join('\n') +
    '\n\n请回复选项代码，也可以直接补充或修改；只有明确确认后才会执行测算。'];
}
