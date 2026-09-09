import { describe, expect, it } from 'vitest';
import {
  isRiskUserAllowedByConfig,
  readUseAllowedList,
} from '../../../src/wecom/risk/access';

describe('WeCom risk access configuration', () => {
  it('enables the allowlist by default and when explicitly set to 1', () => {
    expect(readUseAllowedList(undefined)).toBe(true);
    expect(readUseAllowedList('')).toBe(true);
    expect(readUseAllowedList(' 1 ')).toBe(true);
  });

  it('disables the allowlist only when explicitly set to 0', () => {
    expect(readUseAllowedList(' 0 ')).toBe(false);
  });

  it('rejects invalid flag values', () => {
    expect(() => readUseAllowedList('true')).toThrow('Invalid USE_ALLOWED_LIST');
  });

  it('enforces configured user IDs when enabled', () => {
    const allowed = new Set(['alice']);
    expect(isRiskUserAllowedByConfig(true, allowed, 'alice')).toBe(true);
    expect(isRiskUserAllowedByConfig(true, allowed, 'bob')).toBe(false);
    expect(isRiskUserAllowedByConfig(true, allowed, undefined)).toBe(false);
  });

  it('fails closed when the allowlist is enabled but empty', () => {
    expect(isRiskUserAllowedByConfig(true, new Set(), 'bob')).toBe(false);
    expect(isRiskUserAllowedByConfig(true, new Set(), undefined)).toBe(false);
  });

  it('allows every sender when disabled without deleting the configured list', () => {
    const allowed = new Set(['alice']);
    expect(isRiskUserAllowedByConfig(false, allowed, 'bob')).toBe(true);
    expect(isRiskUserAllowedByConfig(false, allowed, undefined)).toBe(true);
  });
});
