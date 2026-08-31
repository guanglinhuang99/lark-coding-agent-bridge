import type { TemplateCard, WsFrameHeaders } from '@wecom/aibot-node-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  conversationKey,
  messageTarget,
  normalizeCardAction,
  normalizeIncomingText,
  readSandbox,
  readStreamMaxBytes,
  sendControlCard,
  templateCardEventDetails,
  WeComStreamReply,
  type WeComControlCardClient,
  type WeComStreamClient,
  withActiveRun,
  withReservation,
} from '../../../src/wecom/runtime';

describe('WeCom runtime contracts', () => {
  it('isolates single and group conversation keys', () => {
    expect(conversationKey({ chattype: 'single', from: { userid: 'user-a' } })).toBe(
      'single:user-a',
    );
    expect(
      conversationKey({ chattype: 'group', chatid: 'chat-a', from: { userid: 'user-a' } }),
    ).toBe('group:chat-a');
    expect(() => conversationKey({ chattype: 'group', from: { userid: 'user-a' } })).toThrow(
      'missing chatid',
    );
  });

  it('targets standalone cards to the current single user or group chat', () => {
    expect(messageTarget({ chattype: 'single', from: { userid: 'user-a' } })).toBe('user-a');
    expect(
      messageTarget({ chattype: 'group', chatid: 'chat-a', from: { userid: 'user-a' } }),
    ).toBe('chat-a');
    expect(() => messageTarget({ chattype: 'group', from: { userid: 'user-a' } })).toThrow(
      'missing chatid',
    );
  });

  it('routes only the supported card event keys', () => {
    expect(normalizeCardAction('stop')).toBe('stop');
    expect(normalizeCardAction('new')).toBe('new');
    expect(normalizeCardAction('status')).toBe('status');
    expect(normalizeCardAction('unexpected')).toBe('unknown');
    expect(normalizeCardAction(undefined)).toBe('unknown');
  });

  it('reads the live nested template-card event shape with a flat SDK fallback', () => {
    expect(
      templateCardEventDetails({
        template_card_event: { event_key: 'status', task_id: 'task-live' },
      }),
    ).toEqual({ eventKey: 'status', taskId: 'task-live' });
    expect(
      templateCardEventDetails({ event_key: 'stop', task_id: 'task-sdk' }),
    ).toEqual({ eventKey: 'stop', taskId: 'task-sdk' });
    expect(templateCardEventDetails(undefined)).toEqual({});
  });

  it('removes the leading bot mention from group messages before command routing', () => {
    expect(normalizeIncomingText('@riskbot@codex /status', 'group')).toBe('/status');
    expect(normalizeIncomingText('@riskbot@codex\u00a0请只读检查', 'group')).toBe(
      '请只读检查',
    );
    expect(normalizeIncomingText('/status', 'group')).toBe('/status');
    expect(normalizeIncomingText('@riskbot@codex /status', 'single')).toBe(
      '@riskbot@codex /status',
    );
  });

  it('defaults to read-only and rejects an invalid sandbox', () => {
    expect(readSandbox(undefined)).toBe('read-only');
    expect(readSandbox('workspace-write')).toBe('workspace-write');
    expect(() => readSandbox('unsafe')).toThrow('Invalid WECOM_CODEX_SANDBOX');
  });

  it('always reserves protocol headroom below the 20480-byte limit', () => {
    expect(readStreamMaxBytes(undefined)).toBe(20_000);
    expect(readStreamMaxBytes('20480')).toBe(20_000);
    expect(readStreamMaxBytes('12000')).toBe(12_000);
    expect(readStreamMaxBytes('invalid')).toBe(20_000);
  });

  it('sends one standalone card, reuses one stream id, and finishes once', async () => {
    const calls: StreamCall[] = [];
    const client = fakeStreamClient(calls);
    const cardCalls: CardCall[] = [];
    const cardClient = fakeCardClient(cardCalls);
    const frame: WsFrameHeaders = { headers: { req_id: 'req-1' } };
    const card: TemplateCard = { card_type: 'button_interaction', task_id: 'task-1' };
    const stream = new WeComStreamReply(client, frame, 'stream-1');

    await stream.start('first');
    await sendControlCard(
      cardClient,
      { chattype: 'single', from: { userid: 'user-a' } },
      card,
    );
    await stream.update('second');
    expect(await stream.finish('final')).toBe(true);
    expect(await stream.finish('duplicate')).toBe(false);

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.streamId)).toEqual(['stream-1', 'stream-1', 'stream-1']);
    expect(calls.map((call) => call.finish)).toEqual([false, false, true]);
    expect(cardCalls).toEqual([
      {
        target: 'user-a',
        body: { msgtype: 'template_card', template_card: card },
      },
    ]);
  });

  it('does not retry finish=true after a final transport failure', async () => {
    const finish = vi.fn(async () => {
      throw new Error('transport failed');
    });
    const client: WeComStreamClient = { replyStream: finish };
    const stream = new WeComStreamReply(
      client,
      { headers: { req_id: 'req-2' } },
      'stream-2',
    );

    await expect(stream.finish('final')).rejects.toThrow('transport failed');
    await expect(stream.finish('duplicate')).resolves.toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('cleans the active-run registry after success and failure', async () => {
    const runs = new Map<string, { id: string }>();
    const success = { id: 'success' };
    await withActiveRun(runs, 'single:user-a', success, async () => {
      expect(runs.get('single:user-a')).toBe(success);
    });
    expect(runs.has('single:user-a')).toBe(false);

    const failure = { id: 'failure' };
    await expect(
      withActiveRun(runs, 'single:user-a', failure, async () => {
        throw new Error('run failed');
      }),
    ).rejects.toThrow('run failed');
    expect(runs.has('single:user-a')).toBe(false);
  });

  it('reserves a conversation before the first asynchronous startup step', async () => {
    const reservations = new Set<string>();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withReservation(reservations, 'single:user-a', async () => blocked);
    expect(reservations.has('single:user-a')).toBe(true);
    await expect(
      withReservation(reservations, 'single:user-a', async () => {}),
    ).rejects.toThrow('already reserved');

    release?.();
    await first;
    expect(reservations.has('single:user-a')).toBe(false);
  });
});

interface StreamCall {
  streamId: string;
  finish: boolean | undefined;
}

interface CardCall {
  target: string;
  body: { msgtype: 'template_card'; template_card: TemplateCard };
}

function fakeStreamClient(calls: StreamCall[]): WeComStreamClient {
  return {
    async replyStream(_frame, streamId, _content, finish) {
      calls.push({ streamId, finish });
    },
  };
}

function fakeCardClient(calls: CardCall[]): WeComControlCardClient {
  return {
    async sendMessage(target, body) {
      calls.push({ target, body });
    },
  };
}
