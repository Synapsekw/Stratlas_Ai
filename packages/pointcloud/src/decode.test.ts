import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeKitPacked, decodePngChunk, quantFromBounds } from './decode';

const HCL = 'E:/Dev/AIO Software/docs/design/assets/hcl/cloud.bin';

describe.skipIf(!existsSync(HCL))('decodeKitPacked on the real HCl fixture', () => {
  it('decodes 280k points inside the documented tank bbox', () => {
    const file = readFileSync(HCL);
    const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    const c = decodeKitPacked(buf);
    expect(c.count).toBe(280_000);
    expect(c.bounds.min).toEqual([-2.458, -0.172, -2.127]);
    expect(c.bounds.max).toEqual([2.382, 9.381, 2.596]);
  });
});

/** Kit layout: block A = N x int16 xyz interleaved, block B = N x uint8 intensity. */
function kitBuffer(points: [number, number, number, number][]): ArrayBuffer {
  const n = points.length;
  const buf = new ArrayBuffer(n * 7);
  const v = new DataView(buf);
  points.forEach(([x, y, z, i], k) => {
    v.setInt16(k * 6, x, true);
    v.setInt16(k * 6 + 2, y, true);
    v.setInt16(k * 6 + 4, z, true);
    v.setUint8(n * 6 + k, i);
  });
  return buf;
}

describe('decodeKitPacked', () => {
  it('reads the planar layout: all xyz first, then all intensities', () => {
    const c = decodeKitPacked(
      kitBuffer([
        [1000, -2000, 500, 200],
        [0, 0, 1, 7],
      ]),
    );
    expect(c.count).toBe(2);
    expect(Array.from(c.positions.slice(0, 3))).toEqual([1, -2, 0.5]);
    expect(c.positions[5]).toBeCloseTo(0.001, 7);
    expect(Array.from(c.intensity)).toEqual([200, 7]);
  });

  it('returns raw int16 positions and tight bounds in metres', () => {
    const c = decodeKitPacked(
      kitBuffer([
        [-500, 0, 2000, 1],
        [1500, 300, -100, 2],
      ]),
    );
    expect(Array.from(c.raw)).toEqual([-500, 0, 2000, 1500, 300, -100]);
    expect(c.bounds.min).toEqual([-0.5, 0, -0.1]);
    expect(c.bounds.max).toEqual([1.5, 0.3, 2]);
  });

  it('rejects a truncated buffer', () => {
    expect(() => decodeKitPacked(new ArrayBuffer(8))).toThrow('not a multiple of 7');
  });
});

/** Packs point records into an RGBA image the way the Al-Zour exporter does. */
function pngRgba(
  u: [number, number, number][],
  rgb: [number, number, number][],
  w: number,
): { rgba: Uint8ClampedArray; h: number } {
  const n = u.length;
  const planes: number[] = [];
  for (const axis of [0, 1, 2] as const) {
    for (const p of u) planes.push(p[axis] & 0xff);
    for (const p of u) planes.push(p[axis] >> 8);
  }
  for (const ch of [0, 1, 2] as const) for (const c of rgb) planes.push(c[ch]);
  expect(planes.length).toBe(9 * n);
  const pixels = Math.ceil(planes.length / 3);
  const h = Math.ceil(pixels / w);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[p * 4] = planes[p * 3] ?? 0;
    rgba[p * 4 + 1] = planes[p * 3 + 1] ?? 0;
    rgba[p * 4 + 2] = planes[p * 3 + 2] ?? 0;
    rgba[p * 4 + 3] = 255;
  }
  return { rgba, h };
}

describe('decodePngChunk', () => {
  const u: [number, number, number][] = [
    [0, 0, 0],
    [65535, 32768, 1],
    [258, 513, 65000],
  ];
  const rgb: [number, number, number][] = [
    [255, 0, 0],
    [0, 128, 0],
    [1, 2, 3],
  ];

  it('rebuilds uint16 xyz from byte planes spread over RGB, skipping alpha', () => {
    const { rgba, h } = pngRgba(u, rgb, 4);
    const c = decodePngChunk(rgba, 4, h, { offset: [0, 0, 0], scale: [1, 1, 1] }, 3);
    expect(c.count).toBe(3);
    expect(Array.from(c.raw)).toEqual([0, 0, 0, 65535, 32768, 1, 258, 513, 65000]);
    expect(Array.from(c.rgb)).toEqual([255, 0, 0, 0, 128, 0, 1, 2, 3]);
  });

  it('applies the chunk quantisation (offset + scale * u)', () => {
    const { rgba, h } = pngRgba(u, rgb, 3);
    const c = decodePngChunk(rgba, 3, h, { offset: [10, 20, 30], scale: [0.5, 0.5, 0.5] }, 3);
    expect(Array.from(c.positions.slice(3, 6))).toEqual([10 + 65535 * 0.5, 20 + 16384, 30.5]);
    expect(c.bounds.min).toEqual([10, 20, 30]);
  });

  it('quantises to bounds when given {min,max}', () => {
    const q = quantFromBounds({ min: [0, 0, 0], max: [65535, 131070, 0] });
    expect(q.scale).toEqual([1, 2, 0]);
    const { rgba, h } = pngRgba(u, rgb, 4);
    const c = decodePngChunk(rgba, 4, h, { min: [0, 0, 0], max: [65535, 131070, 0] }, 3);
    expect(Array.from(c.positions.slice(3, 6))).toEqual([65535, 65536, 0]);
  });

  it('infers the point count from the image size when not given', () => {
    const { rgba } = pngRgba(u, rgb, 9);
    // 3 points x 9 bytes = 27 bytes = 9 pixels exactly
    const c = decodePngChunk(rgba, 9, 1, { offset: [0, 0, 0], scale: [1, 1, 1] });
    expect(c.count).toBe(3);
  });

  it('rejects an image too small for the declared count', () => {
    const { rgba, h } = pngRgba(u, rgb, 4);
    expect(() => decodePngChunk(rgba, 4, h, { offset: [0, 0, 0], scale: [1, 1, 1] }, 100)).toThrow(
      'too small',
    );
  });
});
