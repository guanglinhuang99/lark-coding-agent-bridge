import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ReceivedArtifactRegistry, requestedReceivedArtifacts, sendLinkedWorkspaceArtifacts, artifactDeliverySummary } from '../../../src/wecom/egress';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'received-artifacts-'));
  roots.push(root);
  const path = join(await realpath(root), 'input.txt');
  await writeFile(path, 'original');
  const workspace = await mkdtemp(join(tmpdir(), 'artifact-workspace-'));
  roots.push(workspace);
  const item = { path, name: 'input.txt', hash: createHash('sha256').update('original').digest('hex') };
  const client = { uploadMedia: vi.fn(async () => ({ media_id: 'm' })), sendMediaMessage: vi.fn(async () => ({})) };
  return { item, workspace, client };
}

it('returns a named received attachment on a later explicit request in the same session', async () => {
  const { item, workspace, client } = await fixture();
  const registry = new ReceivedArtifactRegistry();
  registry.remember('conversation-a:thread-1', [item]);
  const requestedAttachments = requestedReceivedArtifacts('请把 input.txt 原样回传给我', registry.get('conversation-a:thread-1'));
  const result = await sendLinkedWorkspaceArtifacts(client, 'a', workspace, `[input](${item.path}:12)`, { requestedAttachments, excludedPaths: [item.path] });
  expect(result.sent).toHaveLength(1);
  expect(client.uploadMedia).toHaveBeenCalledWith(Buffer.from('original'), { type: 'file', filename: 'input.txt' });
  expect(artifactDeliverySummary(result)).toContain('已确认发送 1 个，未确认发送 0 个');
});

it('does not authorize implicit, negated, unnamed, other-conversation or new-session returns', async () => {
  const { item, workspace, client } = await fixture();
  const registry = new ReceivedArtifactRegistry();
  registry.remember('a:1', [item]);
  for (const [scope, text] of [['a:1', '总结 input.txt'], ['a:1', '解释 input.txt 是否可以回传'], ['a:1', '回传 other-input.txt'], ['a:1', '不要回传 input.txt'], ['a:1', '回传 other.txt'], ['b:1', '回传 input.txt'], ['a:2', '回传 input.txt']] as const) {
    const requestedAttachments = requestedReceivedArtifacts(text, registry.get(scope));
    expect(requestedAttachments).toEqual([]);
    const result = await sendLinkedWorkspaceArtifacts(client, 'a', workspace, `[input](${item.path})`, { requestedAttachments });
    expect(result.skipped[0]?.reason).toBe('outside-workspace');
    expect(artifactDeliverySummary(result)).toContain('已确认发送 0 个，未确认发送 1 个');
  }
  expect(client.uploadMedia).not.toHaveBeenCalled();
});

it('rejects modified contents and a symlink substituted for the received file', async () => {
  const { item, workspace, client } = await fixture();
  await writeFile(item.path, 'modified');
  const options = { requestedAttachments: [item] };
  const first = await sendLinkedWorkspaceArtifacts(client, 'a', workspace, `[input](${item.path})`, options);
  expect(first.skipped[0]?.reason).toBe('input-attachment-changed');
  const secret = join(item.path, '..', 'secret.txt');
  await writeFile(secret, 'secret');
  await rm(item.path);
  await symlink(secret, item.path);
  const second = await sendLinkedWorkspaceArtifacts(client, 'a', workspace, `[input](${item.path})`, options);
  expect(second.skipped[0]?.reason).toBe('outside-workspace');
  expect(client.uploadMedia).not.toHaveBeenCalled();
});

it('retains size limits for explicitly requested inputs', async () => {
  const { item, workspace, client } = await fixture();
  const result = await sendLinkedWorkspaceArtifacts(client, 'a', workspace, `[input](${item.path})`, { requestedAttachments: [item], maxFileBytes: 2 });
  expect(result.skipped[0]?.reason).toBe('file-too-large');
  expect(client.uploadMedia).not.toHaveBeenCalled();
});

it('reports an upload or send failure as unsent', async () => {
  const { item, workspace, client } = await fixture();
  for (const failing of ['uploadMedia', 'sendMediaMessage'] as const) {
    client[failing].mockRejectedValueOnce(new Error('delivery failed'));
    const result = await sendLinkedWorkspaceArtifacts(client, 'a', workspace, `[input](${item.path})`, { requestedAttachments: [item] });
    expect(result.sent).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('upload-or-send-failed');
    expect(artifactDeliverySummary(result)).toContain('已确认发送 0 个，未确认发送 1 个');
  }
});

it('bounds provenance and forgets it on process restart', () => {
  const registry = new ReceivedArtifactRegistry();
  const items = Array.from({ length: 30 }, (_, i) => ({ path: `/cache/${i}`, name: `${i}`, hash: 'x' }));
  registry.remember('first', items);
  expect(registry.get('first')).toHaveLength(20);
  for (let i = 0; i < 100; i++) registry.remember(String(i), items);
  expect(registry.get('first')).toEqual([]);
  expect(new ReceivedArtifactRegistry().get('99')).toEqual([]);
});


it('sends an explicitly requested known input even when the model omits a link', async () => {
  const { item, workspace, client } = await fixture();
  const result = await sendLinkedWorkspaceArtifacts(client, 'a', workspace, '已回传 input.txt', { requestedAttachments: [item] });
  expect(result.sent).toHaveLength(1);
  expect(client.sendMediaMessage).toHaveBeenCalledTimes(1);
});

it('bounds failed upload attempts as well as successful sends', async () => {
  const { item, workspace, client } = await fixture();
  const second = join(workspace, 'second.txt');
  await writeFile(second, 'other');
  client.uploadMedia.mockRejectedValue(new Error('upload failed'));
  const result = await sendLinkedWorkspaceArtifacts(client, 'a', workspace, `[first](${item.path}) [second](${second})`, { requestedAttachments: [item], maxCount: 1 });
  expect(client.uploadMedia).toHaveBeenCalledTimes(1);
  expect(result.skipped.map((file) => file.reason)).toEqual(['upload-or-send-failed', 'too-many-files']);
  client.uploadMedia.mockClear();
  const byteLimited = await sendLinkedWorkspaceArtifacts(client, 'a', workspace, `[first](${item.path}) [second](${second})`, { requestedAttachments: [item], maxCount: 5, maxTotalBytes: 10 });
  expect(client.uploadMedia).toHaveBeenCalledTimes(1);
  expect(byteLimited.skipped.map((file) => file.reason)).toEqual(['upload-or-send-failed', 'total-too-large']);
});
