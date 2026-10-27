/**
 * Pure geometry of the drag handles on the selected antenna's box: the six faces, a face moved
 * with the opposite one fixed (in the box's own, possibly turned and tilted, frame), where the
 * pointer ray puts the dragged face, the `telecom.flag` selection that crops the cloud to a box,
 * and the unit saved once the job measured it again.
 *
 * Boxes in the inventory are project E, N, Z (`AntennaBox`); the drag and the crop work in the
 * stage local frame the box is drawn in (x east, y up, z south).
 */
import type { AntennaBox, AntennaUnit, TelecomFlagParams, Vec3 } from '@aio/schema';
import {
  boxWithValues,
  TYPED_RANGE,
  userValue,
  wasMeasured,
  withTyped,
  withTypedValue,
  type TypedKey,
} from './antennaTyped';

export type BoxAxis = 0 | 1 | 2;
/** A face of the box: its axis (0 across, 1 up, 2 outward) and side. */
export interface BoxFace {
  axis: BoxAxis;
  sign: 1 | -1;
}

export const BOX_FACES: readonly BoxFace[] = [
  { axis: 0, sign: 1 },
  { axis: 0, sign: -1 },
  { axis: 1, sign: 1 },
  { axis: 1, sign: -1 },
  { axis: 2, sign: 1 },
  { axis: 2, sign: -1 },
];

export const faceKey = (f: BoxFace): string => `${String(f.axis)}:${f.sign > 0 ? '+' : '-'}`;

/** The value each axis's size is: width, height, depth. */
export const DIM_KEYS = ['widthM', 'heightM', 'depthM'] as const satisfies readonly TypedKey[];

/** The smallest size a drag leaves, metres. */
export const MIN_BOX_EXTENT_M = 0.05;
/** The largest, the typed value's limit. */
export const MAX_BOX_EXTENT_M = TYPED_RANGE.heightM[1];
/** How far the crop reaches past each face, so the points on the faces are inside. */
export const CROP_PAD_M = 0.03;
/** A re-measured size this much under the dragged one gives way to the dragged one. */
export const SHRINK_TOL_M = 0.02;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const plus = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

export const clampExtent = (e: number): number =>
  Math.min(MAX_BOX_EXTENT_M, Math.max(MIN_BOX_EXTENT_M, e));

/** The box with face `f` moved to make its size `extent` (clamped); the opposite face stays. */
export function resizeBox(box: AntennaBox, f: BoxFace, extent: number): AntennaBox {
  const size = clampExtent(extent);
  const axis = unit(box.axes[f.axis]);
  const centre = plus(box.centre, axis, (f.sign * (size - box.extents[f.axis])) / 2);
  const extents: Vec3 = [...box.extents];
  extents[f.axis] = size;
  return { ...box, centre, extents };
}

/**
 * Where the pointer puts the dragged face: the distance from the fixed face's centre `fixed`
 * along the outward `normal` (unit) to the point of that line nearest the pointer's ray (origin,
 * unit direction). Null when the ray runs along the line. Not clamped.
 */
export function extentFromRay(fixed: Vec3, normal: Vec3, origin: Vec3, dir: Vec3): number | null {
  const w0 = minus(fixed, origin);
  const b = dot(normal, dir);
  const denom = 1 - b * b;
  if (denom < 1e-4) return null;
  return (b * dot(dir, w0) - dot(normal, w0)) / denom;
}

export type BoxSelection = TelecomFlagParams['selection'];

/**
 * The `telecom.flag` selection of a box drawn at `centre` with unit `axes` and `extents` (stage
 * local): an affine `viewProj` (w = 1) maps a point to its offsets along two box axes over their
 * padded half sizes, and the polygon is the square [-1, 1]^2, so the job keeps an exact prism along
 * the third axis; that axis is the box axis nearest a world axis, and the bounds (the padded box's
 * axis-aligned bounds) cut it within a few centimetres of its faces.
 */
export function boxCropSelection(
  centre: Vec3,
  axes: readonly [Vec3, Vec3, Vec3],
  extents: Vec3,
): BoxSelection {
  const along = (a: Vec3) => Math.max(...a.map(Math.abs));
  const ks: BoxAxis[] = [0, 1, 2];
  const prism = ks.reduce<BoxAxis>((best, k) => (along(axes[k]) > along(axes[best]) ? k : best), 1);
  const [u, v] = ks.filter((k) => k !== prism) as [BoxAxis, BoxAxis];
  const half = (k: BoxAxis) => extents[k] / 2 + CROP_PAD_M;
  const row = (k: BoxAxis): [number, number, number, number] => {
    const a = scale(axes[k], 1 / half(k));
    return [a[0], a[1], a[2], -dot(a, centre)];
  };
  const r0 = row(u);
  const r1 = row(v);
  // column-major: element (row r, column c) at c * 4 + r
  const viewProj = [r0[0], r1[0], 0, 0, r0[1], r1[1], 0, 0, r0[2], r1[2], 0, 0, r0[3], r1[3], 0, 1];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    let p = centre;
    for (const k of ks) p = plus(p, axes[k], ((i >> k) & 1 ? 1 : -1) * half(k));
    for (const c of ks) {
      min[c] = Math.min(min[c], p[c]);
      max[c] = Math.max(max[c], p[c]);
    }
  }
  return {
    polygon: [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
    viewProj,
    bounds: { min, max },
    anchor: [centre[0], centre[1], centre[2]],
  };
}

/** A drag on a unit: the face, the unit before it, and the box as dragged (project E, N, Z). */
export interface BoxEdit {
  face: BoxFace;
  before: AntennaUnit;
  box: AntennaBox;
}

/** The unit as drawn while dragged: its box, and the dragged size on its value (basis kept). */
export function draggedUnit(before: AntennaUnit, face: BoxFace, box: AntennaBox): AntennaUnit {
  const key = DIM_KEYS[face.axis];
  const value = before[key];
  return {
    ...before,
    box,
    ...(value ? { [key]: { ...value, value: box.extents[face.axis] } } : {}),
  };
}

/** The values the box and its measurement carry (python `merge.GEOMETRY`, less the box). */
const GEOMETRY = [
  'support',
  'azimuthGridDeg',
  'downtiltDeg',
  'plumbDeg',
  'elevationDeg',
  'diameterM',
  'widthM',
  'heightM',
  'depthM',
  'convergenceDeg',
  'centreHeightM',
  'measured',
] as const;

const TYPED_KEYS: readonly TypedKey[] = [
  'azimuthGridDeg',
  'downtiltDeg',
  'centreHeightM',
  'widthM',
  'heightM',
  'depthM',
];

/** A typed centre height follows the box it describes. */
function centreFollows(u: AntennaUnit): AntennaUnit {
  return u.centreHeightM?.basis === 'user'
    ? { ...u, centreHeightM: userValue(u.box.centre[2]) }
    : u;
}

/**
 * The unit to save once `telecom.flag` measured `after` (the redrawn unit as the job wrote it)
 * from the points in the dragged box, or null when the job's unit stands as it is.
 *
 * - Measured: the new angles and sizes stand. When the dragged size came back more than
 *   `SHRINK_TOL_M` smaller, or the person had typed that size before, the dragged size is kept as
 *   typed (the measured one kept for Reset to measured) and the box is placed so its fixed face
 *   stays where it was along the new axis. Typed values rebuild the box, as after a redraw.
 * - Too few points (the job's placeholder): the dragged box with the unit's earlier angles and
 *   values; the dragged size typed when the unit had a value for it. A unit never measured keeps
 *   no numbers.
 */
export function settleBoxEdit(after: AntennaUnit, edit: BoxEdit): AntennaUnit | null {
  const { face, before, box } = edit;
  const key = DIM_KEYS[face.axis];
  const extent = box.extents[face.axis];

  if (!wasMeasured(after)) {
    const geometry = new Set<string>(GEOMETRY);
    const rest = Object.fromEntries(Object.entries(after).filter(([k]) => !geometry.has(k)));
    const kept: Record<string, unknown> = {};
    for (const k of GEOMETRY) if (before[k] !== undefined) kept[k] = before[k];
    let u = { ...rest, ...kept, box } as AntennaUnit;
    // a measured centre height described the box before the drag: it no longer does
    if (u.centreHeightM && u.centreHeightM.basis !== 'user') delete u.centreHeightM;
    if (before[key] !== undefined) u = withTypedValue(u, key, extent);
    return centreFollows(u);
  }

  // a typed centre height is the job's measured centre now (the box it described moved), so the
  // rebuild from typed values does not pull the fixed face along
  const measuredAfter: AntennaUnit =
    after.centreHeightM?.basis === 'user'
      ? { ...after, centreHeightM: userValue(after.box.centre[2]) }
      : after;
  const typedAny = TYPED_KEYS.some((k) => measuredAfter[k]?.basis === 'user');
  const base: AntennaUnit = typedAny
    ? { ...measuredAfter, box: boxWithValues(measuredAfter) }
    : measuredAfter;
  const value = after[key];
  const measured = value?.basis === 'user' ? after.measured?.[key]?.value : value?.value;
  const wasTyped = before[key]?.basis === 'user';
  const shrunk = measured === undefined || measured < extent - SHRINK_TOL_M;
  if (!wasTyped && !shrunk) return typedAny ? base : null;

  const u = withTyped(base, key, extent);
  // the fixed face where it was, along the new axis turned to point out of the dragged face
  const outOld = scale(unit(box.axes[face.axis]), face.sign);
  const fixed = plus(box.centre, outOld, -extent / 2);
  const a = unit(u.box.axes[face.axis]);
  const out = dot(a, outOld) >= 0 ? a : scale(a, -1);
  const shift = dot(minus(fixed, u.box.centre), out) + extent / 2;
  return centreFollows({ ...u, box: { ...u.box, centre: plus(u.box.centre, out, shift) } });
}
