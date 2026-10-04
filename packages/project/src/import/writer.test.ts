import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PackageWriter } from './writer';
import { imageSize } from './image';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aio-writer-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PackageWriter is idempotent', () => {
  it('skips unchanged copies and recopies a changed source', async () => {
    const src = join(dir, 'a.bin');
    writeFileSync(src, 'hello');
    const w = new PackageWriter(join(dir, 'out'));
    expect(await w.copy(src, 'video/a.bin')).toBe('written');
    expect(await w.copy(src, 'video/a.bin')).toBe('skipped');
    writeFileSync(src, 'hello world');
    utimesSync(src, new Date(), new Date(Date.now() + 5000));
    expect(await w.copy(src, 'video/a.bin')).toBe('written');
    expect(readFileSync(join(dir, 'out/video/a.bin'), 'utf8')).toBe('hello world');
  });

  it('skips writing identical generated content', () => {
    const w = new PackageWriter(join(dir, 'out'));
    expect(w.writeJson('manifest.json', { a: 1 })).toBe('written');
    expect(w.writeJson('manifest.json', { a: 1 })).toBe('skipped');
    expect(w.writeJson('manifest.json', { a: 2 })).toBe('written');
    expect(w.stats.written).toBe(2);
    expect(w.stats.skipped).toBe(1);
  });

  it('keeps an existing file as skipped so prune leaves it, and reports a missing one', () => {
    const w = new PackageWriter(join(dir, 'out'));
    w.write('rasters/a.webp', 'x');
    const again = new PackageWriter(join(dir, 'out'));
    expect(again.keep('rasters/a.webp')).toBe(true);
    expect(again.keep('rasters/b.webp')).toBe(false);
    expect(again.stats.skipped).toBe(1);
    expect(again.prune('rasters')).toEqual([]);
    expect(existsSync(join(dir, 'out/rasters/a.webp'))).toBe(true);
  });

  it('runs a derive step only when the output is missing or older than its sources', async () => {
    const src = join(dir, 's.txt');
    writeFileSync(src, 'x');
    const w = new PackageWriter(join(dir, 'out'));
    let runs = 0;
    const make = (out: string) => {
      runs++;
      writeFileSync(out, 'derived');
      return Promise.resolve();
    };
    expect(await w.derive('posters/p.jpg', [src], make)).toBe('written');
    expect(await w.derive('posters/p.jpg', [src], make)).toBe('skipped');
    expect(runs).toBe(1);
  });
});

describe('PackageWriter.link', () => {
  it('hard-links a source file (same inode) and skips it on a re-run', async () => {
    const src = join(dir, 'p.jpg');
    writeFileSync(src, 'photo');
    const w = new PackageWriter(join(dir, 'out'));
    expect(await w.link(src, 'legacy/photos/p.jpg')).toBe('written');
    expect(statSync(join(dir, 'out/legacy/photos/p.jpg')).ino).toBe(statSync(src).ino);
    expect(await w.link(src, 'legacy/photos/p.jpg')).toBe('skipped');
    expect(w.files.has('legacy/photos/p.jpg')).toBe(true);
  });

  it('replaces a stale file at the destination', async () => {
    const src = join(dir, 'p.jpg');
    writeFileSync(src, 'photo v2');
    const w = new PackageWriter(join(dir, 'out'));
    w.write('legacy/p.jpg', 'old');
    expect(await w.link(src, 'legacy/p.jpg')).toBe('written');
    expect(readFileSync(join(dir, 'out/legacy/p.jpg'), 'utf8')).toBe('photo v2');
  });
});

describe('imageSize', () => {
  it('reads JPEG dimensions from the SOF marker', () => {
    // SOI, APP0 (len 16), SOF0 (len 17) with height 960 and width 1280
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)];
    const sof0 = [
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x03,
      0xc0,
      0x05,
      0x00,
      0x03,
      ...new Array<number>(9).fill(0),
    ];
    const buf = Uint8Array.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
    expect(imageSize(buf)).toEqual({ width: 1280, height: 960 });
  });

  it('reads PNG dimensions from IHDR', () => {
    const buf = new Uint8Array(33);
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const v = new DataView(buf.buffer);
    v.setUint32(16, 4096);
    v.setUint32(20, 2048);
    expect(imageSize(buf)).toEqual({ width: 4096, height: 2048 });
  });
});

describe('PackageWriter.prune', () => {
  it('removes files under a folder that the run did not write, and empty folders', () => {
    const w = new PackageWriter(join(dir, 'out'));
    w.write('rasters/plotplan/0/0_0.png', 'new');
    w.write('rasters/keep.json', '{}');
    const old = new PackageWriter(join(dir, 'out'));
    old.write('rasters/plotplan/0/0_0.webp', 'old');
    old.write('rasters/area-plans-west.png', 'old');
    old.write('rasters/old/1/x.webp', 'old');
    old.write('video/a.mp4', 'outside');
    expect(w.prune('rasters').sort()).toEqual([
      'rasters/area-plans-west.png',
      'rasters/old/1/x.webp',
      'rasters/plotplan/0/0_0.webp',
    ]);
    expect(readFileSync(join(dir, 'out/rasters/plotplan/0/0_0.png'), 'utf8')).toBe('new');
    expect(readFileSync(join(dir, 'out/video/a.mp4'), 'utf8')).toBe('outside');
    expect(existsSync(join(dir, 'out/rasters/old'))).toBe(false);
  });
});
