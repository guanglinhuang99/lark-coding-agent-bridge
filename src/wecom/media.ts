import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import type {
  BaseMessage,
  FileContent,
  ImageContent,
  MixedContent,
} from '@wecom/aibot-node-sdk';
import { safeJsonStringify } from '../agent/prompt';
import {
  normalizeAttachments,
  type AttachmentCandidate,
  type AttachmentPolicyOptions,
  type NormalizedAttachment,
} from '../media/attachment';
import { writeFileAtomic } from '../platform/atomic-write';

export interface WeComDownloadClient {
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

export interface WeComMediaInput {
  kind: 'image' | 'file';
  url: string;
  aesKey?: string;
  messageId: string;
}

export interface WeComMediaResolveOptions extends Partial<AttachmentPolicyOptions> {
  cacheMaxAgeMs?: number;
}

interface DownloadedCandidate {
  candidate: AttachmentCandidate;
  buffer: Buffer;
}

const KNOWN_FILE_EXTENSIONS = new Set([
  'csv',
  'doc',
  'docx',
  'json',
  'md',
  'pdf',
  'ppt',
  'pptx',
  'txt',
  'xls',
  'xlsm',
  'xlsx',
  'zip',
]);

export class WeComMediaStore {
  constructor(
    private readonly client: WeComDownloadClient,
    private readonly rootDir: string,
  ) {}

  async resolve(
    inputs: readonly WeComMediaInput[],
    options: WeComMediaResolveOptions = {},
  ): Promise<NormalizedAttachment[]> {
    if (inputs.length === 0) return [];
    await mkdir(this.rootDir, { recursive: true });

    const downloaded: DownloadedCandidate[] = [];
    for (const input of inputs) {
      const result = await downloadWithRetry(this.client, input);
      downloaded.push(toCandidate(input, result.buffer, result.filename, this.rootDir));
    }

    const normalized = normalizeAttachments(
      downloaded.map((item) => item.candidate),
      options,
    );
    const buffers = new Map(downloaded.map((item) => [item.candidate.hash, item.buffer]));
    for (const attachment of normalized) {
      if (attachment.decision !== 'accepted') continue;
      const buffer = buffers.get(attachment.hash);
      if (!buffer) continue;
      try {
        await stat(attachment.absPath);
      } catch {
        await writeFileAtomic(attachment.absPath, buffer, { mode: 0o600 });
      }
    }

    if (typeof options.cacheMaxAgeMs === 'number') {
      await gcWeComMediaCache(this.rootDir, options.cacheMaxAgeMs);
    }
    return normalized;
  }
}

async function downloadWithRetry(
  client: WeComDownloadClient,
  input: WeComMediaInput,
): Promise<{ buffer: Buffer; filename?: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await client.downloadFile(input.url, input.aesKey);
    } catch (err: unknown) {
      lastError = err;
      if (attempt === 3 || !isRetryableDownloadError(err)) throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

function isRetryableDownloadError(err: unknown): boolean {
  const item = err as {
    code?: unknown;
    message?: unknown;
    response?: { status?: unknown };
  };
  const status = item.response?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }
  const code = typeof item.code === 'string' ? item.code.toUpperCase() : '';
  if (
    code === 'ECONNABORTED' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ETIMEDOUT'
  ) {
    return true;
  }
  const message = typeof item.message === 'string' ? item.message : '';
  return /network|socket|timed?\s*out|tls connection/i.test(message);
}

export function collectWeComMediaInputs(body: BaseMessage): WeComMediaInput[] {
  const inputs: WeComMediaInput[] = [];
  if (body.msgtype === 'image' && isImageContent(body.image)) {
    inputs.push(mediaInput('image', body.image, body.msgid));
  } else if (body.msgtype === 'file' && isFileContent(body.file)) {
    inputs.push(mediaInput('file', body.file, body.msgid));
  } else if (body.msgtype === 'mixed' && isMixedContent(body.mixed)) {
    inputs.push(...mixedInputs(body.mixed, body.msgid));
  }

  const quote = body.quote;
  if (quote?.msgtype === 'image' && quote.image) {
    inputs.push(mediaInput('image', quote.image, body.msgid));
  } else if (quote?.msgtype === 'file' && quote.file) {
    inputs.push(mediaInput('file', quote.file, body.msgid));
  } else if (quote?.msgtype === 'mixed' && quote.mixed) {
    inputs.push(...mixedInputs(quote.mixed, body.msgid));
  }
  return dedupeInputs(inputs);
}

export function textFromWeComMessage(body: BaseMessage): string {
  if (body.msgtype === 'text' && isTextContent(body.text)) return body.text.content;
  if (body.msgtype !== 'mixed' || !isMixedContent(body.mixed)) return '';
  return body.mixed.msg_item
    .filter((item) => item.msgtype === 'text' && item.text)
    .map((item) => item.text?.content ?? '')
    .filter(Boolean)
    .join('\n');
}

export function buildWeComAgentPrompt(
  userText: string,
  attachments: readonly NormalizedAttachment[],
): string {
  const accepted = attachments
    .filter((attachment) => attachment.decision === 'accepted')
    .map((attachment) => ({
      path: attachment.absPath,
      kind: attachment.kind,
      mime: attachment.mime,
      size: attachment.size,
      originalName: attachment.originalName,
    }));
  const unavailable = attachments
    .filter((attachment) => attachment.decision !== 'accepted')
    .map((attachment) => ({
      kind: attachment.kind,
      originalName: attachment.originalName,
      decision: attachment.decision,
      reason: attachment.rejectionReason,
    }));
  const text = userText.trim() || (accepted.length > 0 ? '请查看附件。' : '请回复这条消息。');
  if (attachments.length === 0) {
    return `${outputInstruction()}\n\n${text}`;
  }
  const metadata = safeJsonStringify({ accepted, unavailable });
  return [
    outputInstruction(),
    '<wecom_attachments>',
    metadata,
    '</wecom_attachments>',
    text,
  ].join('\n\n');
}

export async function gcWeComMediaCache(rootDir: string, maxAgeMs: number): Promise<number> {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(rootDir, entry.name);
    try {
      const fileStat = await stat(file);
      if (fileStat.mtimeMs >= cutoff) continue;
      await rm(file, { force: true });
      removed++;
    } catch {
      // Cache cleanup is best-effort.
    }
  }
  return removed;
}

function toCandidate(
  input: WeComMediaInput,
  buffer: Buffer,
  downloadedName: string | undefined,
  rootDir: string,
): DownloadedCandidate {
  const hash = createHash('sha256').update(buffer).digest('hex');
  const originalName = sanitizeFilename(downloadedName);
  const mime = input.kind === 'image' ? sniffImageMime(buffer) : mimeFromFilename(originalName);
  const extension = safeDownloadedExtension(input.kind, originalName, mime);
  const absPath = join(rootDir, `${hash}.${extension}`);
  return {
    buffer,
    candidate: {
      absPath,
      kind: input.kind,
      size: buffer.length,
      mime,
      hash,
      source: 'wecom',
      sourceMessageId: input.messageId,
      sourceFileKey: createHash('sha256').update(input.url).digest('hex').slice(0, 24),
      ...(originalName ? { originalName } : {}),
    },
  };
}

function mixedInputs(mixed: MixedContent, messageId: string): WeComMediaInput[] {
  return mixed.msg_item
    .filter((item) => item.msgtype === 'image' && item.image)
    .map((item) => mediaInput('image', item.image as ImageContent, messageId));
}

function mediaInput(
  kind: 'image' | 'file',
  content: ImageContent | FileContent,
  messageId: string,
): WeComMediaInput {
  return {
    kind,
    url: content.url,
    ...(content.aeskey ? { aesKey: content.aeskey } : {}),
    messageId,
  };
}

function dedupeInputs(inputs: readonly WeComMediaInput[]): WeComMediaInput[] {
  const seen = new Set<string>();
  return inputs.filter((input) => {
    const key = `${input.kind}:${input.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const safe = basename(value).replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim();
  return safe || undefined;
}

function safeDownloadedExtension(
  kind: 'image' | 'file',
  filename: string | undefined,
  mime: string,
): string {
  if (kind === 'image') {
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/png') return 'png';
    if (mime === 'image/gif') return 'gif';
    if (mime === 'image/webp') return 'webp';
    return 'bin';
  }
  const extension = extname(filename ?? '').slice(1).toLowerCase();
  return KNOWN_FILE_EXTENSIONS.has(extension) ? extension : 'bin';
}

function sniffImageMime(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function mimeFromFilename(filename: string | undefined): string {
  const extension = extname(filename ?? '').slice(1).toLowerCase();
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'json') return 'application/json';
  if (extension === 'md') return 'text/markdown';
  if (extension === 'txt' || extension === 'csv') return 'text/plain';
  if (extension === 'zip') return 'application/zip';
  return 'application/octet-stream';
}

function outputInstruction(): string {
  return [
    '企业微信桥接约定：附件元数据只供本地处理，不要原样复述标签。',
    '若创建了需要回传给用户的文件，请在最终回答中使用绝对路径 Markdown 链接；仅链接工作区内确实需要回传的文件。',
  ].join('\n');
}

function isImageContent(value: unknown): value is ImageContent {
  return Boolean(value && typeof value === 'object' && typeof (value as ImageContent).url === 'string');
}

function isFileContent(value: unknown): value is FileContent {
  return Boolean(value && typeof value === 'object' && typeof (value as FileContent).url === 'string');
}

function isMixedContent(value: unknown): value is MixedContent {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Array.isArray((value as MixedContent).msg_item),
  );
}

function isTextContent(value: unknown): value is { content: string } {
  return Boolean(value && typeof value === 'object' && typeof (value as { content?: unknown }).content === 'string');
}
