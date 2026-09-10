export function readUseAllowedList(value: string | undefined): boolean {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '' || normalized === '1') return true;
  if (normalized === '0') return false;
  throw new Error(`Invalid USE_ALLOWED_LIST: ${value}. Expected 0 or 1.`);
}

export function isRiskUserAllowedByConfig(
  useAllowedList: boolean,
  allowedUserIds: ReadonlySet<string>,
  userid: string | undefined,
): boolean {
  if (!useAllowedList) return true;
  return Boolean(userid) && allowedUserIds.has(userid ?? '');
}
