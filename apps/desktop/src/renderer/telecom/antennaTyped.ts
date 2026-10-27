import type { AntennaBox, AntennaMeasured, AntennaUnit, AntennaValue, Vec3 } from '@aio/schema';

/**
 * Values a person types on an antenna card, and the box they imply. A typed value has basis
 * `user`; the measured value it replaces is kept in `measured` so Reset to measured can bring it
 * back. The box follows the values in project ENZ with the conventions of
 * `python/src/aio_pipelines/telecom/measure.py`: azimuth clockwise from grid north of the outward
 * normal, downtilt positive when the normal points down, plumb positive when the top leans right
 * seen from the front, and the across axis is that right (`up x outward`).
 */

export type TypedKey =
  'azimuthGridDeg' | 'downtiltDeg' | 'centreHeightM' | 'widthM' | 'heightM' | 'depthM';

/** Inclusive ranges; an azimuth of 360 reads as 0. */
export const TYPED_RANGE: Record<TypedKey, [number, number]> = {
  azimuthGridDeg: [0, 360],
  downtiltDeg: [-90, 90],
  centreHeightM: [-1000, 10000],
  widthM: [0.01, 10],
  heightM: [0.01, 10],
  depthM: [0.01, 10],
};

/** The geometry values a re-run never overwrites when a person typed them (python `merge.py`). */
const GEOMETRY_VALUES = [
  'azimuthGridDeg',
  'downtiltDeg',
  'plumbDeg',
  'elevationDeg',
  'diameterM',
  'widthM',
  'heightM',
  'depthM',
  'centreHeightM',
] as const;

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;
const D = Math.PI / 180;

/** A typed number (dot decimal, trimmed), or `null` when it is not a number or out of range. */
export function parseTyped(key: TypedKey, text: string): number | null {
  const t = text.trim();
  if (!NUMBER.test(t)) return null;
  const v = Number(t);
  const [lo, hi] = TYPED_RANGE[key];
  if (!Number.isFinite(v) || v < lo || v > hi) return null;
  if (key === 'azimuthGridDeg' && v === 360) return 0;
  return v;
}

export function userValue(value: number): AntennaValue {
  return { value, basis: 'user', quality: { basis: 'user' } };
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const clean = (v: Vec3): Vec3 => [v[0] + 0, v[1] + 0, v[2] + 0];

/** The box a unit's values imply; what a value does not give is taken from the current box. */
export function boxWithValues(unit: AntennaUnit): AntennaBox {
  const { box } = unit;
  const cur = box.axes[2];
  const len = Math.hypot(...cur) || 1;
  const a = (unit.azimuthGridDeg?.value ?? Math.atan2(cur[0], cur[1]) / D) * D;
  const t =
    (unit.downtiltDeg?.value ?? -Math.asin(Math.max(-1, Math.min(1, cur[2] / len))) / D) * D;
  const p = (unit.plumbDeg?.value ?? 0) * D;
  const n: Vec3 = [Math.cos(t) * Math.sin(a), Math.cos(t) * Math.cos(a), -Math.sin(t)];
  // the in-plane vertical, then turned by the plumb towards the right seen from the front
  const up0: Vec3 = [Math.sin(t) * Math.sin(a), Math.sin(t) * Math.cos(a), Math.cos(t)];
  const right = cross(up0, n);
  const up: Vec3 = [
    Math.cos(p) * up0[0] + Math.sin(p) * right[0],
    Math.cos(p) * up0[1] + Math.sin(p) * right[1],
    Math.cos(p) * up0[2] + Math.sin(p) * right[2],
  ];
  const across = cross(up, n);
  return {
    centre: [box.centre[0], box.centre[1], unit.centreHeightM?.value ?? box.centre[2]],
    axes: [clean(across), clean(up), clean(n)],
    extents: [
      unit.widthM?.value ?? box.extents[0],
      unit.heightM?.value ?? box.extents[1],
      unit.depthM?.value ?? box.extents[2],
    ],
  };
}

const withMeasured = (unit: AntennaUnit, measured: AntennaMeasured): AntennaUnit => {
  const rest = { ...unit };
  delete rest.measured;
  return Object.keys(measured).length > 0 ? { ...rest, measured } : rest;
};

/** Measured from the cloud: a size the geometry gave, now or before a person typed over it. */
export const wasMeasured = (u: AntennaUnit): boolean =>
  (u.widthM !== undefined && u.widthM.basis !== 'user') || u.measured?.widthM !== undefined;

/** The unit with `key` typed as `value` and the measured value it replaces kept; the box as it is. */
export function withTypedValue(unit: AntennaUnit, key: TypedKey, value: number): AntennaUnit {
  const cur = unit[key];
  const measured: AntennaMeasured = { ...unit.measured };
  if (cur && cur.basis !== 'user') measured[key] = cur;
  else if (!cur && key === 'centreHeightM' && wasMeasured(unit) && !measured.centreHeightM)
    measured.centreHeightM = {
      value: unit.box.centre[2],
      basis: 'measured',
      quality: { basis: 'measured' },
    };
  return withMeasured({ ...unit, [key]: userValue(value) }, measured);
}

/** The unit with `key` typed as `value`, the measured value it replaces kept, and its box rebuilt. */
export function withTyped(unit: AntennaUnit, key: TypedKey, value: number): AntennaUnit {
  const next = withTypedValue(unit, key, value);
  return { ...next, box: boxWithValues(next) };
}

/** Reset to measured: the kept measured value comes back and the box is rebuilt. */
export function withoutTyped(unit: AntennaUnit, key: TypedKey): AntennaUnit {
  const restored = unit.measured?.[key];
  if (unit[key]?.basis !== 'user' || !restored) return unit;
  const measured: AntennaMeasured = Object.fromEntries(
    Object.entries(unit.measured ?? {}).filter(([k]) => k !== key),
  );
  const next = withMeasured({ ...unit, [key]: restored }, measured);
  return { ...next, box: boxWithValues(next) };
}

/** Whether Reset to measured is offered: the value is the person's and a measured one is kept. */
export function canReset(unit: AntennaUnit, key: TypedKey): boolean {
  return unit[key]?.basis === 'user' && unit.measured?.[key] !== undefined;
}

/** Flagged by a person, or with a geometry value a person typed (python `person_owned`). */
export function isPersonOwned(u: AntennaUnit): boolean {
  return u.origin === 'flagged' || GEOMETRY_VALUES.some((k) => u[k]?.basis === 'user');
}

/** Flagged with too few points to measure: no numbers until a person types them. */
export function isNotMeasured(u: AntennaUnit): boolean {
  return u.origin === 'flagged' && u.widthM === undefined;
}
