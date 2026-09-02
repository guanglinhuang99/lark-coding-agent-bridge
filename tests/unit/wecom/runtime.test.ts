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
  WeComConversationQueue,
  WeComConversationQueueError,
  WeComMessageDeduplicator,
  WeComRunCapacityError,
  WeComRunGate,
  WeComStreamReply,
  WeComStreamUpdatePump,
  type WeComControlCardClient,
  type WeComStreamClient,
  withActiveRun,
  withReservation,
  waitForCompletion,
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
        template_card_event: {
          event_key: 'submit',
          task_id: 'task-live',
          selected_items: {
            selected_item: [{ option_ids: { option_id: ['7'] } }],
          },
        },
      }),
    ).toEqual({ eventKey: 'submit', taskId: 'task-live', selectedId: '7' });
    expect(
      templateCardEventDetails({
        event_key: 'submit',
        task_id: 'task-sdk',
        selected_item: [{ option_id: '3' }],
      }),
    ).toEqual({ eventKey: 'submit', taskId: 'task-sdk', selectedId: '3' });
    expect(templateCardEventDetails({ event_key: 'stop', task_id: 'task-button' })).toEqual({
      eventKey: 'stop',
      taskId: 'task-button',
    });
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

  it('keeps one stream update in flight and replaces stale pending content', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const update = vi
      .fn<(content: string) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await firstBlocked;
        return true;
      })
      .mockResolvedValue(true);
    const finish = vi.fn(async () => true);
    const pump = new WeComStreamUpdatePump({ update, finish });

    pump.update('first');
    await Promise.resolve();
    for (let index = 0; index < 500; index++) pump.update(`burst-${index}`);
    expect(update).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await pump.flush();
    expect(update.mock.calls.map(([content]) => content)).toEqual(['first', 'burst-499']);
    expect(pump.snapshot()).toEqual({ sent: 2, coalesced: 499, failures: 0 });

    await expect(pump.finish('final')).resolves.toBe(true);
    expect(finish).toHaveBeenCalledWith('final');
  });

  it('does not let an intermediate stream update failure abort final delivery', async () => {
    const update = vi.fn(async () => {
      throw new Error('temporary transport failure');
    });
    const finish = vi.fn(async () => true);
    const pump = new WeComStreamUpdatePump({ update, finish });

    pump.update('progress');
    await pump.flush();
    expect(pump.snapshot().failures).toBe(1);
    await expect(pump.finish('final')).resolves.toBe(true);
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

  it('deduplicates message ids within a bounded TTL window', () => {
    let now = 1_000;
    const deduplicator = new WeComMessageDeduplicator(500, 2, () => now);

    expect(deduplicator.claim('msg-1')).toBe(true);
    expect(deduplicator.claim('msg-1')).toBe(false);
    expect(deduplicator.claim('msg-2')).toBe(true);

    // The bounded cache evicts the oldest id before admitting a third one.
    expect(deduplicator.claim('msg-3')).toBe(true);
    expect(deduplicator.claim('msg-1')).toBe(true);

    now += 501;
    expect(deduplicator.claim('msg-1')).toBe(true);
  });

  it('serializes work within one conversation and preserves FIFO order', async () => {
    const queue = new WeComConversationQueue(2, 1_000);
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const first = queue.submit('group:chat-a', async () => {
      order.push('first-start');
      await firstBlocked;
      order.push('first-end');
    });
    const second = queue.submit('group:chat-a', async () => {
      order.push('second');
    });
    const third = queue.submit('group:chat-a', async () => {
      order.push('third');
    });

    expect(first).toMatchObject({ queued: false, position: 0 });
    expect(second).toMatchObject({ queued: true, position: 1 });
    expect(third).toMatchObject({ queued: true, position: 2 });
    expect(queue.snapshot()).toEqual({ active: 1, queued: 2 });

    await Promise.resolve();
    releaseFirst?.();
    await Promise.all([first.completion, second.completion, third.completion]);
    expect(order).toEqual(['first-start', 'first-end', 'second', 'third']);
    expect(queue.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('runs different conversations independently while bounding each queue', async () => {
    const queue = new WeComConversationQueue(1, 1_000);
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const firstA = queue.submit(
      'group:chat-a',
      () => new Promise<void>((resolve) => {
        releaseA = resolve;
      }),
    );
    const firstB = queue.submit(
      'group:chat-b',
      () => new Promise<void>((resolve) => {
        releaseB = resolve;
      }),
    );
    const queuedA = queue.submit('group:chat-a', async () => {});

    expect(queue.snapshot()).toEqual({ active: 2, queued: 1 });
    expect(() => queue.submit('group:chat-a', async () => {})).toThrow(
      expect.objectContaining<Partial<WeComConversationQueueError>>({ reason: 'queue-full' }),
    );

    await Promise.resolve();
    releaseA?.();
    releaseB?.();
    await Promise.all([firstA.completion, firstB.completion, queuedA.completion]);
  });

  it('continues with the next conversation item after a task fails', async () => {
    const queue = new WeComConversationQueue(1, 1_000);
    const order: string[] = [];
    const failed = queue.submit('group:chat-a', async () => {
      order.push('failed');
      throw new Error('run failed');
    });
    const next = queue.submit('group:chat-a', async () => {
      order.push('next');
    });

    await expect(failed.completion).rejects.toThrow('run failed');
    await next.completion;
    expect(order).toEqual(['failed', 'next']);
  });

  it('expires stale conversation work and rejects queued work on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const queue = new WeComConversationQueue(2, 50);
      let releaseFirst: (() => void) | undefined;
      const first = queue.submit(
        'group:chat-a',
        () => new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
      );
      const expired = queue.submit('group:chat-a', async () => {});
      const expiredResult = expect(expired.completion).rejects.toMatchObject({
        reason: 'queue-timeout',
      });

      await vi.advanceTimersByTimeAsync(51);
      await expiredResult;
      const closing = queue.submit('group:chat-a', async () => {});
      const closingResult = expect(closing.completion).rejects.toMatchObject({
        reason: 'shutting-down',
      });
      queue.close();
      await closingResult;
      expect(() => queue.submit('group:chat-b', async () => {})).toThrow(
        expect.objectContaining<Partial<WeComConversationQueueError>>({
          reason: 'shutting-down',
        }),
      );

      releaseFirst?.();
      await first.completion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds global run concurrency and admits queued work in FIFO order', async () => {
    const gate = new WeComRunGate(1, 1, 1_000);
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const first = gate.run(async () => {
      order.push('first-start');
      await firstBlocked;
      order.push('first-end');
    });
    const second = gate.run(async () => {
      order.push('second-start');
    });

    await expect(gate.run(async () => {})).rejects.toMatchObject({
      name: 'WeComRunCapacityError',
      reason: 'queue-full',
    });
    expect(gate.snapshot()).toEqual({ active: 1, queued: 1 });

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('expires queued work instead of letting stale callbacks wait indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const gate = new WeComRunGate(1, 1, 50);
      let releaseFirst: (() => void) | undefined;
      const first = gate.run(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      );
      const queued = gate.run(async () => {});
      const queuedResult = expect(queued).rejects.toEqual(
        expect.objectContaining<Partial<WeComRunCapacityError>>({
          name: 'WeComRunCapacityError',
          reason: 'queue-timeout',
        }),
      );

      await vi.advanceTimersByTimeAsync(51);
      await queuedResult;
      expect(gate.snapshot()).toEqual({ active: 1, queued: 0 });

      releaseFirst?.();
      await first;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects queued and future work when the gate closes', async () => {
    const gate = new WeComRunGate(1, 1, 1_000);
    let releaseFirst: (() => void) | undefined;
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const queued = gate.run(async () => {});
    const queuedResult = expect(queued).rejects.toMatchObject({ reason: 'shutting-down' });

    gate.close();
    await queuedResult;
    await expect(gate.run(async () => {})).rejects.toMatchObject({ reason: 'shutting-down' });

    releaseFirst?.();
    await first;
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('holds the configured concurrency ceiling during a burst of queued work', async () => {
    const gate = new WeComRunGate(3, 200, 1_000);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        gate.run(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve(index);
          active--;
        }),
      ),
    );

    expect(maxActive).toBe(3);
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('bounds graceful cleanup without leaving a referenced timer behind', async () => {
    vi.useFakeTimers();
    try {
      const completed = waitForCompletion(Promise.resolve(), 50);
      await expect(completed).resolves.toBe(true);

      const timedOut = waitForCompletion(new Promise<void>(() => {}), 50);
      await vi.advanceTimersByTimeAsync(51);
      await expect(timedOut).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
