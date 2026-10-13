import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TRASH_DIR,
  emptyTrash,
  freeTrashEntry,
  stampOf,
  stampTime,
  sweepTrash,
  trashSize,
} from './trash';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-trash-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NOW = new Date('2026-10-13T08:15:30.000Z');
const entry = async (name: string, bytes: number) => {
  const dir = join(root, TRASH_DIR, name, 'rasters', 'x');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'tiles.json'), Buffer.alloc(bytes, 1));
};

describe('trash', () => {
  it('stamps in UTC without separators and reads the stamp back', () => {
    expect(stampOf(NOW)).toBe('20261013T081530Z');
    expect(stampTime('20261013T081530Z-run-1')).toBe(NOW.getTime());
    expect(stampTime('notes.txt')).toBeNull();
  });

  it('finds a free entry name', async () => {
    const first = await freeTrashEntry(root, NOW, 'run-20261012-0930');
    expect(first.endsWith(join(TRASH_DIR, '20261013T081530Z-run-20261012-0930'))).toBe(true);
    await mkdir(first, { recursive: true });
    expect(await freeTrashEntry(root, NOW, 'run-20261012-0930')).toBe(`${first}-2`);
  });

  it('sizes what the trash holds', async () => {
    await entry('20261013T081530Z-a', 1000);
    await entry('20261012T081530Z-b', 24);
    expect(await trashSize(root)).toEqual({ bytes: 1024, entries: 2 });
  });

  it('answers 0 and 0 without a trash folder', async () => {
    expect(await trashSize(root)).toEqual({ bytes: 0, entries: 0 });
    expect(await emptyTrash(root)).toEqual({ freed: 0, removed: [], held: [] });
  });

  it('empties every entry and reports what it freed', async () => {
    await entry('20261013T081530Z-a', 1000);
    await entry('20261012T081530Z-b', 24);
    const r = await emptyTrash(root);
    expect(r.freed).toBe(1024);
    expect(r.removed.sort()).toEqual(['20261012T081530Z-b', '20261013T081530Z-a']);
    expect(await readdir(join(root, TRASH_DIR))).toEqual([]);
  });

  it('leaves an entry that is held open and reports it', async () => {
    await entry('20261013T081530Z-a', 1000);
    await entry('20261012T081530Z-held', 24);
    const held = (p: string) =>
      p.endsWith('held')
        ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        : rm(p, { recursive: true, force: true });
    const r = await emptyTrash(root, { rm: held });
    expect(r).toEqual({
      freed: 1000,
      removed: ['20261013T081530Z-a'],
      held: ['20261012T081530Z-held'],
    });
    expect(await readdir(join(root, TRASH_DIR))).toEqual(['20261012T081530Z-held']);
  });

  it('sweeps with a keep time of zero like emptying, stamped entries only', async () => {
    await entry('20261013T081530Z-a', 10);
    expect(await sweepTrash(root, () => NOW, 0)).toEqual([]);
    expect(await sweepTrash(root, () => new Date(NOW.getTime() + 1000), 0)).toEqual([
      '20261013T081530Z-a',
    ]);
  });
});
