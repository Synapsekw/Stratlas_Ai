import type { Vec3 } from '@aio/schema';
import { mapPoint, type FrameMap } from './frames';
import { decodePng, encodePng } from './png';

/**
 * PNG-packed point cloud chunk, as in the Al-Zour plant twin (`pcDecode`): the image's R, G, B
 * bytes, pixel by pixel, form one byte stream of 9 planes of n bytes each:
 * x lo, x hi, y lo, y hi, z lo, z hi, r, g, b. Position = o + q * uint16 (per axis).
 */
export interface PngCloud {
  n: number;
  /** Interleaved uint16 x, y, z. */
  u: Uint16Array;
  /** Interleaved r, g, b. */
  rgb: Uint8Array;
}

export function decodePngCloud(png: Uint8Array, n: number): PngCloud {
  const img = decodePng(png);
  const need = n * 9;
  const b = new Uint8Array(need);
  const ch = img.channels;
  for (let i = 0, j = 0; j < need && i < img.data.length; i += ch) {
    b[j++] = img.data[i] ?? 0;
    if (j < need) b[j++] = img.data[i + 1] ?? 0;
    if (j < need) b[j++] = img.data[i + 2] ?? 0;
  }
  const u = new Uint16Array(n * 3);
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    u[i * 3] = (b[i] ?? 0) | ((b[n + i] ?? 0) << 8);
    u[i * 3 + 1] = (b[2 * n + i] ?? 0) | ((b[3 * n + i] ?? 0) << 8);
    u[i * 3 + 2] = (b[4 * n + i] ?? 0) | ((b[5 * n + i] ?? 0) << 8);
    rgb[i * 3] = b[6 * n + i] ?? 0;
    rgb[i * 3 + 1] = b[7 * n + i] ?? 0;
    rgb[i * 3 + 2] = b[8 * n + i] ?? 0;
  }
  return { n, u, rgb };
}

export function encodePngCloud(c: PngCloud, width = 1024): Uint8Array {
  const n = c.n;
  const stream = new Uint8Array(n * 9);
  for (let i = 0; i < n; i++) {
    const x = c.u[i * 3] ?? 0;
    const y = c.u[i * 3 + 1] ?? 0;
    const z = c.u[i * 3 + 2] ?? 0;
    stream[i] = x & 0xff;
    stream[n + i] = x >> 8;
    stream[2 * n + i] = y & 0xff;
    stream[3 * n + i] = y >> 8;
    stream[4 * n + i] = z & 0xff;
    stream[5 * n + i] = z >> 8;
    stream[6 * n + i] = c.rgb[i * 3] ?? 0;
    stream[7 * n + i] = c.rgb[i * 3 + 1] ?? 0;
    stream[8 * n + i] = c.rgb[i * 3 + 2] ?? 0;
  }
  const pixels = Math.ceil(stream.length / 3);
  const w = Math.max(1, Math.min(width, pixels));
  const h = Math.max(1, Math.ceil(pixels / w));
  const data = new Uint8Array(w * h * 3);
  data.set(stream);
  return encodePng({ width: w, height: h, channels: 3, data });
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface ConvertedChunk {
  png: Uint8Array;
  points: number;
  /** Quantisation cube: xyz = bounds.min + u / 65535 * (bounds.max - bounds.min). */
  bounds: Bounds;
  /** Same rule as the source viewer: xyz = o + q * u. */
  o: Vec3;
  q: number;
  /** Tight axis-aligned bounds of the points. */
  aabb: Bounds;
}

/**
 * Re-express a PNG-packed chunk (decoded with origin `o` and uniform step `q`) in another frame
 * and quantise it again to a cube that encloses the rotated points.
 */
export function convertPngChunk(
  png: Uint8Array,
  info: { n: number; o: Vec3; q: number },
  frame: FrameMap,
): ConvertedChunk {
  const src = decodePngCloud(png, info.n);
  const pts = new Float64Array(info.n * 3);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < info.n; i++) {
    const p = mapPoint(frame, [
      info.o[0] + info.q * (src.u[i * 3] ?? 0),
      info.o[1] + info.q * (src.u[i * 3 + 1] ?? 0),
      info.o[2] + info.q * (src.u[i * 3 + 2] ?? 0),
    ]);
    for (let a = 0; a < 3; a++) {
      const val = p[a] ?? 0;
      pts[i * 3 + a] = val;
      lo[a] = Math.min(lo[a] ?? val, val);
      hi[a] = Math.max(hi[a] ?? val, val);
    }
  }
  if (info.n === 0) {
    lo.fill(0);
    hi.fill(0);
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-3);
  // Round the step up to 0.1 mm so the cube is exact in decimal JSON.
  const q = Math.ceil((extent / 65535) * 1e4) / 1e4;
  const o: Vec3 = [round4(lo[0]), round4(lo[1]), round4(lo[2])];
  const u = new Uint16Array(info.n * 3);
  for (let i = 0; i < info.n * 3; i++) {
    const v = Math.round(((pts[i] ?? 0) - (o[i % 3] ?? 0)) / q);
    u[i] = Math.max(0, Math.min(65535, v));
  }
  const max: Vec3 = [round4(o[0] + q * 65535), round4(o[1] + q * 65535), round4(o[2] + q * 65535)];
  return {
    png: encodePngCloud({ n: info.n, u, rgb: src.rgb }),
    points: info.n,
    bounds: { min: o, max },
    o,
    q,
    aabb: { min: lo.map(round4) as Vec3, max: hi.map(round4) as Vec3 },
  };
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
