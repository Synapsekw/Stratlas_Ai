import type { OrientationFile, PhotoCorrection, PhotoRef, Quat, Vec3 } from '@aio/schema';
import { cameraQuatFromGimbal } from './camera';
import { directionFromQuat, type CameraDirection } from './direction';

/*
 * A photo's camera with its hand correction ("Align photo to map"): the imported pose (GPS and
 * EXIF/XMP gimbal angles) turned by degrees of heading, pitch and roll in the grid frame and moved
 * by metres. Every reader draws photos through `correctedPhoto`; the stored pose never changes.
 */

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const clampPitch = (d: number) => Math.max(-90, Math.min(90, d));

/** True when a correction changes nothing. */
export function isNoCorrection(c: PhotoCorrection | null | undefined): boolean {
  return (
    !c ||
    (Math.abs(c.yawDeg) < 1e-9 &&
      Math.abs(c.pitchDeg) < 1e-9 &&
      Math.abs(c.rollDeg) < 1e-9 &&
      !(c.offsetM ?? [0, 0, 0]).some((v) => Math.abs(v) > 1e-9))
  );
}

/** The imported orientation turned by a correction (grid-frame heading, pitch, roll). */
export function correctQuat(q: Quat, c: PhotoCorrection | null | undefined): Quat {
  if (!c || (c.yawDeg === 0 && c.pitchDeg === 0 && c.rollDeg === 0)) return q;
  const d = directionFromQuat(q);
  return cameraQuatFromGimbal(
    d.yaw + c.yawDeg,
    clampPitch(d.pitch + c.pitchDeg),
    d.roll + c.rollDeg,
  );
}

/** The imported position moved by a correction. */
export function correctPos(pos: Vec3, c: PhotoCorrection | null | undefined): Vec3 {
  const o = c?.offsetM;
  return o ? [pos[0] + o[0], pos[1] + o[1], pos[2] + o[2]] : pos;
}

/** A photo's saved correction in `orientation.json`, or undefined. */
export function photoCorrection(
  file: OrientationFile | null | undefined,
  layerId: string,
  photoId: string,
): PhotoCorrection | undefined {
  return file?.photos[layerId]?.[photoId];
}

/**
 * The photo as every view draws it: its pose with its correction (`photoCorrection`; the same
 * object without one).
 */
export function correctedPhoto<T extends PhotoRef>(p: T, c: PhotoCorrection | null | undefined): T {
  if (isNoCorrection(c)) return p;
  return {
    ...p,
    ...(p.pos ? { pos: correctPos(p.pos, c) } : {}),
    ...(p.q ? { q: correctQuat(p.q, c) } : {}),
  };
}

/**
 * The correction that turns imported orientation `q` to direction `dir` (and moves it by
 * `offsetM`): heading and roll the short way round, pitch clamped to the schema's range.
 */
export function correctionTo(q: Quat, dir: CameraDirection, offsetM?: Vec3): PhotoCorrection {
  const d = directionFromQuat(q);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    yawDeg: r(wrap180(dir.yaw - d.yaw)),
    pitchDeg: r(Math.max(-90, Math.min(90, dir.pitch - d.pitch))),
    rollDeg: r(wrap180(dir.roll - d.roll)),
    ...(offsetM?.some((v) => Math.abs(v) >= 5e-4) ? { offsetM } : {}),
  };
}

/**
 * Photos taken on the same flight as `photo`: the same set, taken without a gap longer than
 * `gapMs` between consecutive photos (by `takenAt`). Without times, the whole set.
 */
export function sameFlightPhotos<T extends PhotoRef>(
  items: readonly T[],
  photo: T,
  gapMs = 20 * 60_000,
): T[] {
  const t = (p: T | undefined) => (p?.takenAt ? Date.parse(p.takenAt) : NaN);
  if (Number.isNaN(t(photo))) return items.filter((p) => Number.isNaN(t(p)));
  const timed = items.filter((p) => !Number.isNaN(t(p))).sort((a, b) => t(a) - t(b));
  const i = timed.findIndex((p) => p.id === photo.id);
  if (i < 0) return [photo];
  let lo = i;
  let hi = i;
  while (lo > 0 && t(timed[lo]) - t(timed[lo - 1]) <= gapMs) lo--;
  while (hi < timed.length - 1 && t(timed[hi + 1]) - t(timed[hi]) <= gapMs) hi++;
  return timed.slice(lo, hi + 1);
}
