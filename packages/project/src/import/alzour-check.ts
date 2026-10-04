import type { LensModel, PoseSample, Quat, Vec3 } from '@aio/schema';
import type { AioFlight } from './flight';
import { cameraForward } from './flight';
import { invertFrame, mapPoint, mapQuat, type FrameMap } from './frames';
import { PLANT_E0, PLANT_EL0, PLANT_N0, plantCameraQuat, type PlantVideo } from './plant';
import { quatConjugate, quatMultiply, quatRotate, round } from './math';

/** Plant grid position of a point in the project local frame. */
export function localToPlant(frame: FrameMap, p: Vec3): { E: number; N: number; EL: number } {
  const s = mapPoint(invertFrame(frame), p);
  return { E: s[0] + PLANT_E0, N: PLANT_N0 - s[2], EL: s[1] + PLANT_EL0 };
}

/** Where the camera's view axis meets the horizontal plane `y = groundY`, or null if it looks up. */
export function groundHit(pos: Vec3, q: Quat, groundY = 0): Vec3 | null {
  const f = cameraForward(q);
  if (f[1] > -1e-3) return null;
  const t = (groundY - pos[1]) / f[1];
  if (t <= 0) return null;
  return [pos[0] + f[0] * t, groundY, pos[2] + f[2] * t];
}

/** Angle (deg) between two unit quaternions as rotations. */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const d = quatMultiply(quatConjugate(a), b);
  // atan2 stays accurate for small angles (acos of a w near 1 does not)
  return (2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3])) * 180) / Math.PI;
}

/** A clip of a flight: its track, local wall-clock start, and the lens of its video. */
export interface FlightClip {
  name: string;
  video: PlantVideo;
  startUtcMs: number;
  lens: LensModel;
}

/**
 * One `aio.flight/1` document for all clips of a flight, so the app groups them: sample time is
 * milliseconds since the first clip starts; each clip's samples are offset by its start. Samples
 * that would not increase in time (overlapping clips) are dropped.
 */
export function mergeFlightClips(
  clips: readonly FlightClip[],
  convert: (c: FlightClip) => AioFlight,
  name: string,
): { doc: AioFlight; offsets: Map<string, number> } {
  const sorted = [...clips].sort((a, b) => a.startUtcMs - b.startUtcMs);
  const first = sorted[0];
  if (!first) throw new Error(`Flight ${name} has no clips`);
  const samples: PoseSample[] = [];
  const offsets = new Map<string, number>();
  let last = -1;
  for (const c of sorted) {
    const off = c.startUtcMs - first.startUtcMs;
    offsets.set(c.name, off);
    for (const s of convert(c).samples) {
      const t = s.t + off;
      if (t <= last) continue;
      last = t;
      samples.push({ ...s, t });
    }
  }
  return {
    doc: { schema: 'aio.flight/1', name, startUtcMs: first.startUtcMs, lens: first.lens, samples },
    offsets,
  };
}

/**
 * Horizontal field of view of a clip: the Mavic 3 Cine records 5.1K (17:9) over the full sensor
 * width at 83 deg; 16:9 modes crop the width, so their field of view is narrower.
 */
export function clipHfovDeg(aspect: number, fullHfovDeg = 83, fullAspect = 5120 / 2700): number {
  if (aspect >= fullAspect - 0.01) return fullHfovDeg;
  const t = Math.tan((fullHfovDeg * Math.PI) / 360) * (aspect / fullAspect);
  return round((Math.atan(t) * 360) / Math.PI, 2);
}

/**
 * Horizontal field of view calibrated against the plant model (stream B2, 2026-10-04): the app
 * rendered the model in drone-eye view at a sweep of lenses and compared each render with the
 * video frame (edge correlation, a small turn and shift allowed for pose error) over 6 frames of
 * DJI_0665 (5.1K 17:9) and 6 of DJI_0789 (4K60 16:9). The source's 83 deg was never measured.
 * Re-fitted by A1 (2026-10-05) with the camera heights corrected (absolute altitude on the plant
 * datum) jointly with orientation and position over 38 frames of 25 clips: one lens, 70.9 deg, for
 * both frame shapes (B2 had 72.2 and 65.6 while the heights were 20 to 44 m low).
 */
export const ALZOUR_HFOV_DEG = { wide: 70.9, uhd: 70.9 } as const;

/** Calibrated field of view by frame shape; other shapes keep the sensor-crop estimate. */
export function calibratedHfovDeg(aspect: number): number {
  if (Math.abs(aspect - 5120 / 2700) < 0.01) return ALZOUR_HFOV_DEG.wide;
  if (Math.abs(aspect - 16 / 9) < 0.01) return ALZOUR_HFOV_DEG.uhd;
  return clipHfovDeg(aspect);
}

/** Camera orientation of a track row in the local frame (as `plantVideoToFlight`). */
export function trackQuat(frame: FrameMap, az: number, gimbalPitch: number): Quat {
  return mapQuat(frame, plantCameraQuat(az, gimbalPitch));
}

/**
 * Where a world point appears in a pinhole camera image: `u`, `v` in -1..1 across the frame
 * (right, up), or null when the point is behind the camera.
 */
export function projectToImage(
  pos: Vec3,
  q: Quat,
  lens: { hfovDeg: number; aspect: number },
  p: Vec3,
): { u: number; v: number; depth: number } | null {
  const c = quatRotate(quatConjugate(q), [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]]);
  const depth = -c[2];
  if (depth <= 1e-6) return null;
  const tx = Math.tan((lens.hfovDeg * Math.PI) / 360);
  return { u: c[0] / depth / tx, v: c[1] / depth / (tx / lens.aspect), depth };
}

/** Is point (x, z) inside the parallelogram `o + a u + b v`, 0 <= a <= 1, 0 <= b <= 1? */
export function inParallelogram(
  o: readonly [number, number],
  u: readonly [number, number],
  v: readonly [number, number],
  p: readonly [number, number],
): boolean {
  const det = u[0] * v[1] - u[1] * v[0];
  const dx = p[0] - o[0];
  const dz = p[1] - o[1];
  const a = (dx * v[1] - dz * v[0]) / det;
  const b = (u[0] * dz - u[1] * dx) / det;
  return a >= 0 && a <= 1 && b >= 0 && b <= 1;
}
