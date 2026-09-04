import type { RiskSelectionResolution } from './card';

export type RiskLifecycleStatus = RiskSelectionResolution['status'];
export type RiskLifecycleErrorKind = 'callback-expired' | 'callback-invalid';

/**
 * Compatibility contract for a future migration of RiskSelectionTaskRegistry
 * onto the shared card lifecycle registry. Keep Risk's user-visible semantics
 * explicit instead of collapsing invalid/mismatch/expired/missing together.
 */
export function riskLifecycleStatus(resolution: RiskSelectionResolution): RiskLifecycleStatus {
  return resolution.status;
}

export function riskLifecycleErrorKind(
  resolution: RiskSelectionResolution,
): RiskLifecycleErrorKind | undefined {
  switch (resolution.status) {
    case 'selected':
    case 'invalid':
      return undefined;
    case 'mismatch':
      return 'callback-invalid';
    case 'missing':
    case 'expired':
      return 'callback-expired';
  }
}

export function shouldKeepRiskCardInteractive(resolution: RiskSelectionResolution): boolean {
  return resolution.status === 'invalid';
}
