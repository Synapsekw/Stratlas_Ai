import type { LensModel, Quat, Vec3 } from '@aio/schema';
import { rayToImage } from './lens';

/**
 * Lens calibration against a 3D model: a feature seen in a video frame (normalised image point,
 * top-left origin) and the same feature on the model (local frame), with the camera pose of that
 * frame from the flight file.
 */
export interface LensPair {
  image: [number, number];
  world: Vec3;
  pos: Vec3;
  q: Quat;
}

export interface LensFitStats {
  /** Reprojection error of each pair, pixels across `widthPx`. */
  residualsPx: number[];
  rmsPx: number;
  maxPx: number;
}

export interface LensFit {
  /** The fitted lens: same model and aspect, new field of view. */
  lens: LensModel;
  before: LensFitStats;
  after: LensFitStats;
  /**
   * Camera turn (yaw, pitch, roll in degrees, camera frame) that best explains the pairs besides
   * the lens. It absorbs pose errors of the flight log and is not saved with the lens.
   */
  rotationDeg: [number, number, number];
}

function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const p = quatMul(quatMul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [p[0], p[1], p[2]];
}

/** Small camera-frame turn: yaw about +Y, pitch about +X, roll about +Z (degrees). */
function turn([yaw, pitch, roll]: readonly number[]): Quat {
  const h = (d: number | undefined) => ((d ?? 0) * Math.PI) / 360;
  const y: Quat = [0, Math.sin(h(yaw)), 0, Math.cos(h(yaw))];
  const x: Quat = [Math.sin(h(pitch)), 0, 0, Math.cos(h(pitch))];
  const z: Quat = [0, 0, Math.sin(h(roll)), Math.cos(h(roll))];
  return quatMul(quatMul(y, x), z);
}

/** Where the model point of a pair lands in the image (normalised), or null if out of view. */
export function projectPair(
  p: LensPair,
  lens: LensModel,
  rotationDeg: readonly number[] = [0, 0, 0],
): [number, number] | null {
  const q = quatMul(p.q, turn(rotationDeg));
  const rel: Vec3 = [p.world[0] - p.pos[0], p.world[1] - p.pos[1], p.world[2] - p.pos[2]];
  const d = rotate([-q[0], -q[1], -q[2], q[3]], rel);
  return rayToImage(lens, d);
}

function stats(
  pairs: readonly LensPair[],
  lens: LensModel,
  rot: readonly number[],
  widthPx: number,
): LensFitStats {
  const residualsPx = pairs.map((p) => {
    const im = projectPair(p, lens, rot);
    if (!im) return widthPx;
    return Math.hypot(
      (im[0] - p.image[0]) * widthPx,
      ((im[1] - p.image[1]) * widthPx) / lens.aspect,
    );
  });
  const rmsPx = Math.sqrt(residualsPx.reduce((m, r) => m + r * r, 0) / residualsPx.length);
  return { residualsPx, rmsPx, maxPx: Math.max(...residualsPx) };
}

/** Solve the small normal equations J^T J x = J^T r (Gaussian elimination with pivoting). */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[p]?.[c] ?? 0)) p = r;
    const pr = m[p];
    const cr = m[c];
    if (!pr || !cr || Math.abs(pr[c] ?? 0) < 1e-15) return null;
    m[p] = cr;
    m[c] = pr;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = m[r];
      if (!row) continue;
      const f = (row[c] ?? 0) / (pr[c] ?? 1);
      for (let k = c; k <= n; k++) row[k] = (row[k] ?? 0) - f * (pr[k] ?? 0);
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

/**
 * Fit the lens field of view (and, unless `solveRotation` is false, a small camera turn that
 * soaks up pose errors) to point pairs by damped least squares on the reprojection error.
 */
export function fitLens(
  pairs: readonly LensPair[],
  start: LensModel,
  opts: { widthPx?: number; solveRotation?: boolean } = {},
): LensFit {
  if (pairs.length < 2) throw new Error('Pick at least two point pairs to fit the lens.');
  const widthPx = opts.widthPx ?? 1920;
  const withRot = opts.solveRotation ?? true;
  const lensOf = (h: number): LensModel => ({ ...start, hfovDeg: h });
  // parameters: hfov (deg), then yaw, pitch, roll (deg)
  let x = [start.hfovDeg, 0, 0, 0];
  const nParam = withRot ? 4 : 1;
  const residuals = (v: readonly number[]): number[] => {
    const lens = lensOf(Math.min(179, Math.max(1, v[0] ?? start.hfovDeg)));
    const rot = [v[1] ?? 0, v[2] ?? 0, v[3] ?? 0];
    return pairs.flatMap((p) => {
      const im = projectPair(p, lens, rot);
      if (!im) return [1, 1];
      return [im[0] - p.image[0], (im[1] - p.image[1]) / lens.aspect];
    });
  };
  const cost = (r: readonly number[]) => r.reduce((m, e) => m + e * e, 0);
  let lambda = 1e-3;
  let r = residuals(x);
  let c = cost(r);
  for (let iter = 0; iter < 200; iter++) {
    const J: number[][] = r.map(() => []);
    for (let j = 0; j < nParam; j++) {
      const h = 1e-5;
      const xp = [...x];
      xp[j] = (xp[j] ?? 0) + h;
      const rp = residuals(xp);
      rp.forEach((v, i) => {
        J[i]?.push((v - (r[i] ?? 0)) / h);
      });
    }
    const JtJ = Array.from({ length: nParam }, (_, a) =>
      Array.from({ length: nParam }, (_, b) =>
        J.reduce((m, row) => m + (row[a] ?? 0) * (row[b] ?? 0), 0),
      ),
    );
    const Jtr = Array.from({ length: nParam }, (_, a) =>
      J.reduce((m, row, i) => m + (row[a] ?? 0) * (r[i] ?? 0), 0),
    );
    let improved = false;
    for (let tries = 0; tries < 10 && !improved; tries++) {
      const A = JtJ.map((row, i) => row.map((v, k) => (i === k ? v * (1 + lambda) + 1e-12 : v)));
      const step = solve(A, Jtr);
      if (!step) break;
      const xn = [...x];
      step.forEach((s, i) => {
        xn[i] = (xn[i] ?? 0) - s;
      });
      const rn = residuals(xn);
      const cn = cost(rn);
      if (cn < c) {
        const done = c - cn < 1e-18;
        x = xn;
        r = rn;
        c = cn;
        lambda = Math.max(lambda / 4, 1e-9);
        improved = true;
        if (done) iter = 1e9;
      } else lambda *= 8;
    }
    if (!improved) break;
  }
  const hfov = Math.min(179, Math.max(1, x[0] ?? start.hfovDeg));
  const rot: [number, number, number] = [x[1] ?? 0, x[2] ?? 0, x[3] ?? 0];
  const lens = lensOf(Math.round(hfov * 1000) / 1000);
  return {
    lens,
    before: stats(pairs, start, [0, 0, 0], widthPx),
    after: stats(pairs, lens, rot, widthPx),
    rotationDeg: rot,
  };
}
