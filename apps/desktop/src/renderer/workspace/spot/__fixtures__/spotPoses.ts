import type { LensModel, Quat, Vec3 } from '@aio/schema';
import { DEFAULT_PHOTO_LENS } from '@aio/video';
import { quatMul } from '../spotGeom';
import type { FrameSample, PanoEntry, PhotoEntry, TrackSample } from '../spotTypes';

/** A camera looking along compass `bearingDeg`, tilted up by `pitchDeg` (-90: straight down). */
export function lookQuat(bearingDeg: number, pitchDeg = 0): Quat {
  const y = (-bearingDeg * Math.PI) / 360;
  const p = (pitchDeg * Math.PI) / 360;
  return quatMul([0, Math.sin(y), 0, Math.cos(y)], [Math.sin(p), 0, 0, Math.cos(p)]);
}
export const LENS: LensModel = DEFAULT_PHOTO_LENS;

export function photoAt(
  id: string,
  pos: Vec3 | undefined,
  bearingDeg: number | null,
  o: { pitchDeg?: number; capture?: string | undefined; layer?: string; lens?: boolean } = {},
): PhotoEntry {
  const pose =
    pos && bearingDeg !== null
      ? { pos, q: lookQuat(bearingDeg, o.pitchDeg ?? 0), lens: LENS }
      : null;
  return {
    kind: 'photo',
    layer: o.layer ?? 'photos-d2',
    // an explicit `capture: undefined` is an undated layer
    capture: 'capture' in o ? o.capture : 'd2',
    id,
    ...(pos ? { pos } : {}),
    pose,
    hasLens: o.lens ?? true,
  };
}
export function panoAt(id: string, pos: Vec3, capture = 'd2', headingDeg = 0): PanoEntry {
  return { kind: 'pano', layer: `pano-${capture}`, capture, id, pos, headingDeg };
}
export const track = (pts: [number, number, number][], bearingDeg = 0): TrackSample[] =>
  pts.map(([t, x, z]) => ({ t, pos: [x, 1.7, z], groundY: 0, bearingDeg }));
/** A drone looking straight down at 40 m, flying east along z = -15: x = -50 + 10 t. */
export const overflight = (n = 11): FrameSample[] =>
  Array.from({ length: n }, (_, t) => ({
    t,
    pose: { pos: [-50 + 10 * t, 40, -15] as Vec3, q: lookQuat(0, -90), lens: LENS },
  }));
