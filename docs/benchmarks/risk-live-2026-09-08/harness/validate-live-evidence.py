#!/usr/bin/env python3
"""Independently recompute paired summaries from sanitized benchmark records."""
import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path

results = []
for directory in map(Path, sys.argv[1:]):
    rows = [json.loads(line) for line in (directory / 'samples.jsonl').read_text().splitlines()]
    summary = json.loads((directory / 'summary.json').read_text())
    groups = defaultdict(list)
    for row in rows:
        assert row['commit'] == summary['versions'][row['version']]
        groups[(row['scenario'], row['pair'])].append(row)
    for (scenario, pair), batch in groups.items():
        expected_order = ['before', 'after'] if pair % 2 == 0 else ['after', 'before']
        assert [row['version'] for row in batch] == expected_order, (directory, scenario, pair)
        if all(row['success'] for row in batch):
            assert batch[0]['resultHash'] == batch[1]['resultHash'], (scenario, pair, 'business mismatch')
    for scenario, report in summary['scenarios'].items():
        if report['status'] != 'sampled':
            continue
        for version in ['before', 'after']:
            subset = [row for row in rows if row['version'] == version and row['scenario'] == scenario]
            values = sorted(row['totalMs'] for row in subset if row['success'])
            observed = report[version]
            assert observed['n'] == len(subset)
            assert observed['success'] == len(values)
            assert observed['failures'] == len(subset) - len(values)
            assert math.isclose(observed['successRate'], len(values) / len(subset))
            if values:
                assert math.isclose(observed['median'], statistics.median(values), abs_tol=1e-8)
                assert math.isclose(observed['p95'], values[math.ceil(.95 * len(values)) - 1], abs_tol=1e-8)
            assert observed['backendRequests'] == sum(sum(row['backendRequests'].values()) for row in subset)
        old, new = report['before']['median'], report['after']['median']
        assert math.isclose(report['absoluteReductionMs'], old - new, abs_tol=1e-8)
        assert math.isclose(report['reductionPercent'], 100 * (1 - new / old), abs_tol=1e-8)
    results.append({'directory': directory.name, 'rows': len(rows), 'pairedGroups': len(groups),
                    'failures': sum(not row['success'] for row in rows), 'validation': 'pass'})
print(json.dumps({'results': results, 'checks': ['fixed commits', 'AB/BA order', 'business hashes',
      'N and failures', 'median', 'nearest-rank P95', 'request counts', 'reduction formula']}, indent=2))
