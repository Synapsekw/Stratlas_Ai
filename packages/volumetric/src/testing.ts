// Test helpers: encode grids the way the Volumetric Survey Kit's package.py does. Not imported by
// production code.
// eslint-disable-next-line no-restricted-imports -- test helper, never bundled into the renderer
import { deflateSync } from 'node:zlib';

/** Int16 grid as row-wise deltas, zlib, base64. */
export function encodeDeltaI16(values: ArrayLike<number>, w: number, h: number): string {
  const d = new Int16Array(w * h);
  for (let y = 0; y < h; y++) {
    let prev = 0;
    for (let x = 0; x < w; x++) {
      const v = values[y * w + x] ?? 0;
      d[y * w + x] = v - prev;
      prev = v;
    }
  }
  return deflateSync(Buffer.from(d.buffer)).toString('base64');
}

/** 0/1 mask packed most significant bit first, zlib, base64. */
export function encodeBits(bits: ArrayLike<number>): string {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++)
    if (bits[i]) out[i >> 3] = (out[i >> 3] ?? 0) | (1 << (7 - (i & 7)));
  return deflateSync(Buffer.from(out)).toString('base64');
}

export interface SyntheticPile {
  /** Script text as `data/piles/<id>.js`. */
  text: string;
  w: number;
  h: number;
  /** Surface heights in cm above zoff, per epoch. */
  z: Record<string, number[]>;
  mask: number[];
}

/**
 * A 20 x 10 cell pile at 0.1 m: flat floor at 1.00 m above zoff, a 2 m high block in the middle
 * 10 x 4 cells on e2 (0.4 m² at 2 m = 0.8 m³ above a base at the floor), nothing on e1.
 */
export function syntheticPile(): SyntheticPile {
  const w = 20;
  const h = 10;
  const floor = new Array<number>(w * h).fill(100);
  const block = floor.map((v, i) => {
    const x = i % w;
    const y = Math.floor(i / w);
    return x >= 5 && x < 15 && y >= 3 && y < 7 ? 300 : v;
  });
  const mask = floor.map((_, i) => {
    const x = i % w;
    const y = Math.floor(i / w);
    return x >= 4 && x < 16 && y >= 2 && y < 8 ? 1 : 0;
  });
  const json = {
    id: 'P01',
    res: 0.1,
    w,
    h,
    x0: 1000,
    y1: 2000,
    zoff: 50,
    zone: encodeBits(mask),
    ep: {
      e1: { z: encodeDeltaI16(floor, w, h) },
      e2: {
        z: encodeDeltaI16(block, w, h),
        m: encodeBits(mask),
        tin: encodeDeltaI16(floor, w, h),
        low: 51,
        avg: 51.5,
        plane: [51, 0, 0],
      },
    },
    tex: { e2: 'data:image/jpeg;base64,AAAA' },
  };
  const text = `window.VS_PILE=window.VS_PILE||{};window.VS_PILE["P01"]=${JSON.stringify(json)};`;
  return { text, w, h, z: { e1: floor, e2: block }, mask };
}
