import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandImportPaths } from './folders';

const known = (e: string) => ['.mp4', '.srt', '.jpg'].includes(e);

describe('expandImportPaths', () => {
  let root: string;
  let a: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'folders-'));
    a = join(root, 'a');
    await mkdir(join(a, '.hidden'), { recursive: true });
    await mkdir(join(a, 'sub'), { recursive: true });
    for (const f of [
      'CLIP_0001.MP4',
      'CLIP_0001.SRT',
      'CLIP_0001.LRF',
      '.hidden/x.jpg',
      'Thumbs.db',
      'sub/IMG_2.JPG',
    ]) {
      await writeFile(join(a, f), 'x');
    }
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('expands a folder, skips hidden entries and summarises the left-out files', async () => {
    const r = await expandImportPaths([a], known);
    expect(r.files).toEqual(
      [join(a, 'CLIP_0001.MP4'), join(a, 'CLIP_0001.SRT'), join(a, 'sub', 'IMG_2.JPG')].sort(),
    );
    expect(r.leftOut).toEqual([{ folder: a, count: 2, exts: ['.db', '.lrf'] }]);
    expect(r.tooMany).toBeNull();
  });

  it('keeps a given file with an unknown extension', async () => {
    const f = join(a, 'Thumbs.db');
    const r = await expandImportPaths([f], known);
    expect(r.files).toEqual([f]);
    expect(r.leftOut).toEqual([]);
  });

  it('keeps a path that does not exist as given', async () => {
    const f = join(root, 'missing.jpg');
    const r = await expandImportPaths([f], known);
    expect(r.files).toEqual([f]);
  });

  it('stops when a folder goes over the limit', async () => {
    const r = await expandImportPaths([a], known, 2);
    expect(r.tooMany).toBe(a);
    expect(r.files).toEqual([]);
  });

  it('counts files with unknown extensions toward the limit', async () => {
    const r = await expandImportPaths([a], known, 4);
    expect(r.tooMany).toBe(a);
    expect(r.files).toEqual([]);
  });

  it('keeps a file given twice once, given files first', async () => {
    const f = join(a, 'sub', 'IMG_2.JPG');
    const r = await expandImportPaths([f, a], known);
    expect(r.files[0]).toBe(f);
    expect(r.files.filter((p) => p === f)).toHaveLength(1);
    expect(r.files).toHaveLength(3);
  });
});
