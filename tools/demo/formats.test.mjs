import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crc32, deflateZlib, encodePng, readLasHeader, writeLas } from './formats.mjs';
import { encodeH264Pcm, muxMp4, rgbToYuv420 } from './h264.mjs';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'demo-formats-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const hasFfmpeg =
  spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).status === 0;

describe('formats', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('deflates to a zlib stream that inflates back, byte for byte', () => {
    const parts = [
      Buffer.alloc(0),
      Buffer.from('a'),
      Buffer.from('abcabcabcabcabcabcabcabc hello hello hello'),
      Buffer.alloc(70000, 7),
    ];
    const rnd = Buffer.alloc(50000);
    let s = 1;
    for (let i = 0; i < rnd.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      rnd[i] = s >>> 24;
    }
    parts.push(rnd);
    for (const p of parts) expect(inflateSync(deflateZlib(p)).equals(p)).toBe(true);
    // repetitive data compresses
    expect(deflateZlib(Buffer.alloc(70000, 7)).length).toBeLessThan(2000);
  });

  it('writes PNGs that a standard decoder reads back exactly (8 and 16 bit)', async () => {
    const w = 37;
    const h = 11;
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 31) & 0xff;
    const png = encodePng({ width: w, height: h, channels: 3, depth: 8, data: rgb });
    const back = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(back.info.width).toBe(w);
    expect(back.data.equals(rgb)).toBe(true);

    const g16 = new Uint16Array(w * h);
    for (let i = 0; i < g16.length; i++) g16[i] = (i * 977) & 0xffff;
    const png16 = encodePng({ width: w, height: h, channels: 1, depth: 16, data: g16 });
    const b16 = await sharp(png16)
      .toColourspace('grey16')
      .raw({ depth: 'ushort' })
      .toBuffer({ resolveWithObject: true });
    expect(b16.info.channels).toBe(1);
    const got = new Uint16Array(b16.data.buffer, b16.data.byteOffset, w * h);
    expect(Array.from(got)).toEqual(Array.from(g16));
  });

  it('writes LAS 1.2 point format 2 with the project CRS and no machine details', () => {
    const n = 5;
    const xyz = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      xyz[3 * i] = 300000 + i * 1.5;
      xyz[3 * i + 1] = 2600000 - i;
      xyz[3 * i + 2] = 400 + i * 0.25;
    }
    const rgb = new Uint8Array(n * 3).fill(200);
    const cls = new Uint8Array(n).fill(2);
    const las = writeLas({ xyz, rgb, classification: cls, epsg: 32631, date: '2026-03-02' });
    const head = readLasHeader(las);
    expect(head.signature).toBe('LASF');
    expect(head.version).toBe('1.2');
    expect(head.format).toBe(2);
    expect(head.points).toBe(n);
    expect(head.recordLength).toBe(26);
    expect(head.epsg).toBe(32631);
    expect(head.day).toBe(61);
    expect(head.year).toBe(2026);
    expect(head.min[0]).toBeCloseTo(300000, 3);
    expect(head.max[2]).toBeCloseTo(401, 3);
    expect(head.points3[4]).toEqual([300006, 2599996, 401]);
    expect(las.toString('latin1')).not.toMatch(/Users|Temp|\\\\/);
  });
});

describe('h264 (I_PCM) in MP4', () => {
  /** Frames of a moving gradient, so every frame differs. */
  const frames = (w, h, n) =>
    Array.from({ length: n }, (_, f) => {
      const rgb = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 3;
          rgb[o] = (x * 4 + f * 20) & 0xff;
          rgb[o + 1] = (y * 5) & 0xff;
          rgb[o + 2] = ((x + y) * 3) & 0xff;
        }
      return rgb;
    });

  it('is the same bytes for the same frames', () => {
    const a = muxMp4(encodeH264Pcm(frames(48, 40, 3), 48, 40), { fps: 2 });
    const b = muxMp4(encodeH264Pcm(frames(48, 40, 3), 48, 40), { fps: 2 });
    expect(a.equals(b)).toBe(true);
    expect(a.toString('latin1', 4, 8)).toBe('ftyp');
    expect(a.toString('latin1')).not.toMatch(/Lavf|x264|Users/);
  });

  it.skipIf(!hasFfmpeg)('decodes losslessly (YUV 4:2:0) with ffmpeg, cropped to size', async () => {
    const w = 48;
    const h = 40; // coded 48 x 48, cropped
    const fr = frames(w, h, 4);
    const file = join(dir, 'clip.mp4');
    await writeFile(file, muxMp4(encodeH264Pcm(fr, w, h), { fps: 4 }));
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=width,height,nb_frames,codec_name',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    );
    const s = JSON.parse(probe.stdout).streams[0];
    expect(s).toMatchObject({ codec_name: 'h264', width: w, height: h });
    expect(Number(s.nb_frames)).toBe(4);
    const dec = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
      { maxBuffer: 1 << 26 },
    );
    expect(dec.status).toBe(0);
    const want = Buffer.concat(fr.map((f) => rgbToYuv420(f, w, h)));
    expect(dec.stdout.length).toBe(want.length);
    expect(dec.stdout.equals(want)).toBe(true);
  });
});
