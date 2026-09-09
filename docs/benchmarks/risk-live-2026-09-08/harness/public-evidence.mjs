import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_EVIDENCE_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SENSITIVE_EVIDENCE_KEYS = new Set([
  'netassets',
  'newnetassets',
  'holdingscount',
  'net_assets',
  'new_net_assets',
  'holdings_count',
]);

export function isPublicEvidencePath(filePath) {
  const relativePath = relative(PUBLIC_EVIDENCE_ROOT, resolve(filePath));
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

export function sanitizePublicEvidence(value) {
  if (Array.isArray(value)) return value.map(sanitizePublicEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    SENSITIVE_EVIDENCE_KEYS.has(key.toLowerCase()) ? null : sanitizePublicEvidence(nested),
  ]));
}

export function evidenceForPath(filePath, value) {
  return isPublicEvidencePath(filePath) ? sanitizePublicEvidence(value) : value;
}

export function stringifyEvidenceForPath(filePath, value, space) {
  return JSON.stringify(evidenceForPath(filePath, value), null, space);
}
