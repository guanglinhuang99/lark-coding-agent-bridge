import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectWeComHealth, WeComHealthStore } from '../../../src/wecom/health';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WeCom health state', () => {
  it('writes an atomic connected heartbeat and reports it healthy', async () => {
    const file = await healthPath();
    const now = new Date('2026-08-31T01:00:00.000Z');
    const store = new WeComHealthStore(file, 42, () => now);
    await store.update({
      phase: 'connected',
      connected: true,
      activeRuns: 1,
      startingRuns: 0,
    });

    await expect(
      inspectWeComHealth(file, {
        staleAfterMs: 90_000,
        now: () => now,
        isProcessAlive: (pid) => pid === 42,
      }),
    ).resolves.toMatchObject({
      healthy: true,
      reason: 'ok',
      snapshot: { pid: 42, phase: 'connected', activeRuns: 1 },
    });
  });

  it('distinguishes stale, disconnected, dead, missing, and invalid state', async () => {
    const file = await healthPath();
    const base = {
      schemaVersion: 1,
      pid: 42,
      startedAt: '2026-08-31T01:00:00.000Z',
      updatedAt: '2026-08-31T01:00:00.000Z',
      phase: 'connected',
      connected: true,
      activeRuns: 0,
      startingRuns: 0,
    };
    await writeFile(file, JSON.stringify(base), 'utf8');

    const stale = await inspectWeComHealth(file, {
      staleAfterMs: 1_000,
      now: () => new Date('2026-08-31T01:00:02.000Z'),
      isProcessAlive: () => true,
    });
    expect(stale.reason).toBe('stale');

    await writeFile(file, JSON.stringify({ ...base, connected: false, phase: 'reconnecting' }), 'utf8');
    const disconnected = await inspectWeComHealth(file, {
      staleAfterMs: 90_000,
      now: () => new Date(base.updatedAt),
      isProcessAlive: () => true,
    });
    expect(disconnected.reason).toBe('not-connected');

    await writeFile(file, JSON.stringify(base), 'utf8');
    const dead = await inspectWeComHealth(file, {
      staleAfterMs: 90_000,
      now: () => new Date(base.updatedAt),
      isProcessAlive: () => false,
    });
    expect(dead.reason).toBe('process-dead');

    const missing = await inspectWeComHealth(`${file}.missing`, { staleAfterMs: 90_000 });
    expect(missing.reason).toBe('missing');

    await writeFile(file, '{broken', 'utf8');
    const invalid = await inspectWeComHealth(file, { staleAfterMs: 90_000 });
    expect(invalid.reason).toBe('invalid');
  });

  it('treats an EPERM process probe as alive', async () => {
    const file = await healthPath();
    const now = new Date('2026-08-31T01:00:00.000Z');
    const store = new WeComHealthStore(file, 42, () => now);
    await store.update({
      phase: 'connected',
      connected: true,
      activeRuns: 0,
      startingRuns: 0,
    });
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    await expect(
      inspectWeComHealth(file, { staleAfterMs: 90_000, now: () => now }),
    ).resolves.toMatchObject({ healthy: true, reason: 'ok' });
    probe.mockRestore();
  });
});

async function healthPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wecom-health-'));
  roots.push(root);
  return join(root, 'health.json');
}
