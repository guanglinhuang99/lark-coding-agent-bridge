import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@wecom/aibot-node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWeComAgentPrompt,
  collectWeComMediaInputs,
  promptContextFromWeComMessage,
  textFromWeComMessage,
  WeComMediaStore,
} from '../../../src/wecom/media';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WeCom media ingress', () => {
  it('downloads and stores a decrypted image with a content hash and 0600 mode', async () => {
    const root = await mediaRoot();
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const downloadFile = vi.fn(async () => ({ buffer: png, filename: '../截图.png' }));
    const store = new WeComMediaStore({ downloadFile }, root);

    const attachments = await store.resolve([
      {
        kind: 'image',
        url: 'https://example.test/encrypted',
        aesKey: 'aes-key',
        messageId: 'msg-1',
      },
    ]);

    expect(downloadFile).toHaveBeenCalledWith('https://example.test/encrypted', 'aes-key');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      decision: 'accepted',
      kind: 'image',
      mime: 'image/png',
      source: 'wecom',
      originalName: '截图.png',
    });
    expect(await readFile(attachments[0]!.absPath)).toEqual(png);
    expect((await stat(attachments[0]!.absPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects an oversized download without persisting it', async () => {
    const root = await mediaRoot();
    const store = new WeComMediaStore(
      { downloadFile: async () => ({ buffer: Buffer.alloc(12), filename: 'large.pdf' }) },
      root,
    );
    const [attachment] = await store.resolve(
      [{ kind: 'file', url: 'https://example.test/file', messageId: 'msg-2' }],
      { maxFileBytes: 10 },
    );

    expect(attachment?.decision).toBe('rejected');
    expect(attachment?.rejectionReason).toBe('file-too-large');
    await expect(access(attachment!.absPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries transient network download failures', async () => {
    const root = await mediaRoot();
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const downloadFile = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' }))
      .mockRejectedValueOnce(Object.assign(new Error('timeout exceeded'), { code: 'ECONNABORTED' }))
      .mockResolvedValue({ buffer: png, filename: 'retry.png' });
    const store = new WeComMediaStore({ downloadFile }, root);

    const [attachment] = await store.resolve([
      { kind: 'image', url: 'https://example.test/retry', messageId: 'msg-retry' },
    ]);

    expect(downloadFile).toHaveBeenCalledTimes(3);
    expect(attachment?.decision).toBe('accepted');
  });

  it('does not retry permanent client errors', async () => {
    const root = await mediaRoot();
    const error = Object.assign(new Error('forbidden'), { response: { status: 403 } });
    const downloadFile = vi.fn().mockRejectedValue(error);
    const store = new WeComMediaStore({ downloadFile }, root);

    await expect(
      store.resolve([{ kind: 'file', url: 'https://example.test/forbidden', messageId: 'msg-403' }]),
    ).rejects.toBe(error);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it('downloads multiple attachments with bounded concurrency and preserves input order', async () => {
    const root = await mediaRoot();
    let active = 0;
    let maxActive = 0;
    const downloadFile = vi.fn(async (url: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active--;
      const suffix = Number(url.at(-1));
      return {
        buffer: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([suffix])]),
        filename: `${suffix}.png`,
      };
    });
    const store = new WeComMediaStore({ downloadFile }, root);

    const attachments = await store.resolve(
      [1, 2, 3, 4].map((value) => ({
        kind: 'image' as const,
        url: `https://example.test/${value}`,
        messageId: 'msg-concurrency',
      })),
      { downloadConcurrency: 2, downloadTimeoutMs: 1_000 },
    );

    expect(maxActive).toBe(2);
    expect(attachments.map((attachment) => attachment.originalName)).toEqual([
      '1.png',
      '2.png',
      '3.png',
      '4.png',
    ]);
  });

  it('applies one deadline to the whole attachment batch', async () => {
    const root = await mediaRoot();
    const downloadFile = vi.fn(() => new Promise<never>(() => {}));
    const store = new WeComMediaStore({ downloadFile }, root);
    const resolving = store.resolve(
      [1, 2, 3].map((value) => ({
        kind: 'file' as const,
        url: `https://example.test/${value}`,
        messageId: 'msg-timeout',
      })),
      { downloadConcurrency: 2, downloadTimeoutMs: 20 },
    );

    await expect(resolving).rejects.toMatchObject({ name: 'WeComMediaTimeoutError' });
    expect(downloadFile).toHaveBeenCalledTimes(2);
  });

  it('collects direct, mixed, and quoted media without duplicating URLs', () => {
    const body = {
      msgid: 'msg-3',
      aibotid: 'bot-1',
      chattype: 'single',
      from: { userid: 'user-1' },
      msgtype: 'mixed',
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: '检查图片' } },
          { msgtype: 'image', image: { url: 'https://example.test/a', aeskey: 'a-key' } },
        ],
      },
      quote: {
        msgtype: 'image',
        image: { url: 'https://example.test/a', aeskey: 'a-key' },
      },
    } as BaseMessage;

    expect(textFromWeComMessage(body)).toBe('检查图片');
    expect(collectWeComMediaInputs(body)).toEqual([
      {
        kind: 'image',
        url: 'https://example.test/a',
        aesKey: 'a-key',
        messageId: 'msg-3',
      },
    ]);
  });

  it('builds a prompt with accepted paths and an explicit output-link contract', () => {
    const prompt = buildWeComAgentPrompt(
      '请生成报告',
      [
        {
          absPath: '/workspace/input.pdf',
          path: '/workspace/input.pdf',
          kind: 'file',
          size: 42,
          mime: 'application/pdf',
          hash: 'hash',
          source: 'wecom',
          sourceMessageId: 'msg-4',
          sourceFileKey: 'resource',
          originalName: 'input.pdf',
          requiredness: 'optional',
          decision: 'accepted',
        },
      ],
      {
        senderUserId: 'user-1',
        senderName: '张三',
        chatType: 'group',
        chatId: 'chat-1',
      },
    );

    expect(prompt).toContain('/workspace/input.pdf');
    expect(prompt).toContain('请生成报告');
    expect(prompt).toContain('绝对路径 Markdown 链接');
    expect(prompt).toContain('<wecom_context>');
    expect(prompt).toContain('"userid":"user-1"');
    expect(prompt).toContain('"name":"张三"');
    expect(prompt).toContain('"chattype":"group"');
    expect(prompt).toContain('"chatid":"chat-1"');
  });

  it('extracts an optional sender name and group identity from the callback', () => {
    const body = {
      msgid: 'msg-group-context',
      aibotid: 'bot-1',
      chattype: 'group',
      chatid: 'chat-2',
      from: { userid: 'user-3', name: ' 李四 ' },
      msgtype: 'text',
      text: { content: '汇总一下' },
    } as BaseMessage;

    expect(promptContextFromWeComMessage(body)).toEqual({
      senderUserId: 'user-3',
      senderName: '李四',
      chatType: 'group',
      chatId: 'chat-2',
    });
  });

  it('adds sender and private-chat context to every prompt without inventing a name', () => {
    const body = {
      msgid: 'msg-context',
      aibotid: 'bot-1',
      chattype: 'single',
      from: { userid: 'user-2' },
      msgtype: 'text',
      text: { content: '继续上一个问题' },
    } as BaseMessage;

    const prompt = buildWeComAgentPrompt(
      textFromWeComMessage(body),
      [],
      promptContextFromWeComMessage(body),
    );

    expect(prompt).toContain('<wecom_context>');
    expect(prompt).toContain('"userid":"user-2"');
    expect(prompt).toContain('"name":null');
    expect(prompt).toContain('"chattype":"single"');
    expect(prompt).toContain('"chatid":null');
    expect(prompt).toContain('继续上一个问题');
  });
});

async function mediaRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wecom-media-'));
  roots.push(root);
  return root;
}
