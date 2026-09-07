import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';

/** Stable deployment identity. Never use a process id or a connection id here. */
export interface BridgeIdentity {
  channel: 'lark' | 'wecom';
  accountId: string;
  instanceId: string;
}

export interface SessionBindingIdentity {
  scopeId: string;
  agentId: 'claude' | 'codex';
  cwdRealpath: string;
  policyFingerprint: string;
}

export function bridgeIdentityKey(identity: BridgeIdentity): string {
  if (!identity || !['lark', 'wecom'].includes(identity.channel) ||
      !nonempty(identity.accountId) || !nonempty(identity.instanceId)) {
    throw new Error('Invalid bridge identity');
  }
  return JSON.stringify([1, identity.channel, identity.accountId, identity.instanceId]);
}

export function conversationIdentityKey(identity: BridgeIdentity, scopeId: string): string {
  if (!nonempty(scopeId)) throw new Error('Invalid conversation scope');
  return JSON.stringify([bridgeIdentityKey(identity), scopeId]);
}

export function sessionBindingKey(identity: BridgeIdentity, session: SessionBindingIdentity): string {
  if (!['claude', 'codex'].includes(session.agentId) ||
      !nonempty(session.cwdRealpath) || !nonempty(session.policyFingerprint)) {
    throw new Error('Invalid session binding identity');
  }
  return JSON.stringify([
    conversationIdentityKey(identity, session.scopeId), session.agentId,
    session.cwdRealpath, session.policyFingerprint,
  ]);
}

export function canonicalWorkspace(cwd: string): string {
  const resolved = realpathSync(cwd);
  if (!statSync(resolved).isDirectory()) throw new Error('Workspace is not a directory');
  return resolved;
}

/** Hash configuration dimensions without persisting credentials or raw environment values. */
export function bindingPolicyFingerprint(dimensions: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(dimensions)).digest('hex');
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
