import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HELD_PREFIX,
  TRASH_DIR,
  emptyTrash,
  freeTrashEntry,
  pathBytes,
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
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
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

  it('leaves a held- entry alone: it holds files a removal could not put back', async () => {
    await entry(`${HELD_PREFIX}20261001T081530Z-run-1`, 24);
    await entry('20261013T081530Z-a', 1000);
    expect(stampTime(`${HELD_PREFIX}20261001T081530Z-run-1`)).toBeNull();
    expect(await sweepTrash(root, () => new Date('2026-11-30T00:00:00.000Z'))).toEqual([
      '20261013T081530Z-a',
    ]);
    await entry('20261013T081530Z-b', 1000);
    expect(await trashSize(root)).toEqual({ bytes: 1000, entries: 1 });
    expect(await emptyTrash(root)).toEqual({
      freed: 1000,
      removed: ['20261013T081530Z-b'],
      held: [],
    });
    expect(await readdir(join(root, TRASH_DIR))).toEqual([`${HELD_PREFIX}20261001T081530Z-run-1`]);
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

  it('counts a directory it cannot read as 0 bytes', async () => {
    await entry('20261013T081530Z-a', 10);
    const refuse = () => Promise.reject(Object.assign(new Error('denied'), { code: 'EPERM' }));
    expect(await pathBytes(join(root, TRASH_DIR, '20261013T081530Z-a'), refuse)).toBe(0);
  });

  it('refuses a slug that could leave the trash folder', async () => {
    for (const slug of ['a/b', 'a\\b', '..', 'x..y', '../x']) {
      await expect(freeTrashEntry(root, NOW, slug)).rejects.toThrow();
    }
  });

  it('never follows a trash folder that is a link', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'aio-outside-'));
    try {
      await mkdir(join(outside, '20200101T000000Z-old'), { recursive: true });
      await writeFile(join(outside, '20200101T000000Z-old', 'f.txt'), 'keep');
      await symlink(outside, join(root, TRASH_DIR), 'junction');
      expect(await trashSize(root)).toEqual({ bytes: 0, entries: 0 });
      expect(await emptyTrash(root)).toEqual({ freed: 0, removed: [], held: [] });
      expect(await sweepTrash(root, () => NOW, 0)).toEqual([]);
      expect(await readFile(join(outside, '20200101T000000Z-old', 'f.txt'), 'utf8')).toBe('keep');
    } finally {
      await rm(join(root, TRASH_DIR), { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('never follows a junction inside an entry: Empty and the sweep leave the outside folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'aio-outside-'));
    try {
      await writeFile(join(outside, 'f.txt'), 'keep');
      for (const name of ['20261013T081530Z-a', '20261001T081530Z-b']) {
        await entry(name, 10);
        await symlink(outside, join(root, TRASH_DIR, name, 'rasters', 'link'), 'junction');
      }
      expect(await sweepTrash(root, () => NOW)).toEqual(['20261001T081530Z-b']);
      expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe('keep');
      expect((await emptyTrash(root)).removed).toEqual(['20261013T081530Z-a']);
      expect(await readdir(join(root, TRASH_DIR))).toEqual([]);
      expect(await readdir(outside)).toEqual(['f.txt']);
      expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe('keep');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
