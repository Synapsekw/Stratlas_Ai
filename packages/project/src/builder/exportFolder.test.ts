import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeExportFolder } from './exportFolder';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-export-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const FILES = {
  'stack.glb': new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3]),
  'stack.procmodel.json': '{"a":1}\n',
  'stack.components.json': '[]\n',
};

describe('writeExportFolder', () => {
  it('writes every file into the folder, and nothing else is left beside it', async () => {
    const target = join(dir, 'stack');
    await writeExportFolder(target, FILES);
    expect((await readdir(target)).sort()).toEqual(Object.keys(FILES).sort());
    expect(await readFile(join(target, 'stack.procmodel.json'), 'utf8')).toBe('{"a":1}\n');
    expect([...(await readFile(join(target, 'stack.glb')))]).toEqual([...FILES['stack.glb']]);
    expect(await readdir(dir)).toEqual(['stack']);
  });

  it('leaves nothing behind when a write fails half way', async () => {
    const target = join(dir, 'stack');
    let n = 0;
    await expect(
      writeExportFolder(target, FILES, {
        writeFile: async (p, data) => {
          if (++n === 2) throw new Error('disk full');
          await writeFile(p, data);
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses an existing folder unless asked to replace it, and keeps it when replacing fails', async () => {
    const target = join(dir, 'stack');
    await mkdir(target);
    await writeFile(join(target, 'old.txt'), 'old');
    await expect(writeExportFolder(target, FILES)).rejects.toThrow(/already exists/);
    await expect(
      writeExportFolder(target, FILES, {
        replace: true,
        writeFile: () => Promise.reject(new Error('disk full')),
      }),
    ).rejects.toThrow(/disk full/);
    expect(await readdir(target)).toEqual(['old.txt']);
    expect(await readdir(dir)).toEqual(['stack']);
    await writeExportFolder(target, FILES, { replace: true });
    expect((await readdir(target)).sort()).toEqual(Object.keys(FILES).sort());
    expect(await readdir(dir)).toEqual(['stack']);
  });

  it('tries the rename again while Windows holds a file open', async () => {
    const target = join(dir, 'stack');
    let refusals = 0;
    await writeExportFolder(target, FILES, {
      rename: {
        platform: 'win32',
        sleep: () => Promise.resolve(),
        rename: async (from, to) => {
          if (refusals++ < 2)
            throw Object.assign(new Error('EPERM: operation not permitted, rename'), {
              code: 'EPERM',
            });
          await fsRename(from, to);
        },
      },
    });
    expect(refusals).toBe(3);
    expect((await readdir(target)).sort()).toEqual(Object.keys(FILES).sort());
    expect(await readdir(dir)).toEqual(['stack']);
  });

  it('sweeps an old staging or replaced folder an earlier export left, but not a fresh one', async () => {
    const target = join(dir, 'stack');
    for (const left of ['.stack.partial-aaaa', '.stack.old-bbbb', '.other.partial-cccc'])
      await mkdir(join(dir, left));
    // an hour later: the stack leftovers are stale, another name's are not ours to sweep
    await writeExportFolder(target, FILES, { now: () => Date.now() + 60 * 60 * 1000 });
    expect((await readdir(dir)).sort()).toEqual(['.other.partial-cccc', 'stack']);
    await mkdir(join(dir, '.stack.partial-dddd'));
    await writeExportFolder(target, FILES, { replace: true });
    // a fresh one may still be another export at work
    expect(await readdir(dir)).toContain('.stack.partial-dddd');
  });

  it('refuses file names that are not plain names', async () => {
    for (const bad of ['../x.json', 'a/b.json', 'a\\b.json', '..', ''])
      await expect(writeExportFolder(join(dir, 'x'), { [bad]: 'x' })).rejects.toThrow(/file name/);
    expect(await readdir(dir)).toEqual([]);
  });
});
