import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodePng } from '../import/png';
import { sampleIssues, sampleManifest } from './fixtures';
import { encodeGrayPng, maskPlan, overlayPng, rasterizeMask, ZipWriter } from './node';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-export-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Read a store-mode ZIP's central directory. */
function readZip(buf: Buffer): { name: string; data: Buffer }[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + lName + lExtra;
    const data = buf.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

describe('ZipWriter', () => {
  it('writes a store-mode ZIP with CRCs and UTF-8 names', async () => {
    const path = join(dir, 'a.zip');
    const zip = await ZipWriter.create(path);
    await zip.add('masks.json', Buffer.from('{"a":1}'));
    await zip.add('photos/صورة.png', new Uint8Array([1, 2, 3]));
    const bytes = await zip.finish();
    const buf = await readFile(path);
    expect(bytes).toBe(buf.length);
    const files = readZip(buf);
    expect(files.map((f) => f.name)).toEqual(['masks.json', 'photos/صورة.png']);
    expect(files[0]?.data.toString()).toBe('{"a":1}');
    expect([...(files[1]?.data ?? [])]).toEqual([1, 2, 3]);
  });
});

describe('rasterizeMask', () => {
  it('fills boxes, polygons and point discs with the class value', () => {
    const mask = rasterizeMask(
      [
        { value: 1, geom: { type: 'box', x: 0, y: 0, w: 4, h: 2 } },
        {
          value: 2,
          geom: {
            type: 'polygon',
            points: [
              [10, 10],
              [20, 10],
              [20, 20],
              [10, 20],
            ],
          },
        },
        { value: 3, geom: { type: 'point', x: 40, y: 40 } },
      ],
      50,
      50,
    );
    const count = (v: number) => mask.reduce((n, x) => n + (x === v ? 1 : 0), 0);
    expect(count(1)).toBe(8);
    expect(count(2)).toBe(100);
    expect(count(3)).toBeGreaterThan(20);
    expect(mask[45 * 50 + 45]).toBe(3);
    expect(mask[30 * 50 + 30]).toBe(0);
  });
});

describe('encodeGrayPng', () => {
  it('writes an 8-bit greyscale PNG', () => {
    const png = encodeGrayPng(new Uint8Array([0, 1, 2, 3]), 2, 2);
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png[25]).toBe(0); // colour type grey
  });
});

describe('maskPlan', () => {
  it('copies kit masks and draws masks for photos without one', () => {
    const plan = maskPlan({ manifest: sampleManifest(), issues: sampleIssues() });
    expect(plan.classes.map((c) => `${String(c.value)}:${c.id}`)).toEqual([
      '1:glazing',
      '2:sealant',
    ]);
    const p1 = plan.photos.find((p) => p.photo === 'p1');
    const p2 = plan.photos.find((p) => p.photo === 'p2');
    expect(p1).toMatchObject({ kind: 'drawn', src: 'photos/p1.jpg', issues: ['D001', 'D002'] });
    expect(p1?.kind === 'drawn' && p1.shapes.map((s) => s.value)).toEqual([2, 1]);
    expect(p2).toMatchObject({ kind: 'kit', mask: 'photos/masks/p2_mask.png', issues: ['D002'] });
  });

  it('colours an overlay from the mask with the class colours', () => {
    const png = overlayPng(new Uint8Array([0, 1, 2, 0]), 2, 2, ['#ff0000', '#00ff00']);
    const img = decodePng(png);
    expect(img.channels).toBe(4);
    expect([...img.data.subarray(0, 8)]).toEqual([0, 0, 0, 0, 255, 0, 0, 140]);
    expect([...img.data.subarray(8, 12)]).toEqual([0, 255, 0, 140]);
  });
});
