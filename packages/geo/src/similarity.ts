import type { Mat4, Quat, Vec3 } from '@aio/schema';

/**
 * Georeferencing by point pairs: a similarity transform `dst = s * R * src + t` from points picked
 * on a model (`src`, model coordinates) to targets in the project local frame (`dst`, x east,
 * y up, z south). Targets picked on a 2D map have no height (`horizontalOnly`).
 */
export interface PointPair {
  src: Vec3;
  dst: Vec3;
  /** The target has no trustworthy height (map click): fit it in plan only. */
  horizontalOnly?: boolean;
}

/**
 * `upright`: turn about the vertical axis, uniform scale and shift (models that are already level,
 * the usual case for photogrammetry and CAD). `full`: any rotation, 3 or more pairs with heights.
 */
export type SimilarityMode = 'upright' | 'full';

export interface SimilarityFit {
  /** Column-major 4x4 (three.js `Matrix4.elements` order), ready for a mesh layer `transform`. */
  matrix: Mat4;
  scale: number;
  rotation: Quat;
  translation: Vec3;
  /** Turn about +Y in degrees (counter-clockwise seen from above), for display. */
  yawDeg: number;
  /** Distance from each transformed source to its target, metres (plan only for map targets). */
  residuals: number[];
  rms: number;
  max: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function centroid(ps: readonly Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of ps) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  return [c[0] / ps.length, c[1] / ps.length, c[2] / ps.length];
}

function quatToMat3([x, y, z, w]: Quat): number[][] {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** Column-major Mat4 for `s * R * p + t`. */
function compose(s: number, q: Quat, t: Vec3): Mat4 {
  const r = quatToMat3(q);
  const e = (i: number, j: number) => s * (r[i]?.[j] ?? 0);
  return [
    e(0, 0),
    e(1, 0),
    e(2, 0),
    0,
    e(0, 1),
    e(1, 1),
    e(2, 1),
    0,
    e(0, 2),
    e(1, 2),
    e(2, 2),
    0,
    ...t,
    1,
  ];
}

/** Apply a column-major 4x4 to a point. */
export function applyMat4(m: readonly number[], p: Vec3): Vec3 {
  const e = (i: number) => m[i] ?? 0;
  const w = e(3) * p[0] + e(7) * p[1] + e(11) * p[2] + e(15);
  return [
    (e(0) * p[0] + e(4) * p[1] + e(8) * p[2] + e(12)) / w,
    (e(1) * p[0] + e(5) * p[1] + e(9) * p[2] + e(13)) / w,
    (e(2) * p[0] + e(6) * p[1] + e(10) * p[2] + e(14)) / w,
  ];
}

/** Largest-eigenvalue eigenvector of a symmetric 4x4 matrix (cyclic Jacobi). */
function topEigenvector(a: number[][]): number[] {
  const n = 4;
  const m = a.map((r) => [...r]);
  const v = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)));
  const at = (i: number, j: number) => m[i]?.[j] ?? 0;
  const set = (mat: number[][], i: number, j: number, x: number) => {
    const row = mat[i];
    if (row) row[j] = x;
  };
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += at(i, j) ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = at(p, q);
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (at(q, q) - at(p, p)) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = at(k, p);
          const akq = at(k, q);
          set(m, k, p, c * akp - s * akq);
          set(m, k, q, s * akp + c * akq);
        }
        for (let k = 0; k < n; k++) {
          const apk = at(p, k);
          const aqk = at(q, k);
          set(m, p, k, c * apk - s * aqk);
          set(m, q, k, s * apk + c * aqk);
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]?.[p] ?? 0;
          const vkq = v[k]?.[q] ?? 0;
          set(v, k, p, c * vkp - s * vkq);
          set(v, k, q, s * vkp + c * vkq);
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (at(i, i) > at(best, best)) best = i;
  return [0, 1, 2, 3].map((k) => v[k]?.[best] ?? 0);
}

function fitFull(pairs: readonly PointPair[]): { s: number; q: Quat; t: Vec3 } {
  if (pairs.some((p) => p.horizontalOnly))
    throw new Error('Full 3D fitting needs a height for every target. Use the level fit instead.');
  const cs = centroid(pairs.map((p) => p.src));
  const cd = centroid(pairs.map((p) => p.dst));
  const a = pairs.map((p) => sub(p.src, cs));
  const b = pairs.map((p) => sub(p.dst, cd));
  const spread = Math.max(...a.map(len));
  let area = 0;
  for (const u of a) for (const w of a) area = Math.max(area, len(cross(u, w)));
  if (spread < 1e-9 || area < 1e-9 * spread * spread)
    throw new Error('The model points lie on one line. Pick a third point off that line.');
  const S = [0, 1, 2].map(() => [0, 0, 0]);
  a.forEach((u, k) => {
    const w = b[k] ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const row = S[i];
      if (row) for (let j = 0; j < 3; j++) row[j] = (row[j] ?? 0) + (u[i] ?? 0) * (w[j] ?? 0);
    }
  });
  const s = (i: number, j: number) => S[i]?.[j] ?? 0;
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = [
    s(0, 0),
    s(0, 1),
    s(0, 2),
    s(1, 0),
    s(1, 1),
    s(1, 2),
    s(2, 0),
    s(2, 1),
    s(2, 2),
  ];
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const [w = 1, x = 0, y = 0, z = 0] = topEigenvector(N);
  const n = Math.hypot(w, x, y, z);
  const q: Quat = [x / n, y / n, z / n, w / n];
  const r = quatToMat3(q);
  let num = 0;
  let den = 0;
  a.forEach((u, k) => {
    const w2 = b[k] ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const ru = (r[i]?.[0] ?? 0) * u[0] + (r[i]?.[1] ?? 0) * u[1] + (r[i]?.[2] ?? 0) * u[2];
      num += ru * (w2[i] ?? 0);
    }
    den += u[0] ** 2 + u[1] ** 2 + u[2] ** 2;
  });
  const scale = num / den;
  const rc = [0, 1, 2].map(
    (i) => (r[i]?.[0] ?? 0) * cs[0] + (r[i]?.[1] ?? 0) * cs[1] + (r[i]?.[2] ?? 0) * cs[2],
  );
  const t: Vec3 = [
    cd[0] - scale * (rc[0] ?? 0),
    cd[1] - scale * (rc[1] ?? 0),
    cd[2] - scale * (rc[2] ?? 0),
  ];
  return { s: scale, q, t };
}

function fitUpright(
  pairs: readonly PointPair[],
  heightOffset: number,
): { s: number; q: Quat; t: Vec3; yaw: number } {
  // Plan coordinates (x east, n = -z north): a turn about +Y by `a` is counter-clockwise there.
  const src = pairs.map((p) => [p.src[0], -p.src[2]] as const);
  const dst = pairs.map((p) => [p.dst[0], -p.dst[2]] as const);
  const n = pairs.length;
  const mean = (v: readonly (readonly [number, number])[]) =>
    v.reduce((m, p) => [m[0] + p[0] / n, m[1] + p[1] / n], [0, 0]);
  const [sx, sy] = mean(src);
  const [dx, dy] = mean(dst);
  let a = 0;
  let b = 0;
  let ss = 0;
  src.forEach((p, k) => {
    const d = dst[k] ?? [0, 0];
    const x = p[0] - sx;
    const y = p[1] - sy;
    const u = d[0] - dx;
    const v = d[1] - dy;
    a += x * u + y * v;
    b += x * v - y * u;
    ss += x * x + y * y;
  });
  if (ss < 1e-12)
    throw new Error('The model points are too close together. Pick points further apart.');
  const yaw = Math.atan2(b, a);
  const s = Math.hypot(a, b) / ss;
  const c = Math.cos(yaw) * s;
  const si = Math.sin(yaw) * s;
  const tx = dx - (c * sx - si * sy);
  const tn = dy - (si * sx + c * sy);
  const withH = pairs.filter((p) => !p.horizontalOnly);
  const ty = withH.length
    ? withH.reduce((m, p) => m + (p.dst[1] - s * p.src[1]), 0) / withH.length
    : heightOffset;
  const q: Quat = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  return { s, q, t: [tx, ty, -tn], yaw };
}

/**
 * Least-squares similarity from model points to targets, with the residual of every pair.
 * `heightOffset` is the vertical shift kept when no target has a height (upright mode).
 */
export function fitSimilarity3D(
  pairs: readonly PointPair[],
  mode: SimilarityMode,
  opts: { heightOffset?: number } = {},
): SimilarityFit {
  const need = mode === 'full' ? 3 : 2;
  if (pairs.length < need)
    throw new Error(`Need at least ${String(need)} point pairs, got ${String(pairs.length)}.`);
  let s: number;
  let q: Quat;
  let t: Vec3;
  let yawDeg: number;
  if (mode === 'full') {
    ({ s, q, t } = fitFull(pairs));
    const r = quatToMat3(q);
    // heading of the model's -Z axis after the turn, as a turn about +Y
    yawDeg = (Math.atan2(r[0]?.[2] ?? 0, r[2]?.[2] ?? 1) * 180) / Math.PI;
  } else {
    const u = fitUpright(pairs, opts.heightOffset ?? 0);
    ({ s, q, t } = u);
    yawDeg = (u.yaw * 180) / Math.PI;
  }
  const matrix = compose(s, q, t);
  const residuals = pairs.map((p) => {
    const m = applyMat4(matrix, p.src);
    const d = sub(m, p.dst);
    return p.horizontalOnly ? Math.hypot(d[0], d[2]) : len(d);
  });
  const rms = Math.sqrt(residuals.reduce((m, r) => m + r * r, 0) / residuals.length);
  return {
    matrix,
    scale: s,
    rotation: q,
    translation: t,
    yawDeg,
    residuals,
    rms,
    max: Math.max(...residuals),
  };
}
