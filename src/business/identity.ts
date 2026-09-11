import { bridgeIdentityKey, type BridgeIdentity } from '../bridge/identity';

/** Shared business code does not mean shared identities or shared permissions. */
export function businessConversationKey(identity: BridgeIdentity, scopeId: string, actorId: string): string {
  if (!scopeId.trim() || !actorId.trim()) throw new Error('Business conversation requires scope and actor');
  return JSON.stringify([bridgeIdentityKey(identity), 'business', scopeId, actorId]);
}

/** Freeze the selected workspace into the business scope, before any transport waits. */
export function businessWorkspaceScope(scopeId: string, workspace: string | undefined): string {
  return JSON.stringify(['workspace-v1', scopeId, workspace ?? null]);
}

export function businessConversationScope(key: string): string {
  try {
    const value: unknown = JSON.parse(key);
    if (Array.isArray(value) && value.length === 4 && value[1] === 'business' && typeof value[2] === 'string') {
      return value[2];
    }
  } catch { /* Compatibility with explicitly supplied opaque test/legacy keys. */ }
  return key;
}
