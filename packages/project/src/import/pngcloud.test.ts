import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@aio/schema';
import { composeFrame, mapPoint, rotateY } from './frames';
import { decodePng, encodePng } from './png';
import { convertPngChunk, decodePngCloud, encodePngCloud } from './pngcloud';

describe('png codec', () => {
  it('round-trips RGB pixels', () => {
    const data = Uint8Array.from({ length: 5 * 3 * 3 }, (_, i) => (i * 37) & 0xff);
    const img = decodePng(encodePng({ width: 5, height: 3, channels: 3, data }));
    expect(img.width).toBe(5);
    expect(img.height).toBe(3);
    expect(Array.from(img.data)).toEqual(Array.from(data));
  });
});

describe('png-packed point cloud chunks', () => {
  const u = Uint16Array.from([0, 0, 0, 65535, 1, 2, 1000, 30000, 65000]);
  const rgb = Uint8Array.from([255, 0, 0, 0, 255, 0, 1, 2, 3]);

  it('encodes the plane layout the Al-Zour viewer decodes', () => {
    const png = encodePngCloud({ n: 3, u, rgb }, 4);
    const d = decodePngCloud(png, 3);
    expect(Array.from(d.u)).toEqual(Array.from(u));
    expect(Array.from(d.rgb)).toEqual(Array.from(rgb));
  });

  it('rotates a chunk into the local frame within the quantisation step', () => {
    const png = encodePngCloud({ n: 3, u, rgb });
    const info = { n: 3, o: [-500, -2, -300] as Vec3, q: 0.01 };
    const f = composeFrame(rotateY(-17.9991), [12.5, 100, -40]);
    const c = convertPngChunk(png, info, f);
    const d = decodePngCloud(c.png, 3);
    for (let i = 0; i < 3; i++) {
      const want = mapPoint(f, [
        info.o[0] + info.q * (u[i * 3] ?? 0),
        info.o[1] + info.q * (u[i * 3 + 1] ?? 0),
        info.o[2] + info.q * (u[i * 3 + 2] ?? 0),
      ]);
      for (let a = 0; a < 3; a++) {
        const viaOq = (c.o[a] ?? 0) + c.q * (d.u[i * 3 + a] ?? 0);
        const span = (c.bounds.max[a] ?? 0) - (c.bounds.min[a] ?? 0);
        const viaBounds = (c.bounds.min[a] ?? 0) + ((d.u[i * 3 + a] ?? 0) / 65535) * span;
        expect(Math.abs(viaOq - (want[a] ?? 0))).toBeLessThanOrEqual(c.q);
        expect(Math.abs(viaBounds - viaOq)).toBeLessThan(1e-3);
      }
    }
    expect(Array.from(d.rgb)).toEqual(Array.from(rgb));
  });
});
