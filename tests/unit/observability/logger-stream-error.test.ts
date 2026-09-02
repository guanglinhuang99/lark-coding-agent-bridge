import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const fsMock = vi.hoisted(() => ({ createWriteStream: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.createWriteStream.mockImplementation(actual.createWriteStream);
  return { ...actual, createWriteStream: fsMock.createWriteStream };
});

const { closeLogger, configureLogger, log } = await import('../../../src/core/logger.js');

describe('logger stream failures', () => {
  afterEach(async () => {
    await closeLogger();
    fsMock.createWriteStream.mockClear();
    vi.restoreAllMocks();
  });

  it('handles asynchronous file errors and reopens logging on the next event', async () => {
    const tmp = await createTmpProfile('logger-stream-error-');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    configureLogger({
      logsDir: join(tmp.profile, 'logs'),
      now: () => new Date('2026-08-31T12:00:00.000Z'),
    });

    log.info('test', 'first');
    const first = fsMock.createWriteStream.mock.results[0]?.value as WriteStream;
    expect(() => first.emit('error', new Error('disk full'))).not.toThrow();
    expect(stderr).toHaveBeenCalledWith('Structured log stream failed: disk full');

    log.info('test', 'second');
    expect(fsMock.createWriteStream).toHaveBeenCalledTimes(2);

    await closeLogger();
    await tmp.cleanup();
  });
});
