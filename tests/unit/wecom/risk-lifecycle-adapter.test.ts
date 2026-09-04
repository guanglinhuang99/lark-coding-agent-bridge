import { describe, expect, it } from 'vitest';
import {
  riskLifecycleErrorKind,
  riskLifecycleStatus,
  shouldKeepRiskCardInteractive,
} from '../../../src/wecom/risk/lifecycle-adapter';
import type { RiskSelectionResolution } from '../../../src/wecom/risk/card';

describe('WeCom risk lifecycle compatibility adapter', () => {
  it('preserves selected and invalid semantics without collapsing them into lifecycle errors', () => {
    const selected = { status: 'selected' } as RiskSelectionResolution;
    const invalid = { status: 'invalid' } as RiskSelectionResolution;

    expect(riskLifecycleStatus(selected)).toBe('selected');
    expect(riskLifecycleErrorKind(selected)).toBeUndefined();
    expect(shouldKeepRiskCardInteractive(selected)).toBe(false);

    expect(riskLifecycleStatus(invalid)).toBe('invalid');
    expect(riskLifecycleErrorKind(invalid)).toBeUndefined();
    expect(shouldKeepRiskCardInteractive(invalid)).toBe(true);
  });

  it('maps mismatch separately from missing and expired', () => {
    const mismatch = { status: 'mismatch' } as RiskSelectionResolution;
    const missing = { status: 'missing' } as RiskSelectionResolution;
    const expired = { status: 'expired' } as RiskSelectionResolution;

    expect(riskLifecycleErrorKind(mismatch)).toBe('callback-invalid');
    expect(riskLifecycleErrorKind(missing)).toBe('callback-expired');
    expect(riskLifecycleErrorKind(expired)).toBe('callback-expired');
  });
});
