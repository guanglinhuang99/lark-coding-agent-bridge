import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { canonicalWorkspace } from '../bridge/identity';
import { resolveWorkingDirectory } from '../policy/workspace';

export interface WeComWorkspace {
  id: string;
  name: string;
  cwd: string;
}

/** Local operator-owned registry. Chat commands select IDs, never arbitrary paths. */
export async function loadWorkspaceConfig(defaultCwd: string, file?: string): Promise<WeComWorkspace[]> {
  const entries: WeComWorkspace[] = [{ id: 'default', name: '默认工作区', cwd: canonicalWorkspace(defaultCwd) }];
  if (!file?.trim()) return entries;
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('Workspace config must be an array of { id, name, cwd }');
  const ids = new Set(['default']);
  const directories = new Set(entries.map(entry => entry.cwd));
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' ||
        typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id) ||
        typeof entry.name !== 'string' || !entry.name.trim() ||
        typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd)) {
      throw new Error('Invalid workspace entry: require id, name and absolute cwd');
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate or reserved workspace ID: ${entry.id}`);
    const resolved = await resolveWorkingDirectory(entry.cwd);
    if (!resolved.ok) throw new Error(`Workspace ${entry.id}: ${resolved.userVisible}`);
    if (directories.has(resolved.cwdRealpath)) throw new Error(`Workspace ${entry.id}: directory already registered`);
    ids.add(entry.id);
    directories.add(resolved.cwdRealpath);
    entries.push({ id: entry.id, name: entry.name.trim(), cwd: resolved.cwdRealpath });
  }
  return entries;
}
