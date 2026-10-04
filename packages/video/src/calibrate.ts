import type { CameraOrientation, LensModel, Quat, Vec3 } from '@aio/schema';
import { rayToImage } from './lens';
import { NO_ORIENTATION, orientCamera, quatConj, quatRotate } from './orientation';

/**
 * Calibration against a 3D model: a feature seen in a video frame (normalised image point,
 * top-left origin) and the same feature on the model (local frame), with the logged camera pose
 * of that frame from the flight file (no orientation bias applied).
 */
export interface LensPair {
  image: [number, number];
  world: Vec3;
  pos: Vec3;
  q: Quat;
  /**
   * Video time of the frame in milliseconds. With a pose lookup, the pose of the pair follows
   * the clip's time offset (flight time = offsetMs + videoMs), so the offset can be fitted.
   */
  videoMs?: number;
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

/** Logged camera pose at a flight time (milliseconds since the flight start). */
export type PoseLookup = (flightMs: number) => { pos: Vec3; q: Quat };

/** What a clip calibration sets: lens, orientation bias, position offset and time offset. */
export interface CalibrationState {
  lens: LensModel;
  orientation: CameraOrientation;
  offsetMs: number;
  /** Camera position correction in the local frame (metres); none means zero. */
  positionOffset?: Vec3;
}

const ZERO3: Vec3 = [0, 0, 0];

/** Where the model point of a pair lands in the image (normalised), or null if out of view. */
export function projectPair(
  p: LensPair,
  lens: LensModel,
  rotationDeg: readonly number[] = [0, 0, 0],
): [number, number] | null {
  return projectWith(p.world, p.pos, p.q, lens, {
    yawDeg: rotationDeg[0] ?? 0,
    pitchDeg: rotationDeg[1] ?? 0,
    rollDeg: rotationDeg[2] ?? 0,
  });
}

function projectWith(
  world: Vec3,
  pos: Vec3,
  qLog: Quat,
  lens: LensModel,
  orientation: CameraOrientation,
): [number, number] | null {
  const q = orientCamera(qLog, orientation);
  const rel: Vec3 = [world[0] - pos[0], world[1] - pos[1], world[2] - pos[2]];
  return rayToImage(lens, quatRotate(quatConj(q), rel));
}

/** The logged pose of a pair under a time offset (its own pose without a lookup or video time). */
function pairPose(
  p: LensPair,
  offsetMs: number,
  poseAt: PoseLookup | undefined,
): { pos: Vec3; q: Quat } {
  if (poseAt && p.videoMs !== undefined) return poseAt(offsetMs + p.videoMs);
  return { pos: p.pos, q: p.q };
}

/** Where a pair's model point lands in the image under a full calibration state. */
export function projectCalibrated(
  p: LensPair,
  state: CalibrationState,
  poseAt?: PoseLookup,
): [number, number] | null {
  const pose = pairPose(p, state.offsetMs, poseAt);
  const d = state.positionOffset ?? ZERO3;
  const pos: Vec3 = [pose.pos[0] + d[0], pose.pos[1] + d[1], pose.pos[2] + d[2]];
  return projectWith(p.world, pos, pose.q, state.lens, state.orientation);
}

/** Reprojection error of a pair in pixels (`widthPx` across the frame), or null when not in view. */
export function pairErrorPx(
  p: LensPair,
  state: CalibrationState,
  widthPx: number,
  poseAt?: PoseLookup,
): number | null {
  const im = projectCalibrated(p, state, poseAt);
  if (!im) return null;
  return Math.hypot(
    (im[0] - p.image[0]) * widthPx,
    ((im[1] - p.image[1]) * widthPx) / state.lens.aspect,
  );
}

function statsOf(residualsPx: number[]): LensFitStats {
  const n = Math.max(1, residualsPx.length);
  const rmsPx = Math.sqrt(residualsPx.reduce((m, r) => m + r * r, 0) / n);
  return { residualsPx, rmsPx, maxPx: residualsPx.length ? Math.max(...residualsPx) : 0 };
}

/** Error statistics of pairs under a calibration state; pairs out of view count `widthPx`. */
export function calibrationStats(
  pairs: readonly LensPair[],
  state: CalibrationState,
  widthPx: number,
  poseAt?: PoseLookup,
): LensFitStats {
  return statsOf(pairs.map((p) => pairErrorPx(p, state, widthPx, poseAt) ?? widthPx));
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
 * Damped least squares (Levenberg-Marquardt with forward differences): minimises the sum of
 * squared `residuals(x)` from `x0`; `steps` are the difference steps per parameter.
 */
function levenbergMarquardt(
  residuals: (x: readonly number[]) => number[],
  x0: readonly number[],
  steps: readonly number[],
): number[] {
  const n = x0.length;
  let x = [...x0];
  if (n === 0) return x;
  const cost = (r: readonly number[]) => r.reduce((m, e) => m + e * e, 0);
  let lambda = 1e-3;
  let r = residuals(x);
  let c = cost(r);
  for (let iter = 0; iter < 200; iter++) {
    const J: number[][] = r.map(() => []);
    for (let j = 0; j < n; j++) {
      const h = steps[j] ?? 1e-5;
      const xp = [...x];
      xp[j] = (xp[j] ?? 0) + h;
      const rp = residuals(xp);
      rp.forEach((v, i) => {
        J[i]?.push((v - (r[i] ?? 0)) / h);
      });
    }
    const JtJ = Array.from({ length: n }, (_, a) =>
      Array.from({ length: n }, (_, b) =>
        J.reduce((m, row) => m + (row[a] ?? 0) * (row[b] ?? 0), 0),
      ),
    );
    const Jtr = Array.from({ length: n }, (_, a) =>
      J.reduce((m, row, i) => m + (row[a] ?? 0) * (r[i] ?? 0), 0),
    );
    let improved = false;
    let done = false;
    for (let tries = 0; tries < 12 && !improved; tries++) {
      const A = JtJ.map((row, i) => row.map((v, k) => (i === k ? v * (1 + lambda) + 1e-12 : v)));
      const step = solve(A, Jtr);
      if (!step) break;
      const xn = x.map((v, i) => v - (step[i] ?? 0));
      const rn = residuals(xn);
      const cn = cost(rn);
      if (cn < c) {
        done = c - cn < 1e-18 * Math.max(1, r.length);
        x = xn;
        r = rn;
        c = cn;
        lambda = Math.max(lambda / 4, 1e-9);
        improved = true;
      } else lambda *= 8;
    }
    if (!improved || done) break;
  }
  return x;
}

/** Image-space residuals (x, y scaled to x units) of pairs; out of view pairs count large. */
function imageResiduals(
  pairs: readonly LensPair[],
  state: CalibrationState,
  poseAt: PoseLookup | undefined,
): number[] {
  return pairs.flatMap((p) => {
    const im = projectCalibrated(p, state, poseAt);
    if (!im) return [1, 1];
    return [im[0] - p.image[0], (im[1] - p.image[1]) / state.lens.aspect];
  });
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
  const stateOf = (v: readonly number[]): CalibrationState => ({
    lens: { ...start, hfovDeg: Math.min(179, Math.max(1, v[0] ?? start.hfovDeg)) },
    orientation: { yawDeg: v[1] ?? 0, pitchDeg: v[2] ?? 0, rollDeg: v[3] ?? 0 },
    offsetMs: 0,
  });
  const x0 = withRot ? [start.hfovDeg, 0, 0, 0] : [start.hfovDeg];
  const x = levenbergMarquardt(
    (v) => imageResiduals(pairs, stateOf(v), undefined),
    x0,
    x0.map(() => 1e-5),
  );
  const s = stateOf(x);
  const lens: LensModel = { ...start, hfovDeg: Math.round(s.lens.hfovDeg * 1000) / 1000 };
  const rot: [number, number, number] = [x[1] ?? 0, x[2] ?? 0, x[3] ?? 0];
  return {
    lens,
    before: calibrationStats(
      pairs,
      { lens: start, orientation: NO_ORIENTATION, offsetMs: 0 },
      widthPx,
    ),
    after: calibrationStats(pairs, { ...s, lens }, widthPx),
    rotationDeg: rot,
  };
}

export interface CalibrationFitOptions {
  /** Frame width in pixels for the error statistics. Default 1920. */
  widthPx?: number;
  /** Fit the orientation bias (yaw, pitch, roll). Default true. */
  orientation?: boolean;
  /** Fit roll as well as yaw and pitch. Default true. */
  roll?: boolean;
  /** Fit the horizontal field of view. Default false. */
  fov?: boolean;
  /** Fit the time offset; needs `poseAt` and pairs with `videoMs`. Default false. */
  time?: boolean;
  /**
   * Fit a camera position offset (east, up, south) as well: the log's altitude datum or GPS is
   * off. Needs pairs at different distances (near and far) to tell it from the orientation.
   */
  position?: boolean;
  /** Logged pose at a flight time, so pairs follow the time offset. */
  poseAt?: PoseLookup;
  /** Leave-one-out errors (each pair against a fit without it) when there are spare pairs. */
  heldOut?: boolean;
}

export interface CalibrationFit {
  state: CalibrationState;
  /** Errors of every pair before (start state) and after the fit, pixels. */
  before: LensFitStats;
  after: LensFitStats;
  /**
   * Each pair's error under a fit made without it, pixels: an honest estimate of the error on
   * features that were not picked. Null when there are no spare pairs.
   */
  heldOut: LensFitStats | null;
  /** The parameters that were fitted. */
  solved: CalibrationParam[];
}

export type CalibrationParam = 'yaw' | 'pitch' | 'roll' | 'fov' | 'time' | 'x' | 'y' | 'z';

/** Pairs needed for a fit of `unknowns` parameters (two equations per pair, at least two). */
export function pairsNeeded(unknowns: number): number {
  return Math.max(2, Math.ceil(unknowns / 2));
}

/**
 * Guided calibration (PnP with the position fixed by the flight log): fit the orientation bias,
 * and optionally the field of view and the time offset, to point pairs by damped least squares
 * on the reprojection error, starting from `start`.
 */
export function fitCalibration(
  pairs: readonly LensPair[],
  start: CalibrationState,
  opts: CalibrationFitOptions = {},
): CalibrationFit {
  const widthPx = opts.widthPx ?? 1920;
  const poseAt = opts.poseAt;
  const solved: CalibrationFit['solved'] = [];
  if (opts.orientation ?? true) {
    solved.push('yaw', 'pitch');
    if (opts.roll ?? true) solved.push('roll');
  }
  if (opts.position) solved.push('x', 'y', 'z');
  if (opts.fov) solved.push('fov');
  if (opts.time) {
    if (!poseAt || pairs.some((p) => p.videoMs === undefined))
      throw new Error('Fitting the time offset needs the flight and the video time of each pair.');
    solved.push('time');
  }
  if (!solved.length) throw new Error('Choose at least one value to fit.');
  const need = pairsNeeded(solved.length);
  if (pairs.length < need)
    throw new Error(`Pick at least ${String(need)} point pairs for this fit.`);

  const p0 = start.positionOffset ?? ZERO3;
  const stateOf = (v: readonly number[]): CalibrationState => {
    const get = (k: CalibrationParam, d: number) => {
      const i = solved.indexOf(k);
      return i < 0 ? d : (v[i] ?? d);
    };
    return {
      lens: {
        ...start.lens,
        hfovDeg: Math.min(179, Math.max(1, get('fov', start.lens.hfovDeg))),
      },
      orientation: {
        yawDeg: get('yaw', start.orientation.yawDeg),
        pitchDeg: get('pitch', start.orientation.pitchDeg),
        rollDeg: get('roll', start.orientation.rollDeg),
      },
      offsetMs: get('time', start.offsetMs),
      positionOffset: [get('x', p0[0]), get('y', p0[1]), get('z', p0[2])],
    };
  };
  const startValue: Record<CalibrationParam, number> = {
    yaw: start.orientation.yawDeg,
    pitch: start.orientation.pitchDeg,
    roll: start.orientation.rollDeg,
    fov: start.lens.hfovDeg,
    time: start.offsetMs,
    x: p0[0],
    y: p0[1],
    z: p0[2],
  };
  const x0 = solved.map((k) => startValue[k]);
  const steps = solved.map((k) =>
    k === 'time' ? 1 : k === 'x' || k === 'y' || k === 'z' ? 1e-3 : 1e-5,
  );
  const fit = (ps: readonly LensPair[], from: readonly number[]) =>
    levenbergMarquardt((v) => imageResiduals(ps, stateOf(v), poseAt), from, steps);

  const x = fit(pairs, x0);
  const raw = stateOf(x);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const state: CalibrationState = {
    lens: { ...raw.lens, hfovDeg: r3(raw.lens.hfovDeg) },
    orientation: {
      yawDeg: r3(raw.orientation.yawDeg),
      pitchDeg: r3(raw.orientation.pitchDeg),
      rollDeg: r3(raw.orientation.rollDeg),
    },
    offsetMs: Math.round(raw.offsetMs),
    ...(start.positionOffset || opts.position
      ? { positionOffset: (raw.positionOffset ?? ZERO3).map(r3) as Vec3 }
      : {}),
  };

  let heldOut: LensFitStats | null = null;
  if ((opts.heldOut ?? true) && pairs.length > need && pairs.length <= 24) {
    heldOut = statsOf(
      pairs.map((p, i) => {
        const rest = pairs.filter((_, k) => k !== i);
        const s = stateOf(fit(rest, x));
        return pairErrorPx(p, s, widthPx, poseAt) ?? widthPx;
      }),
    );
  }
  return {
    state,
    before: calibrationStats(pairs, start, widthPx, poseAt),
    after: calibrationStats(pairs, state, widthPx, poseAt),
    heldOut,
    solved,
  };
}
