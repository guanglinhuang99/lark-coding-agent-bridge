import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadWorkspaceConfig } from '../../../src/wecom/workspace-config';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-config-')); dirs.push(dir);
  const other = join(dir, '审核资料'); await mkdir(other);
  return { dir, other, file: join(dir, 'workspaces.json') };
}

it('keeps the existing workspace as default and loads named local directories', async () => {
  const { dir, other, file } = await setup();
  expect(await loadWorkspaceConfig(dir)).toEqual([{ id: 'default', name: '默认工作区', cwd: await realpath(dir) }]);
  await writeFile(file, JSON.stringify([{ id: 'review', name: ' 合同审核 ', cwd: other }]));
  expect((await loadWorkspaceConfig(dir, file))[1]).toEqual({ id: 'review', name: '合同审核', cwd: await realpath(other) });
});

it('rejects ambiguous IDs, arbitrary relative paths, invalid and inaccessible directories', async () => {
  const { dir, other, file } = await setup();
  for (const raw of [
    {}, Array.from({ length: 10 }, (_, index) => ({ id: `w${index}`, name: `W${index}`, cwd: `/tmp/w${index}` })),
    [{ id: 'default', name: '重复', cwd: other }],
    [{ id: 'a', name: 'A', cwd: other }, { id: 'a', name: 'B', cwd: other }],
    [{ id: 'a', name: 'A', cwd: other }, { id: 'b', name: 'B', cwd: other }],
    [{ id: 'a', name: 'A', cwd: dir }],
    [{ id: '../a', name: 'A', cwd: other }], [{ id: 'a', name: '', cwd: other }],
    [{ id: 'a', name: 'A', cwd: './relative' }], [{ id: 'a', name: 'A', cwd: '/' }],
    [{ id: 'a', name: 'A', cwd: join(dir, 'missing') }],
    [{ id: 'a', name: 'A', cwd: file }],
  ]) {
    await writeFile(file, JSON.stringify(raw));
    await expect(loadWorkspaceConfig(dir, file)).rejects.toThrow();
  }
});
