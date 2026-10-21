import type { PhotoCorrection, Vec3 } from '@aio/schema';

/*
 * "Edit position" of photos: the panel shows and takes X (east), Y (north) in site metres from the
 * project origin and Z as the project height H (data-conventions section 1 and 3a); the photo's
 * hand correction stores the move as `offsetM` in the local frame (x east, y up, z south). Every
 * conversion between the two goes through these helpers.
 */

/** A position as the panel shows it: metres east and north of the origin, project height. */
export interface SiteXYZ {
  x: number;
  y: number;
  z: number;
}

/** What a typed value is: an absolute X, Y or Z, or one component of a shift. */
export type MetresKind = 'x' | 'y' | 'z' | 'shift';

/**
 * Offsets under 0.5 mm count as no move: the same rule `correctionTo` (photo.ts) applies before
 * it writes an `offsetM`.
 */
const OFFSET_EPS_M = 5e-4;

/** `0 - v` and `v + 0` turn -0 into +0 so values compare and print cleanly. */
const plus0 = (v: number) => v + 0;

/** A local position (x east, y up, z south) as the panel's X east, Y north, Z project height. */
export function siteXYZ(pos: Vec3, origin: Vec3): SiteXYZ {
  return { x: plus0(pos[0]), y: 0 - pos[2], z: origin[2] + pos[1] };
}

/** The panel's X, Y, Z back to the local frame; the inverse of `siteXYZ`. */
export function localFromSite(xyz: SiteXYZ, origin: Vec3): Vec3 {
  return [plus0(xyz.x), xyz.z - origin[2], 0 - xyz.y];
}

/** A site shift (dX east, dY north, dZ up) as a local-frame offset. */
export function shiftToOffset(shift: SiteXYZ): Vec3 {
  return [plus0(shift.x), plus0(shift.z), 0 - shift.y];
}

const round01mm = (v: number) => plus0(Math.round(v * 1e4) / 1e4);

/** The offset that puts a photo imported at `imported` at the typed X, Y, Z (0.1 mm steps). */
export function offsetForPosition(imported: Vec3, origin: Vec3, xyz: SiteXYZ): Vec3 {
  const l = localFromSite(xyz, origin);
  return [
    round01mm(l[0] - imported[0]),
    round01mm(l[1] - imported[1]),
    round01mm(l[2] - imported[2]),
  ];
}

const isMove = (o: Vec3 | null | undefined): o is Vec3 =>
  !!o && o.some((v) => Math.abs(v) >= OFFSET_EPS_M);

/** True when a correction moves the photo (an offset of 0.5 mm or more in any component). */
export function isPositionEdited(c: PhotoCorrection | null | undefined): boolean {
  return isMove(c?.offsetM);
}

/**
 * A correction with its position offset set (or removed with null, or with an offset under
 * 0.5 mm); its rotations are kept. Null when nothing is left, so the entry is removed from
 * `orientation.json` instead of saved as zeros.
 */
export function withPositionOffset(
  cur: PhotoCorrection | undefined,
  offsetM: Vec3 | null,
): PhotoCorrection | null {
  const rot = {
    yawDeg: cur?.yawDeg ?? 0,
    pitchDeg: cur?.pitchDeg ?? 0,
    rollDeg: cur?.rollDeg ?? 0,
  };
  if (isMove(offsetM)) return { ...rot, offsetM };
  const turned =
    Math.abs(rot.yawDeg) > 1e-9 || Math.abs(rot.pitchDeg) > 1e-9 || Math.abs(rot.rollDeg) > 1e-9;
  return turned ? rot : null;
}

const LIMITS: Record<MetresKind, readonly [number, number]> = {
  x: [-100_000, 100_000],
  y: [-100_000, 100_000],
  z: [-1000, 10_000],
  shift: [-10_000, 10_000],
};

const NUMBER = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

/**
 * A typed value in metres, or null when empty, not a number or out of range (X, Y within 100 km
 * of the origin, Z from -1000 to 10000 m, a shift within 10000 m either way). Takes a leading
 * `+` or `-` and a dot or comma decimal.
 */
export function parseMetres(text: string, kind: MetresKind): number | null {
  const t = text.trim();
  if (!NUMBER.test(t)) return null;
  const v = Number(t.replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  const [lo, hi] = LIMITS[kind];
  return v < lo || v > hi ? null : plus0(v);
}
