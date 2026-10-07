import { mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANGED_ON_DISK_PHRASE,
  ChangedOnDiskError,
  SeenFiles,
  isChangedOnDisk,
  readJson,
  readJsonSeen,
  writeJsonAtomic,
  writeJsonSeen,
} from './fsutil';

describe('writeJsonAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-fsutil-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces a file another process is reading at that moment', async () => {
    // Windows refuses the rename while a handle is open (EPERM); the write waits it out.
    const file = join(dir, 'settings.json');
    await writeFile(file, '{"v":1}');
    const reader = await open(file, 'r');
    const write = writeJsonAtomic(file, { v: 2 });
    setTimeout(() => void reader.close(), 50);
    await write;
    expect(await readJson(file)).toEqual({ v: 2 });
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  it('keeps writes of one file in the same millisecond apart', async () => {
    const file = join(dir, 'issues.json');
    await Promise.all([1, 2, 3].map((v) => writeJsonAtomic(file, { v })));
    expect(await readJson(file)).toMatchObject({ v: expect.any(Number) as number });
    expect(await readdir(dir)).toEqual(['issues.json']);
  });

  it('keeps the previous version as a whole .bak and leaves no temp file', async () => {
    const file = join(dir, 'issues.json');
    await writeJsonAtomic(file, { v: 1 }, { backup: true });
    expect(await readdir(dir)).toEqual(['issues.json']);
    await writeJsonAtomic(file, { v: 2 }, { backup: true });
    await writeJsonAtomic(file, { v: 3 }, { backup: true });
    expect(await readJson(file)).toEqual({ v: 3 });
    expect(await readJson(`${file}.bak`)).toEqual({ v: 2 });
    expect((await readdir(dir)).sort()).toEqual(['issues.json', 'issues.json.bak']);
  });
});

describe('compare-before-write', () => {
  let dir: string;
  let file: string;
  let seen: SeenFiles;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-cmp-'));
    file = join(dir, 'issues.json');
    seen = new SeenFiles();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a write when the file changed since it was read, and leaves it byte-identical', async () => {
    await writeJsonAtomic(file, { v: 1 }, { backup: true });
    await writeJsonAtomic(file, { v: 1.5 }, { backup: true });
    expect(await readJsonSeen(file, seen)).toEqual({ v: 1.5 });
    // someone else saves (another app on the shared folder)
    await writeFile(file, '{\n  "v": 2,\n  "by": "other"\n}\n');
    const before = await readFile(file);
    const bakBefore = await readFile(`${file}.bak`);
    const r = writeJsonSeen(file, { v: 3 }, { backup: true }, seen);
    await expect(r).rejects.toBeInstanceOf(ChangedOnDiskError);
    await expect(r).rejects.toThrow(`issues.json ${CHANGED_ON_DISK_PHRASE}`);
    expect((await r.catch((e: unknown) => e)) as Error).toMatchObject({ code: 'changed-on-disk' });
    expect(isChangedOnDisk(await r.catch((e: unknown) => e))).toBe(true);
    expect(await readFile(file)).toEqual(before);
    expect(await readFile(`${file}.bak`)).toEqual(bakBefore);
    expect((await readdir(dir)).sort()).toEqual(['issues.json', 'issues.json.bak']);
  });

  it('refuses a same-size change with the same time (coarse clocks) by the hash', async () => {
    await writeFile(file, '{"v":1}');
    expect(await readJsonSeen(file, seen)).toEqual({ v: 1 });
    const { mtime } = await stat(file);
    await writeFile(file, '{"v":2}');
    await utimes(file, mtime, mtime);
    await expect(writeJsonSeen(file, { v: 3 }, {}, seen)).rejects.toBeInstanceOf(
      ChangedOnDiskError,
    );
    expect(await readFile(file, 'utf8')).toBe('{"v":2}');
  });

  it('writes when the file is unchanged since it was read, even if only touched', async () => {
    await writeFile(file, '{"v":1}');
    await readJsonSeen(file, seen);
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    await writeJsonSeen(file, { v: 2 }, {}, seen);
    expect(await readJson(file)).toEqual({ v: 2 });
  });

  it('writes the first time, with no expectation', async () => {
    await writeJsonSeen(file, { v: 1 }, { backup: true }, seen);
    expect(await readJson(file)).toEqual({ v: 1 });
    // a file never read here is written without a check
    await writeFile(file, '{"v":"other"}');
    const other = new SeenFiles();
    await writeJsonSeen(file, { v: 2 }, {}, other);
    expect(await readJson(file)).toEqual({ v: 2 });
  });

  it('refuses when a file read as missing was created by someone else', async () => {
    expect(await readJsonSeen(file, seen)).toBeUndefined();
    await writeFile(file, '{"v":"other"}');
    await expect(writeJsonSeen(file, { v: 1 }, {}, seen)).rejects.toBeInstanceOf(
      ChangedOnDiskError,
    );
    expect(await readJson(file)).toEqual({ v: 'other' });
  });

  it('lets its own consecutive writes through and refuses after an outside one', async () => {
    await writeFile(file, '{"v":0}');
    await readJsonSeen(file, seen);
    for (let v = 1; v <= 5; v++) await writeJsonSeen(file, { v }, { backup: true }, seen);
    expect(await readJson(file)).toEqual({ v: 5 });
    expect(await readJson(`${file}.bak`)).toEqual({ v: 4 });
    // the outside write is the same size as the last own one ('{"v":"other"}' and '{\n  "v": 5\n}\n')
    const own = seen.expect(file);
    await writeFile(file, '{"v":"other"}');
    expect((await stat(file)).size).toBe(own?.size);
    await expect(writeJsonSeen(file, { v: 6 }, {}, seen)).rejects.toThrow(
      'Reload to see their changes; your edit was not saved.',
    );
  });

  it('refuses an outside write in the same clock tick as its own, at the same size', async () => {
    // Windows stamps files from a clock that moves in ticks of 1 to 16 ms: an outside save right
    // after this app's own write can carry the very same time, to the fraction of a millisecond.
    // Pin both writes to one (non-whole-second) time so that case runs on every machine.
    const tick = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000 + 437);
    await writeFile(file, '{"v":0}');
    await readJsonSeen(file, seen);
    await writeJsonSeen(file, { v: 5 }, {}, seen);
    await utimes(file, tick, tick);
    await readJsonSeen(file, seen); // the own write, as stamped at that tick
    const own = seen.expect(file);
    expect(own?.mtimeMs).not.toBe(Math.round((own?.mtimeMs ?? 0) / 1000) * 1000);
    await writeFile(file, '{"v":"other"}');
    await utimes(file, tick, tick);
    const now = await stat(file);
    expect({ mtimeMs: now.mtimeMs, size: now.size }).toEqual({
      mtimeMs: own?.mtimeMs,
      size: own?.size,
    });
    await expect(writeJsonSeen(file, { v: 6 }, {}, seen)).rejects.toBeInstanceOf(
      ChangedOnDiskError,
    );
    expect(await readFile(file, 'utf8')).toBe('{"v":"other"}');
  });

  it('compares a large file by its bytes while its time is recent', async () => {
    const big = (c: string) => `${JSON.stringify({ v: c.repeat(5 * 1024 * 1024) }, null, 2)}\n`;
    await writeFile(file, big('a'));
    await readJsonSeen(file, seen);
    // a touch only: the same bytes at a new, recent time are no change
    const recent = new Date(Date.now() - 300);
    await utimes(file, recent, recent);
    await writeJsonSeen(file, { v: 'b'.repeat(5 * 1024 * 1024) }, {}, seen);
    // an outside save of the same size in the same (recent) tick as that write
    const tick = new Date(Math.floor(Date.now() / 1000) * 1000 + 437);
    await utimes(file, tick, tick);
    await readJsonSeen(file, seen);
    const own = seen.expect(file);
    await writeFile(file, big('c'));
    await utimes(file, tick, tick);
    expect((await stat(file)).mtimeMs).toBe(own?.mtimeMs);
    await expect(writeJsonSeen(file, { v: 'd' }, {}, seen)).rejects.toBeInstanceOf(
      ChangedOnDiskError,
    );
  });

  it('takes an explicit expectation of time and size', async () => {
    await writeFile(file, '{"v":1}');
    const s = await stat(file);
    const expectV = { mtimeMs: s.mtimeMs, size: s.size };
    await writeJsonAtomic(file, { v: 2 }, { expect: expectV });
    await expect(writeJsonAtomic(file, { v: 3 }, { expect: expectV })).rejects.toBeInstanceOf(
      ChangedOnDiskError,
    );
    await expect(writeJsonAtomic(file, { v: 3 }, { expect: null })).rejects.toBeInstanceOf(
      ChangedOnDiskError,
    );
    expect(await readJson(file)).toEqual({ v: 2 });
  });
});
