export interface LaunchdStatus {
  loaded: boolean;
  running: boolean;
  state?: string;
  pid?: string;
  lastExit?: string;
  runs?: number;
}

/** Only inspect the outer job, not nested resource-coalition states or env values. */
export function parseLaunchdStatus(text: string): Omit<LaunchdStatus, 'loaded' | 'running'> {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  let depth = 0;
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (value === '}') { depth -= 1; continue; }
    if (value.endsWith('= {')) { depth += 1; continue; }
    if (depth !== 1) continue;
    const match = /^(state|pid|runs|last exit code)\s*=\s*(.*?)\s*$/.exec(value);
    if (match?.[1] && match[2]) fields[match[1]] = match[2];
  }
  return {
    state: fields.state,
    pid: /^[1-9]\d*$/.test(fields.pid ?? '') ? fields.pid : undefined,
    lastExit: /^-?\d+$/.test(fields['last exit code'] ?? '') ? fields['last exit code'] : undefined,
    runs: /^\d+$/.test(fields.runs ?? '') ? Number(fields.runs) : undefined,
  };
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function inspectLaunchdStatus(
  loaded: boolean,
  text: string,
  alive: (pid: number) => boolean = processIsAlive,
): LaunchdStatus {
  if (!loaded) return { loaded: false, running: false };
  const parsed = parseLaunchdStatus(text);
  return {
    ...parsed,
    loaded: true,
    running: parsed.state === 'running' && !!parsed.pid && alive(Number(parsed.pid)),
  };
}
