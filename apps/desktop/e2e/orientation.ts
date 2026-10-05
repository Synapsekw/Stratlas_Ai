/**
 * Which way up a photo is, measured against the scene: render the project's kit-packed point
 * clouds from the photo's pose (camera looks down -Z, +Y up in the image, f-theta lens) as a
 * depth image, and compare the photo's edge directions with the render's, as it is and turned
 * half way round. The right way up scores higher.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

/** All points of the `clouds/*.bin` files (kit-packed: N int16 xyz mm, then N uint8). */
export function loadKitClouds(projectDir: string): Float32Array {
  const parts: Float32Array[] = [];
  for (const f of readdirSync(join(projectDir, 'clouds')).filter((n) => n.endsWith('.bin'))) {
    const b = readFileSync(join(projectDir, 'clouds', f));
    const n = Math.floor(b.length / 7);
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) out[i] = b.readInt16LE(i * 2) / 1000;
    parts.push(out);
  }
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return all;
}

/** Rotate `v` by the conjugate of `q` (world to camera for a camera-to-world `q`). */
function toCamera(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // v' = q* v q
  const ix = w * vx - y * vz + z * vy;
  const iy = w * vy - z * vx + x * vz;
  const iz = w * vz - x * vy + y * vx;
  const iw = x * vx + y * vy + z * vz;
  return [
    ix * w + iw * x + iy * z - iz * y,
    iy * w + iw * y + iz * x - ix * z,
    iz * w + iw * z + ix * y - iy * x,
  ];
}

/** Depth (metres, NaN where nothing) of the points seen from a pose through an f-theta lens. */
export function renderDepth(
  points: Float32Array,
  pos: Vec3,
  q: Quat,
  width = 120,
  height = 90,
  hfovDeg = 114,
): Gray {
  const depth = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
  const f = width / 2 / ((hfovDeg / 2) * (Math.PI / 180));
  for (let i = 0; i < points.length; i += 3) {
    const [x, y, zc] = toCamera(q, [
      (points[i] ?? 0) - pos[0],
      (points[i + 1] ?? 0) - pos[1],
      (points[i + 2] ?? 0) - pos[2],
    ]);
    const z = -zc;
    const r3 = Math.hypot(x, y, z);
    if (r3 < 0.15) continue;
    const theta = Math.acos(Math.max(-1, Math.min(1, z / r3)));
    if (theta > (80 * Math.PI) / 180) continue;
    const rr = Math.hypot(x, y) || 1e-9;
    const u = Math.floor(width / 2 + (f * theta * x) / rr);
    const v = Math.floor(height / 2 - (f * theta * y) / rr);
    if (u < 0 || u >= width || v < 0 || v >= height) continue;
    const k = v * width + u;
    if (r3 < (depth[k] ?? Infinity)) depth[k] = r3;
  }
  for (let k = 0; k < depth.length; k++) if (!Number.isFinite(depth[k] ?? NaN)) depth[k] = NaN;
  return { data: depth, width, height };
}

/** Grey pixels of an encoded image, resized to `width` x `height`, optionally turned 180 deg. */
export async function grayOf(
  img: Buffer,
  width: number,
  height: number,
  turn180 = false,
): Promise<Gray> {
  let s = sharp(img);
  if (turn180) s = s.rotate(180);
  const { data, info } = await s
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels] ?? 0;
  return { data: out, width, height };
}

function blur(g: Gray, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const ks = k.reduce((a, b) => a + b, 0);
  const tmp = new Float32Array(g.data.length);
  const out = new Float32Array(g.data.length);
  const { width: w, height: h } = g;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        s += (g.data[y * w + xx] ?? 0) * (k[i + r] ?? 0);
      }
      tmp[y * w + x] = s / ks;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        s += (tmp[yy * w + x] ?? 0) * (k[i + r] ?? 0);
      }
      out[y * w + x] = s / ks;
    }
  return out;
}

function gradients(g: Gray): { gx: Float32Array; gy: Float32Array } {
  const b = blur(g, 1.5);
  const { width: w, height: h } = g;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      gx[y * w + x] = (b[y * w + x + 1] ?? 0) - (b[y * w + x - 1] ?? 0);
      gy[y * w + x] = (b[(y + 1) * w + x] ?? 0) - (b[(y - 1) * w + x] ?? 0);
    }
  return { gx, gy };
}

/**
 * Agreement of edge directions (doubled angles, so dark-to-bright and bright-to-dark count the
 * same) between a photo and a depth render, weighted by edge strength: 1 all edges parallel.
 */
export function edgeScore(photo: Gray, depth: Gray): number {
  let max = 0;
  for (const v of depth.data) if (Number.isFinite(v) && v > max) max = v;
  const logDepth: Gray = {
    ...depth,
    data: Float32Array.from(depth.data, (v) => Math.log((Number.isFinite(v) ? v : max) + 0.1)),
  };
  const a = gradients(photo);
  const b = gradients(logDepth);
  let re = 0;
  let norm = 0;
  for (let i = 0; i < photo.data.length; i++) {
    const ax = a.gx[i] ?? 0;
    const ay = a.gy[i] ?? 0;
    const bx = b.gx[i] ?? 0;
    const by = b.gy[i] ?? 0;
    // (ax + i ay)^2 * conj((bx + i by)^2)
    const ar = ax * ax - ay * ay;
    const ai = 2 * ax * ay;
    const br = bx * bx - by * by;
    const bi = 2 * bx * by;
    re += ar * br + ai * bi;
    norm += Math.hypot(ar, ai) * Math.hypot(br, bi);
  }
  return norm > 0 ? re / norm : 0;
}

/** Edge scores of an image against the render from its pose, as shown and turned 180 deg. */
export async function orientationScores(
  img: Buffer,
  depth: Gray,
): Promise<{ asShown: number; turned: number }> {
  return {
    asShown: edgeScore(await grayOf(img, depth.width, depth.height), depth),
    turned: edgeScore(await grayOf(img, depth.width, depth.height, true), depth),
  };
}

/** Normalised cross-correlation of two equal-size grey images. */
export function ncc(a: Gray, b: Gray): number {
  const n = Math.min(a.data.length, b.data.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a.data[i] ?? 0;
    mb += b.data[i] ?? 0;
  }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const x = (a.data[i] ?? 0) - ma;
    const y = (b.data[i] ?? 0) - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}
