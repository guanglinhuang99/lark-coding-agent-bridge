import { isAbsolute, relative, resolve, basename, extname } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { WeComMediaType } from '@wecom/aibot-node-sdk';

export interface WeComArtifactClient {
  uploadMedia(
    fileBuffer: Buffer,
    options: { type: WeComMediaType; filename: string },
  ): Promise<{ media_id: string }>;
  sendMediaMessage(target: string, mediaType: WeComMediaType, mediaId: string): Promise<unknown>;
}

export interface WeComArtifactSendResult {
  sent: Array<{ path: string; type: 'image' | 'file'; size: number }>;
  skipped: Array<{ path: string; reason: string }>;
}

export interface WeComArtifactSendOptions {
  maxCount?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  excludedPaths?: readonly string[];
}

const DEFAULT_MAX_COUNT = 5;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png']);

export async function sendLinkedWorkspaceArtifacts(
  client: WeComArtifactClient,
  target: string,
  workspace: string,
  markdown: string,
  options: WeComArtifactSendOptions = {},
): Promise<WeComArtifactSendResult> {
  const result: WeComArtifactSendResult = { sent: [], skipped: [] };
  const maxCount = positiveInt(options.maxCount, DEFAULT_MAX_COUNT);
  const maxFileBytes = positiveInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = positiveInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const workspaceReal = await realpath(workspace);
  const excluded = new Set(
    await Promise.all((options.excludedPaths ?? []).map((path) => realpath(path).catch(() => path))),
  );
  let totalBytes = 0;

  for (const linkedPath of extractLinkedLocalPaths(markdown)) {
    if (result.sent.length >= maxCount) {
      result.skipped.push({ path: linkedPath, reason: 'too-many-files' });
      continue;
    }
    const resolved = await resolveWorkspaceFile(linkedPath, workspaceReal);
    if (!resolved.ok) {
      result.skipped.push({ path: linkedPath, reason: resolved.reason });
      continue;
    }
    if (excluded.has(resolved.path)) {
      result.skipped.push({ path: linkedPath, reason: 'input-attachment' });
      continue;
    }
    if (resolved.size > maxFileBytes) {
      result.skipped.push({ path: linkedPath, reason: 'file-too-large' });
      continue;
    }
    if (totalBytes + resolved.size > maxTotalBytes) {
      result.skipped.push({ path: linkedPath, reason: 'total-too-large' });
      continue;
    }

    const type = mediaTypeForPath(resolved.path);
    const upload = await client.uploadMedia(await readFile(resolved.path), {
      type,
      filename: basename(resolved.path),
    });
    await client.sendMediaMessage(target, type, upload.media_id);
    totalBytes += resolved.size;
    result.sent.push({ path: resolved.path, type, size: resolved.size });
  }
  return result;
}

export function extractLinkedLocalPaths(markdown: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const pattern = /!?\[[^\]]*]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    let value = match[1] ?? '';
    if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the literal path when percent-decoding fails.
    }
    if (!isAbsolute(value) || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

async function resolveWorkspaceFile(
  linkedPath: string,
  workspaceReal: string,
): Promise<{ ok: true; path: string; size: number } | { ok: false; reason: string }> {
  let candidate = resolve(linkedPath);
  let fileStat = await stat(candidate).catch(() => undefined);
  if (!fileStat) {
    const withoutLine = candidate.replace(/:\d+(?::\d+)?$/, '');
    if (withoutLine !== candidate) {
      candidate = withoutLine;
      fileStat = await stat(candidate).catch(() => undefined);
    }
  }
  if (!fileStat || !fileStat.isFile()) return { ok: false, reason: 'missing-or-not-file' };

  const fileReal = await realpath(candidate).catch(() => undefined);
  if (!fileReal) return { ok: false, reason: 'unresolvable' };
  const rel = relative(workspaceReal, fileReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'outside-workspace' };
  }
  return { ok: true, path: fileReal, size: fileStat.size };
}

function mediaTypeForPath(path: string): 'image' | 'file' {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) ? 'image' : 'file';
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.floor(value as number);
}
