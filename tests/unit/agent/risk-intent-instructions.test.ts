import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RISK_INTENT_INSTRUCTIONS,
  riskIntentInstructionsFile,
} from '../../../src/agent/codex/risk-intent-instructions.js';

describe('risk-intent instruction file', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('is idempotent and leaves no temporary files', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'risk-intent-instructions-'));
    cleanup.push(stateDir);

    const first = riskIntentInstructionsFile(stateDir);
    const second = riskIntentInstructionsFile(stateDir);

    expect(second).toBe(first);
    expect(await readFile(first, 'utf8')).toBe(RISK_INTENT_INSTRUCTIONS);
    expect(await readdir(join(stateDir, 'risk-intent'))).toEqual([basename(first)]);
  });

  it('repairs a damaged versioned file and cleans its temporary file', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'risk-intent-instructions-'));
    cleanup.push(stateDir);

    const file = riskIntentInstructionsFile(stateDir);
    await writeFile(file, 'damaged instructions', 'utf8');

    expect(riskIntentInstructionsFile(stateDir)).toBe(file);
    expect(await readFile(file, 'utf8')).toBe(RISK_INTENT_INSTRUCTIONS);
    expect(await readdir(join(stateDir, 'risk-intent'))).toEqual([basename(file)]);
  });
});
