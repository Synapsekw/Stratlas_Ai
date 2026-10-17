import { z } from 'zod';
import type { RasterCorners } from './builder';
import { Id, type Mat4, type Vec3 } from './common';
import type { Layer } from './layers';
import type { Capture } from './manifest';

/** A shift of a survey date: metres east and north in the project frame. */
export const DateShiftSchema = z
  .object({ eastM: z.number().min(-500).max(500), northM: z.number().min(-500).max(500) })
  .strict();

/**
 * A measured sideways shift saved on a capture (data-conventions section 38): the absolute
 * correction of this date; `with` is the date it was lined up with when saved (shown, never
 * followed).
 */
export const CaptureLineUp = z
  .object({
    eastM: z.number().min(-500).max(500),
    northM: z.number().min(-500).max(500),
    with: Id,
    spreadM: z.number().nonnegative().optional(),
    at: z.iso.datetime(),
  })
  .strict();

export type DateShift = z.infer<typeof DateShiftSchema>;
export type CaptureLineUp = z.infer<typeof CaptureLineUp>;

const ZERO_M = 0.0005;

/** The shift a capture carries, or null when it has none. */
export function captureLineUpShift(c: Capture): DateShift | null {
  return c.lineUp ? { eastM: c.lineUp.eastM, northM: c.lineUp.northM } : null;
}

/** True for no shift, or one within half a millimetre on both axes. */
export function isZeroShift(s: DateShift | null | undefined): boolean {
  return !s || (Math.abs(s.eastM) <= ZERO_M && Math.abs(s.northM) <= ZERO_M);
}

/** A local point (x east, y up, z south) moved by the shift: x += east, z -= north. */
export function shiftLocal(p: Vec3, s: DateShift | null): Vec3 {
  if (!s || isZeroShift(s)) return p;
  return [p[0] + s.eastM, p[1], p[2] - s.northM];
}

/** The inverse of `shiftLocal`: what a writer stores for a point drawn on a dated layer. */
export function unshiftLocal(p: Vec3, s: DateShift | null): Vec3 {
  if (!s || isZeroShift(s)) return p;
  return [p[0] - s.eastM, p[1], p[2] + s.northM];
}

/** A project CRS position (E, N first, any further entries kept) moved by the shift; `sign` -1 undoes it. */
export function shiftEN<T extends readonly number[]>(
  p: T,
  s: DateShift | null,
  sign: 1 | -1 = 1,
): T {
  if (!s || isZeroShift(s)) return p;
  const out = [...p];
  out[0] = (out[0] ?? 0) + sign * s.eastM;
  out[1] = (out[1] ?? 0) + sign * s.northM;
  return out as unknown as T;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A column-major 4x4 with the shift added to its translation (elements 12 and 14). */
export function shiftTransform(
  t: readonly number[] | undefined,
  s: DateShift | null,
): number[] | undefined {
  if (!s || isZeroShift(s)) return t as number[] | undefined;
  const out = t ? [...t] : [...IDENTITY];
  out[12] = (out[12] ?? 0) + s.eastM;
  out[14] = (out[14] ?? 0) - s.northM;
  return out;
}

export function shiftCorners(c: RasterCorners, s: DateShift | null): RasterCorners {
  if (!s || isZeroShift(s)) return c;
  return { tl: shiftLocal(c.tl, s), tr: shiftLocal(c.tr, s), bl: shiftLocal(c.bl, s) };
}

/** Raster corners drawn on a lined-up date as the raster stores them (the inverse of `shiftCorners`). */
export function unshiftCorners(c: RasterCorners, s: DateShift | null): RasterCorners {
  if (!s || isZeroShift(s)) return c;
  return { tl: unshiftLocal(c.tl, s), tr: unshiftLocal(c.tr, s), bl: unshiftLocal(c.bl, s) };
}

/**
 * A stored layer transform as drawn on its date (drawn = stored + shift). The builder tools show
 * and edit placements in this frame, as the person sees them, and save `storedTransform` of it.
 */
export function drawnTransform(t: Mat4, s: DateShift | null): Mat4 {
  return shiftTransform(t, s) ?? t;
}

/** What a builder tool saves for a transform drawn on a lined-up date (stored = drawn - shift). */
export function storedTransform(t: Mat4, s: DateShift | null): Mat4 {
  if (!s || isZeroShift(s)) return t;
  return shiftTransform(t, { eastM: -s.eastM, northM: -s.northM }) ?? t;
}

/**
 * The layer as placed on its date: mesh `transform`, raster `corners`, panorama positions, video
 * `positionOffsetM`. Every other kind comes back as it is; its reader applies the shift.
 */
export function shiftedLayer(layer: Layer, s: DateShift | null): Layer {
  if (!s || isZeroShift(s)) return layer;
  switch (layer.kind) {
    case 'mesh':
      return { ...layer, transform: shiftTransform(layer.transform, s) ?? layer.transform };
    case 'raster':
      return layer.corners ? { ...layer, corners: shiftCorners(layer.corners, s) } : layer;
    case 'panoramas':
      // a 360 that is not placed yet has no position to move
      return {
        ...layer,
        items: layer.items.map((it) => (it.pos ? { ...it, pos: shiftLocal(it.pos, s) } : it)),
      };
    case 'video': {
      const o = layer.positionOffsetM ?? [0, 0, 0];
      return { ...layer, positionOffsetM: [o[0] + s.eastM, o[1], o[2] - s.northM] };
    }
    default:
      return layer;
  }
}

/**
 * Video direction keyframes as drawn on a lined-up date: a `lookAt` keyframe's `target` (a local
 * point in orientation.json) moves with the date like the clip's camera; other keyframes are
 * directions and stay. The same array for no shift (or none given).
 */
export function shiftedDirectionKeys<K extends { fill: string; target?: Vec3 | undefined }>(
  keys: readonly K[] | null | undefined,
  s: DateShift | null,
): readonly K[] | null | undefined {
  if (!keys || !s || isZeroShift(s)) return keys;
  if (!keys.some((k) => k.fill === 'lookAt' && k.target)) return keys;
  return keys.map((k) =>
    k.fill === 'lookAt' && k.target ? { ...k, target: shiftLocal(k.target, s) } : k,
  );
}
