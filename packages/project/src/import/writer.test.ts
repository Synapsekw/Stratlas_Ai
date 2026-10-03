import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
