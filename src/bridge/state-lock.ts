import { mkdir, realpath } from 'node:fs/promises';
import lockfile from 'proper-lockfile';

/** A deployment lock, not a machine-wide workspace/agent concurrency lock. */
export async function acquireStateDirectoryLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  const release = await lockfile.lock(canonical, { realpath: true, retries: 0 });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await release();
  };
}
