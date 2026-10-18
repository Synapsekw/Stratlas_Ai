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

/**
 * The turn and scale of a date's line-up, saved next to `lineUp` (never inside it): a similarity
 * about the pivot (project CRS) on top of the shift. Present only when it is not the identity
 * (|rotationDeg| > 1e-6 or |scale - 1| > 1e-7). Not strict, so later fields stay additive.
 * The bounds are a storage envelope (|rotationDeg| <= 2, scale in [0.98, 1.02]) so composed and
 * inverted line-ups still save; a single measurement is held to 1 degree and 1% by the measuring
 * step, not here.
 */
export const CaptureLineUpTurn = z.object({
  rotationDeg: z.number().min(-2).max(2),
  scale: z.number().min(0.98).max(1.02),
  pivotE: z.number(),
  pivotN: z.number(),
});
export type CaptureLineUpTurn = z.infer<typeof CaptureLineUpTurn>;

/**
 * A turn as the helpers apply it: `rotationDeg` counter-clockwise (east towards north), `scale`,
 * the pivot in the project CRS (`pivotE`, `pivotN`) and in the local frame (`pivotX` =
 * pivotE - origin E, `pivotZ` = origin N - pivotN), resolved once from the project origin.
 */
export interface DateTurn {
  rotationDeg: number;
  scale: number;
  pivotE: number;
  pivotN: number;
  pivotX: number;
  pivotZ: number;
}

/**
 * A date's correction: the shift and, optionally, a turn and scale about a pivot. A literal
 * `{ eastM, northM }` has no turn and means a plain shift. With a turn, a project CRS point moves
 * as E' = Pe + a(E-Pe) - b(N-Pn) + eastM, N' = Pn + b(E-Pe) + a(N-Pn) + northM, where
 * a = scale cos(rot), b = scale sin(rot). Heights never change.
 */
export type DateShift = z.infer<typeof DateShiftSchema> & { turn?: DateTurn };
export type CaptureLineUp = z.infer<typeof CaptureLineUp>;

const ZERO_M = 0.0005;
const ZERO_DEG = 1e-6;
const ZERO_SCALE = 1e-7;
const RAD = Math.PI / 180;

/** True for a turn that is not the identity (the rule for saving `lineUpTurn`). */
export function hasTurn(t: { rotationDeg: number; scale: number } | null | undefined): boolean {
  return !!t && (Math.abs(t.rotationDeg) > ZERO_DEG || Math.abs(t.scale - 1) > ZERO_SCALE);
}

/** The turn a shift applies, or undefined for none (or an identity one). */
function turnIn(s: DateShift): DateTurn | undefined {
  return s.turn && hasTurn(s.turn) ? s.turn : undefined;
}

function coeffs(t: DateTurn): [number, number] {
  const r = t.rotationDeg * RAD;
  return [t.scale * Math.cos(r), t.scale * Math.sin(r)];
}

/**
 * The shift a capture carries, or null when it has none. `origin` is the project origin, which
 * places the turn's pivot in the local frame; a capture without `lineUpTurn` gets no `turn`.
 */
export function captureLineUpShift(c: Capture, origin: Vec3): DateShift | null {
  if (!c.lineUp) return null;
  const s: DateShift = { eastM: c.lineUp.eastM, northM: c.lineUp.northM };
  const t = c.lineUpTurn;
  if (t)
    s.turn = {
      rotationDeg: t.rotationDeg,
      scale: t.scale,
      pivotE: t.pivotE,
      pivotN: t.pivotN,
      pivotX: t.pivotE - origin[0],
      pivotZ: origin[1] - t.pivotN,
    };
  return s;
}

/** The turn of a shift as `lineUpTurn` saves it, or null for none (or an identity one). */
export function turnOf(s: DateShift | null | undefined): CaptureLineUpTurn | null {
  const t = s ? turnIn(s) : undefined;
  return t
    ? { rotationDeg: t.rotationDeg, scale: t.scale, pivotE: t.pivotE, pivotN: t.pivotN }
    : null;
}

/**
 * A shift as a cache key: `"e,n"` to the millimetre (empty for none), and with a turn
 * `"e,n,r<rotationDeg to 1e-6>,s<scale to 1e-7>,p<pivotE>,<pivotN to mm>"`. A shift without a
 * turn keeps the plain `"e,n"` key, so older caches stay valid.
 */
export function shiftKey(s: DateShift | null | undefined): string {
  if (!s) return '';
  const fix = (v: number, d: number) => String(Number(v.toFixed(d)) + 0);
  const base = `${fix(s.eastM, 3)},${fix(s.northM, 3)}`;
  const t = turnIn(s);
  if (!t) return base;
  return `${base},r${fix(t.rotationDeg, 6)},s${fix(t.scale, 7)},p${fix(t.pivotE, 3)},${fix(t.pivotN, 3)}`;
}

/** True for no shift, or one within half a millimetre on both axes and with no turn. */
export function isZeroShift(s: DateShift | null | undefined): boolean {
  return !s || (Math.abs(s.eastM) <= ZERO_M && Math.abs(s.northM) <= ZERO_M && !turnIn(s));
}

/**
 * The exact inverse of a shift: undoing it puts every point back. The turn keeps its pivot, with
 * the opposite rotation and 1/scale (which may fall just outside the saved bounds).
 */
export function invertShift(s: DateShift): DateShift {
  const t = turnIn(s);
  if (!t) return { eastM: -s.eastM, northM: -s.northM };
  const turn: DateTurn = { ...t, rotationDeg: -t.rotationDeg, scale: 1 / t.scale };
  const [a, b] = coeffs(turn);
  return {
    eastM: -(a * s.eastM - b * s.northM),
    northM: -(b * s.eastM + a * s.northM),
    turn,
  };
}

/**
 * `then` applied after `first`, as one shift. A similarity after a similarity is again one; it is
 * expressed about the pivot of `then` (the newer line-up) when that has a turn, else of `first`.
 */
export function composeShift(first: DateShift, then: DateShift): DateShift {
  const t1 = turnIn(first);
  const t2 = turnIn(then);
  const p = t2 ?? t1;
  if (!p) return { eastM: first.eastM + then.eastM, northM: first.northM + then.northM };
  const turn: DateTurn = {
    rotationDeg: (t1?.rotationDeg ?? 0) + (t2?.rotationDeg ?? 0),
    scale: (t1?.scale ?? 1) * (t2?.scale ?? 1),
    pivotE: p.pivotE,
    pivotN: p.pivotN,
    pivotX: p.pivotX,
    pivotZ: p.pivotZ,
  };
  // the pivot itself moves by the translation of the composite
  const q = shiftEN(shiftEN<[number, number]>([p.pivotE, p.pivotN], first), then);
  const out: DateShift = { eastM: q[0] - p.pivotE, northM: q[1] - p.pivotN };
  if (hasTurn(turn)) out.turn = turn;
  return out;
}

/** A local point (x east, y up, z south) moved by the shift: x += east, z -= north, turned about the pivot. */
export function shiftLocal(p: Vec3, s: DateShift | null): Vec3 {
  if (!s || isZeroShift(s)) return p;
  const t = turnIn(s);
  if (!t) return [p[0] + s.eastM, p[1], p[2] - s.northM];
  const [a, b] = coeffs(t);
  const dx = p[0] - t.pivotX;
  const dz = p[2] - t.pivotZ;
  return [t.pivotX + a * dx + b * dz + s.eastM, p[1], t.pivotZ - b * dx + a * dz - s.northM];
}

/** The inverse of `shiftLocal`: what a writer stores for a point drawn on a dated layer. */
export function unshiftLocal(p: Vec3, s: DateShift | null): Vec3 {
  if (!s || isZeroShift(s)) return p;
  if (turnIn(s)) return shiftLocal(p, invertShift(s));
  return [p[0] - s.eastM, p[1], p[2] + s.northM];
}

/** A project CRS position (E, N first, any further entries kept) moved by the shift; `sign` -1 undoes it. */
export function shiftEN<T extends readonly number[]>(
  p: T,
  s: DateShift | null,
  sign: 1 | -1 = 1,
): T {
  if (!s || isZeroShift(s)) return p;
  const t = turnIn(s);
  if (t) {
    if (sign === -1) return shiftEN(p, invertShift(s));
    const [a, b] = coeffs(t);
    const out = [...p];
    const dE = (out[0] ?? 0) - t.pivotE;
    const dN = (out[1] ?? 0) - t.pivotN;
    out[0] = t.pivotE + a * dE - b * dN + s.eastM;
    out[1] = t.pivotN + b * dE + a * dN + s.northM;
    return out as unknown as T;
  }
  const out = [...p];
  out[0] = (out[0] ?? 0) + sign * s.eastM;
  out[1] = (out[1] ?? 0) + sign * s.northM;
  return out as unknown as T;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * A column-major 4x4 premultiplied by the shift in the local frame. A plain shift adds to the
 * translation (elements 12 and 14); a turn also turns and scales the transform about the pivot.
 */
export function shiftTransform(
  t: readonly number[] | undefined,
  s: DateShift | null,
): number[] | undefined {
  if (!s || isZeroShift(s)) return t as number[] | undefined;
  const out = t ? [...t] : [...IDENTITY];
  const turn = turnIn(s);
  if (!turn) {
    out[12] = (out[12] ?? 0) + s.eastM;
    out[14] = (out[14] ?? 0) - s.northM;
    return out;
  }
  // S = [a 0 b cx; 0 1 0 0; -b 0 a cz; 0 0 0 1] in the local frame (x east, z south)
  const [a, b] = coeffs(turn);
  const px = turn.pivotX;
  const pz = turn.pivotZ;
  const cx = px - a * px - b * pz + s.eastM;
  const cz = pz + b * px - a * pz - s.northM;
  for (let c = 0; c < 4; c++) {
    const x = out[c * 4] ?? 0;
    const z = out[c * 4 + 2] ?? 0;
    const w = out[c * 4 + 3] ?? 0;
    out[c * 4] = a * x + b * z + cx * w;
    out[c * 4 + 2] = -b * x + a * z + cz * w;
  }
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
 * A stored layer transform as drawn on its date (drawn = shift * stored). The builder tools show
 * and edit placements in this frame, as the person sees them, and save `storedTransform` of it.
 */
export function drawnTransform(t: Mat4, s: DateShift | null): Mat4 {
  return shiftTransform(t, s) ?? t;
}

/** What a builder tool saves for a transform drawn on a lined-up date (stored = shift⁻¹ * drawn). */
export function storedTransform(t: Mat4, s: DateShift | null): Mat4 {
  if (!s || isZeroShift(s)) return t;
  return shiftTransform(t, invertShift(s)) ?? t;
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
      // The offset is added to the clip's positions, so it is not a point: it takes the move the
      // shift makes at its pivot, shiftLocal(pivot) - pivot = (eastM, 0, -northM), which is the
      // plain shift with or without a turn. That is exact for a camera at the pivot; a camera at r
      // is off by (L - I)(r - P), at most about |r - P| * (|rot in rad| + |scale - 1|) (some
      // 0.5 m per 100 m from the pivot at 0.1 degree and 0.35%, 2.7 m at 1 degree and 1%). The
      // clip path itself is not turned until stage 2.
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
