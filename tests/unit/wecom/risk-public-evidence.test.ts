import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error Benchmark evidence helper is an executable .mjs fixture without a project declaration.
import * as publicEvidence from '../../../docs/benchmarks/risk-live-2026-09-08/harness/public-evidence.mjs';

const {
  evidenceForPath,
  isPublicEvidencePath,
  sanitizePublicEvidence,
} = publicEvidence;

const publicRoot = 'docs/benchmarks/risk-live-2026-09-08';
const sensitiveJsonField = /"(?:netAssets|newNetAssets|holdingsCount|net_assets|new_net_assets|holdings_count)"\s*:\s*([^,}\]\s]+)/g;
const narrativeNetAssetsNumber = /净资产[^。\n]{0,24}\b\d{6,}(?:\.\d+)?/u;

describe('risk public benchmark evidence redaction', () => {
  it('preserves private evidence but recursively nulls sensitive public fields', () => {
    const raw = {
      netAssets: 123_456_789.01,
      nested: {
        newNetAssets: 234_567_890.12,
        holdingsCount: 251,
        backend: { net_assets: 12, holdings_count: 3 },
      },
      rows: [{ new_net_assets: 13 }, { safe: 7 }],
    };
    const privatePath = '/private/tmp/wecom-live-20260908/run/samples.jsonl';
    const publicPath = resolve(publicRoot, 'fixture/samples.jsonl');

    expect(isPublicEvidencePath(privatePath)).toBe(false);
    expect(evidenceForPath(privatePath, raw)).toBe(raw);
    expect(isPublicEvidencePath(publicPath)).toBe(true);
    expect(evidenceForPath(publicPath, raw)).toEqual({
      netAssets: null,
      nested: {
        newNetAssets: null,
        holdingsCount: null,
        backend: { net_assets: null, holdings_count: null },
      },
      rows: [{ new_net_assets: null }, { safe: 7 }],
    });
    expect(raw.netAssets).toBe(123_456_789.01);
    expect(sanitizePublicEvidence(null)).toBeNull();
  });

  it('keeps sensitive fields null in the committed public evidence tree', () => {
    const grep = execFileSync(
      'git',
      [
        'grep', '-n', '-I', '-E',
        '"(netAssets|newNetAssets|holdingsCount|net_assets|new_net_assets|holdings_count)"[[:space:]]*:',
        'HEAD', '--', publicRoot,
      ],
      { encoding: 'utf8' },
    );
    const exposures: string[] = [];
    for (const line of grep.split(/\r?\n/u).filter(Boolean)) {
      for (const match of line.matchAll(sensitiveJsonField)) {
        if (match[1] !== 'null') exposures.push(`${line.slice(0, 180)} -> ${match[1]}`);
      }
    }
    expect(exposures).toEqual([]);
  });

  it('keeps long net-asset values out of committed narrative reports', () => {
    const reports = [
      'docs/risk-gpt55-completion-2026-09-08.md',
      'docs/risk-performance-live-2026-09-08.md',
      'docs/risk-spark-completion-2026-09-08.md',
    ];
    for (const report of reports) {
      const text = execFileSync('git', ['show', `HEAD:${report}`], { encoding: 'utf8' });
      expect(text, report).not.toMatch(narrativeNetAssetsNumber);
    }
  });
});
