import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractLinkedLocalPaths,
  sendLinkedWorkspaceArtifacts,
} from '../../../src/wecom/egress';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WeCom generated-file egress', () => {
  it('extracts absolute Markdown targets, including angle-wrapped paths', () => {
    expect(
      extractLinkedLocalPaths(
        '[报告](/workspace/report.pdf) ![图](</workspace/chart 1.png>) [网页](https://example.com)',
      ),
    ).toEqual(['/workspace/report.pdf', '/workspace/chart 1.png']);
  });

  it('uploads and sends linked workspace files with image/file media types', async () => {
    const workspace = await tempRoot('wecom-egress-workspace-');
    const report = join(workspace, 'report.pdf');
    const chart = join(workspace, 'chart.png');
    await writeFile(report, 'report', 'utf8');
    await writeFile(chart, Buffer.from('89504e470d0a1a0a', 'hex'));
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({ media_id: 'media-file' })
      .mockResolvedValueOnce({ media_id: 'media-image' });
    const sendMediaMessage = vi.fn(async () => ({}));

    const result = await sendLinkedWorkspaceArtifacts(
      { uploadMedia, sendMediaMessage },
      'user-a',
      workspace,
      `[报告](${report}:12)\n![图](${chart})`,
    );

    expect(result.sent.map((item) => item.type)).toEqual(['file', 'image']);
    expect(uploadMedia).toHaveBeenNthCalledWith(
      1,
      Buffer.from('report'),
      { type: 'file', filename: 'report.pdf' },
    );
    expect(sendMediaMessage).toHaveBeenNthCalledWith(1, 'user-a', 'file', 'media-file');
    expect(sendMediaMessage).toHaveBeenNthCalledWith(2, 'user-a', 'image', 'media-image');
  });

  it('rejects paths outside the workspace, symlink escapes, and input attachments', async () => {
    const workspace = await tempRoot('wecom-egress-safe-');
    const outsideRoot = await tempRoot('wecom-egress-outside-');
    const outside = join(outsideRoot, 'secret.txt');
    const input = join(workspace, 'input.txt');
    const link = join(workspace, 'escape.txt');
    await writeFile(outside, 'secret', 'utf8');
    await writeFile(input, 'input', 'utf8');
    await symlink(outside, link);
    const uploadMedia = vi.fn(async () => ({ media_id: 'unused' }));
    const sendMediaMessage = vi.fn(async () => ({}));

    const result = await sendLinkedWorkspaceArtifacts(
      { uploadMedia, sendMediaMessage },
      'user-a',
      workspace,
      `[outside](${outside}) [escape](${link}) [input](${input})`,
      { excludedPaths: [input] },
    );

    expect(result.sent).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual([
      'outside-workspace',
      'outside-workspace',
      'input-attachment',
    ]);
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(sendMediaMessage).not.toHaveBeenCalled();
  });

  it('enforces per-file and count limits before upload', async () => {
    const workspace = await tempRoot('wecom-egress-limits-');
    const first = join(workspace, 'first.txt');
    const second = join(workspace, 'second.txt');
    await writeFile(first, '12345', 'utf8');
    await writeFile(second, '12', 'utf8');
    const uploadMedia = vi.fn(async () => ({ media_id: 'media' }));
    const sendMediaMessage = vi.fn(async () => ({}));

    const result = await sendLinkedWorkspaceArtifacts(
      { uploadMedia, sendMediaMessage },
      'user-a',
      workspace,
      `[first](${first}) [second](${second})`,
      { maxCount: 1, maxFileBytes: 4 },
    );

    expect(result.sent.map((item) => item.path)).toEqual([await realpath(second)]);
    expect(result.skipped).toEqual([{ path: first, reason: 'file-too-large' }]);
  });
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
