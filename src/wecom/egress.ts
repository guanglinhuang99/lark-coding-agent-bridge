import { createHash } from 'node:crypto';
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
  requestedAttachments?: readonly ReceivedArtifact[];
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
  const requested = new Map((options.requestedAttachments ?? []).map((item) => [item.path, item]));
  let totalBytes = 0;
  let attempts = 0;
  const processed = new Set<string>();

  // Explicit requests use trusted provenance even if the model omits the link.
  const paths = new Set([...extractLinkedLocalPaths(markdown), ...requested.keys()]);
  for (const linkedPath of paths) {
    const resolved = await resolveWorkspaceFile(linkedPath, workspaceReal, requested);
    if (!resolved.ok) {
      result.skipped.push({ path: linkedPath, reason: resolved.reason });
      continue;
    }
    if (processed.has(resolved.path)) continue;
    processed.add(resolved.path);
    if (attempts >= maxCount) {
      result.skipped.push({ path: linkedPath, reason: 'too-many-files' });
      continue;
    }
    if (excluded.has(resolved.path) && !requested.has(resolved.path)) {
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

    const received = requested.get(resolved.path);
    const type = mediaTypeForPath(resolved.path);
    try {
      const buffer = await readFile(resolved.path);
      if (received && createHash('sha256').update(buffer).digest('hex') !== received.hash) {
        result.skipped.push({ path: linkedPath, reason: 'input-attachment-changed' });
        continue;
      }
      if (buffer.length > maxFileBytes || totalBytes + buffer.length > maxTotalBytes) {
        result.skipped.push({ path: linkedPath, reason: 'file-size-changed' });
        continue;
      }
      attempts++;
      totalBytes += buffer.length;
      const upload = await client.uploadMedia(buffer, {
        type,
        filename: received?.name ?? basename(resolved.path),
      });
      await client.sendMediaMessage(target, type, upload.media_id);
      result.sent.push({ path: resolved.path, type, size: buffer.length });
    } catch {
      result.skipped.push({ path: linkedPath, reason: 'upload-or-send-failed' });
    }
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
  requested: ReadonlyMap<string, ReceivedArtifact>,
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
  if ((rel.startsWith('..') || isAbsolute(rel)) && !requested.has(fileReal)) {
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

/** Only populated from successfully received attachments, never model output. */
export interface ReceivedArtifact {
  path: string;
  hash: string;
  name: string;
}

/** Bounded, process-local provenance. Restarting requires re-uploading inputs. */
export class ReceivedArtifactRegistry {
  private readonly sessions = new Map<string, ReceivedArtifact[]>();

  get(scope: string): ReceivedArtifact[] {
    return [...(this.sessions.get(scope) ?? [])];
  }

  remember(scope: string, attachments: readonly ReceivedArtifact[]): void {
    const files = new Map(this.get(scope).map((item) => [item.path, item]));
    for (const item of attachments) files.set(item.path, item);
    this.sessions.delete(scope);
    this.sessions.set(scope, [...files.values()].slice(-20));
    while (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value!);
  }
}

export function requestedReceivedArtifacts(
  text: string,
  attachments: readonly ReceivedArtifact[],
): ReceivedArtifact[] {
  // Conservative opt-in from the user's message, not attachment contents or the agent.
  if (/不要|别|不必|无需|勿|don't|do not|never/i.test(text)) return [];
  if (/[？?]|能否|是否|怎么|如何/.test(text)) return [];
  if (!/^(?:请|麻烦)?\s*(?:(?:把|将)[^\n]+(?:回传|发回|传回|发送|发)给我|(?:回传|发回|传回|发送给我|发给我)\s*[^\n]+)|^(?:please\s+)?(?:send\s+[^\n]+\s+back|return\s+)/i.test(text.trim())) return [];
  return attachments.filter((item) => {
    const escaped = item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return item.name.length > 0 && new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`).test(text);
  });
}

export function artifactDeliverySummary(result: WeComArtifactSendResult): string | undefined {
  if (!result.sent.length && !result.skipped.length) return undefined;
  return `文件回传结果：已确认发送 ${result.sent.length} 个，未确认发送 ${result.skipped.length} 个。` +
    (result.skipped.length
      ? ' 未确认发送的文件可能不在允许范围、已变化、超出限额或发送失败；回执超时时可能已经送达，请核对附件后再试。模型文字中的“已回传”不代表发送成功。若要回传原附件，请重新上传并明确写出文件名。'
      : '以上数量以桥接程序实际发送结果为准。');
}
