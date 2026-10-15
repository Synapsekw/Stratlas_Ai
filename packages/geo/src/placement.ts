import type { Georef, Mat4, Vec3 } from '@aio/schema';
import { gridConvergenceDeg } from './crs';
import { fromWgs84, isKnownCrs, localToProject, toWgs84 } from './index';

/**
 * Placing a georeferenced model in a project (engineering model spec section 5.6).
 *
 * A `Georef` maps model xyz (x east, y up, z south) to E, N, H in its CRS (`modelToCrs`,
 * column-major). A mesh layer's `transform` maps the same model xyz to the project's local frame
 * (x = E - E0, y = H - H0, z = -(N - N0)). Everything here stays in float64; the layer transform is
 * always computed whole from the record (never composed onto an existing layer transform), so a
 * record cannot be applied twice.
 */

/** The project side of a placement: its CRS, float64 origin (E0, N0, H0) and vertical datum. */
export interface ProjectGeo {
  crs: { epsg: number } | { wkt: string };
  origin: Vec3;
  /** Absent or 'unknown' when the project does not declare one. */
  verticalDatum?: string;
}

export type PlacementResult =
  | {
      kind: 'placed';
      /** Model xyz to the project's local frame, column-major. */
      transform: Mat4;
      /**
       * Rotation about the up axis added by a change of CRS, degrees, counter-clockwise seen from
       * above (the convergence of the project CRS minus that of the record's, at the anchor). The
       * grid heading of the model changes by minus this. 0 within one CRS.
       */
      headingDeltaDeg: number;
      /** Set when the two projections' scale factors at the anchor differ by more than 1e-4. */
      scaleNote?: string;
      /** Set when either vertical datum is unknown: heights are taken as they are. */
      heightNote?: string;
    }
  | {
      kind: 'needed';
      reason: string;
      /** Horizontal placement when only the height cannot be placed (H taken as is). */
      horizontalOnly?: Mat4;
    };

const RAD = Math.PI / 180;

/** E, N, H from one EPSG CRS to another through WGS84. Height passes through unchanged. */
export function transformPoint(p: Vec3, fromEpsg: number, toEpsg: number): Vec3 {
  if (fromEpsg === toEpsg) return [p[0], p[1], p[2]];
  return fromWgs84(toWgs84(p, fromEpsg), toEpsg);
}

/* ---- small column-major 4x4 helpers (element row r, column c at c * 4 + r) ---- */

const at = (m: readonly number[], r: number, c: number): number => m[c * 4 + r] ?? NaN;

function mul(a: readonly number[], b: readonly number[]): Mat4 {
  const out: number[] = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += at(a, r, k) * at(b, k, c);
      out[c * 4 + r] = s;
    }
  return out;
}

const translation = (t: Vec3): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];

function apply(m: readonly number[], p: Vec3): Vec3 {
  return [
    at(m, 0, 0) * p[0] + at(m, 0, 1) * p[1] + at(m, 0, 2) * p[2] + at(m, 0, 3),
    at(m, 1, 0) * p[0] + at(m, 1, 1) * p[1] + at(m, 1, 2) * p[2] + at(m, 1, 3),
    at(m, 2, 0) * p[0] + at(m, 2, 1) * p[1] + at(m, 2, 2) * p[2] + at(m, 2, 3),
  ];
}

/** An affine matrix: 16 finite numbers with a bottom row of 0, 0, 0, 1. */
function isAffine(m: readonly number[]): boolean {
  return (
    m.length === 16 &&
    m.every((v) => Number.isFinite(v)) &&
    at(m, 3, 0) === 0 &&
    at(m, 3, 1) === 0 &&
    at(m, 3, 2) === 0 &&
    at(m, 3, 3) === 1
  );
}

/** Model point that an affine matrix maps to `p`, or null when the matrix is singular. */
function solve(m: readonly number[], p: Vec3): Vec3 | null {
  const [a, b, c] = [at(m, 0, 0), at(m, 0, 1), at(m, 0, 2)];
  const [d, e, f] = [at(m, 1, 0), at(m, 1, 1), at(m, 1, 2)];
  const [g, h, i] = [at(m, 2, 0), at(m, 2, 1), at(m, 2, 2)];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const x = p[0] - at(m, 0, 3);
  const y = p[1] - at(m, 1, 3);
  const z = p[2] - at(m, 2, 3);
  return [
    ((e * i - f * h) * x - (b * i - c * h) * y + (b * f - c * e) * z) / det,
    (-(d * i - f * g) * x + (a * i - c * g) * y - (a * f - c * d) * z) / det,
    ((d * h - e * g) * x - (a * h - b * g) * y + (a * e - b * d) * z) / det,
  ];
}

/** E, N, H matrix to the project's local frame: x = E - E0, y = H - H0, z = -(N - N0). */
function enhToLocal(m: readonly number[], o: Vec3): Mat4 {
  const out: number[] = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    const w = at(m, 3, c);
    out[c * 4 + 0] = at(m, 0, c) - o[0] * w;
    out[c * 4 + 1] = at(m, 2, c) - o[2] * w;
    // `0 - x` keeps +0 instead of -0
    out[c * 4 + 2] = 0 - (at(m, 1, c) - o[1] * w);
    out[c * 4 + 3] = w;
  }
  return out;
}

/** Local frame matrix back to E, N, H: E = E0 + x, N = N0 - z, H = H0 + y. */
function localToEnh(m: readonly number[], o: Vec3): Mat4 {
  const out: number[] = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    const w = at(m, 3, c);
    out[c * 4 + 0] = at(m, 0, c) + o[0] * w;
    out[c * 4 + 1] = o[1] * w - at(m, 2, c);
    out[c * 4 + 2] = at(m, 1, c) + o[2] * w;
    out[c * 4 + 3] = w;
  }
  return out;
}

/** A metric CRS the bundled registry reads (4326 is in degrees, so not a placement frame). */
function metricEpsg(crs: { epsg: number } | { wkt: string }): number | null {
  if (!('epsg' in crs)) return null;
  return crs.epsg !== 4326 && isKnownCrs(crs.epsg) ? crs.epsg : null;
}

const crsLabel = (crs: { epsg: number } | { wkt: string }) =>
  'epsg' in crs ? `EPSG:${String(crs.epsg)}` : 'a WKT definition';

const knownDatum = (d: string | undefined): string | null =>
  d === undefined || d.trim() === '' || d.trim().toLowerCase() === 'unknown' ? null : d.trim();

/** Ratio of the point scale of projection `to` to that of `from` at a WGS84 lon, lat. */
function scaleRatio(lon: number, lat: number, from: number, to: number): number {
  const d = 1e-4;
  const len = (epsg: number, dl: number, dp: number) => {
    const a = fromWgs84([lon, lat, 0], epsg);
    const b = fromWgs84([lon + dl, lat + dp, 0], epsg);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };
  const east = len(to, d, 0) / len(from, d, 0);
  const north = len(to, 0, d) / len(from, 0, d);
  return (east + north) / 2;
}

/**
 * The layer transform that puts a georeferenced model in a project, or why it cannot be placed.
 * Same CRS: the record's matrix moved into the local frame. Another supported CRS: the anchor is
 * carried through WGS84 and the model turned about the vertical through it by the difference in
 * grid convergence; scale is kept and a projection scale difference is only noted. An unsupported
 * CRS on either side is never guessed. Heights pass through: an unknown datum stays unknown, and
 * two different known datums leave the height to the user (horizontal placement offered).
 */
export function georefToLayerTransform(g: Georef, project: ProjectGeo): PlacementResult {
  const to = metricEpsg(project.crs);
  if (to === null)
    return {
      kind: 'needed',
      reason: `The project's coordinate system (${crsLabel(project.crs)}) cannot be used for placement.`,
    };
  const from = metricEpsg(g.crs);
  if (from === null)
    return {
      kind: 'needed',
      reason: `The model's coordinate system (${crsLabel(g.crs)}) is not one this app can read.`,
    };
  if (!isAffine(g.modelToCrs) || !g.anchor.every((v) => Number.isFinite(v)))
    return { kind: 'needed', reason: "The model's placement matrix is not usable." };

  let m: Mat4 = [...g.modelToCrs];
  let headingDeltaDeg = 0;
  let scaleNote: string | undefined;
  if (from !== to) {
    const anchor: Vec3 = [g.anchor[0], g.anchor[1], g.anchor[2]];
    const moved = transformPoint(anchor, from, to);
    const [lon, lat] = toWgs84(anchor, from);
    headingDeltaDeg = gridConvergenceDeg(lon, lat, to) - gridConvergenceDeg(lon, lat, from);
    const c = Math.cos(headingDeltaDeg * RAD);
    const s = Math.sin(headingDeltaDeg * RAD);
    // counter-clockwise seen from above in E, N: E' = E c - N s, N' = E s + N c
    const turn: Mat4 = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    m = mul(
      translation(moved),
      mul(turn, mul(translation([-anchor[0], -anchor[1], -anchor[2]]), m)),
    );
    const k = scaleRatio(lon, lat, from, to);
    if (Math.abs(k - 1) > 1e-4)
      scaleNote = `The projection scale differs by a factor of ${k.toFixed(6)} between EPSG:${String(from)} and EPSG:${String(to)} here; the model keeps its own scale.`;
  }

  const transform = enhToLocal(m, project.origin);
  const modelDatum = g.vertical.status === 'unknown' ? null : knownDatum(g.vertical.datum);
  const projectDatum = knownDatum(project.verticalDatum);
  if (modelDatum !== null && projectDatum !== null) {
    if (modelDatum.toLowerCase() !== projectDatum.toLowerCase())
      return {
        kind: 'needed',
        reason: `Heights are in ${modelDatum} and the project uses ${projectDatum}: set the height with Place model.`,
        horizontalOnly: transform,
      };
  }
  const heightNote =
    modelDatum === null || projectDatum === null
      ? 'The vertical datum is unknown, so heights are taken as they are.'
      : undefined;
  return {
    kind: 'placed',
    transform,
    headingDeltaDeg,
    ...(scaleNote !== undefined ? { scaleNote } : {}),
    ...(heightNote !== undefined ? { heightNote } : {}),
  };
}

/** Grid heading in degrees, (-180, 180]: how far model north (-z) is turned clockwise from grid north. */
function headingOf(m: readonly number[]): number {
  // model +X lies 90 degrees clockwise of model north
  const bearingX = Math.atan2(at(m, 0, 0), at(m, 1, 0)) / RAD;
  let h = bearingX - 90;
  while (h <= -180) h += 360;
  while (h > 180) h -= 360;
  return h;
}

function scaleOf(m: readonly number[]): number {
  let s = 0;
  for (let c = 0; c < 3; c++) s += Math.hypot(at(m, 0, c), at(m, 1, c), at(m, 2, c));
  return s / 3;
}

/**
 * The record for a layer transform in a project: the inverse of `georefToLayerTransform` within
 * the project's CRS, for Place model (statuses `user`) and Accept of an engineering run (the
 * previous record's statuses kept). The anchor is the same model point as in `prev`, or the model
 * origin.
 */
export function layerTransformToGeoref(
  transform: Mat4,
  project: ProjectGeo,
  prev: Georef | null,
  by: 'place-model' | 'engineer',
): Georef {
  const modelToCrs = localToEnh(transform, project.origin);
  const modelAnchor: Vec3 = (prev
    ? solve(prev.modelToCrs, [prev.anchor[0], prev.anchor[1], prev.anchor[2]])
    : null) ?? [0, 0, 0];
  const anchor = apply(modelToCrs, modelAnchor);
  const deg = headingOf(modelToCrs);
  const factor = scaleOf(modelToCrs);
  const projectDatum = knownDatum(project.verticalDatum);
  const user = by === 'place-model';
  const vertical: Georef['vertical'] = user
    ? projectDatum !== null
      ? { datum: projectDatum, status: 'user' }
      : { datum: 'unknown', status: 'unknown' }
    : (prev?.vertical ??
      (projectDatum !== null
        ? { datum: projectDatum, status: 'from-source' }
        : { datum: 'unknown', status: 'unknown' }));
  const provenance: Georef['provenance'] = user
    ? { by: 'place-model' }
    : {
        by: 'engineer',
        ...(prev?.provenance.runId !== undefined ? { runId: prev.provenance.runId } : {}),
        ...(prev?.provenance.source !== undefined ? { source: prev.provenance.source } : {}),
      };
  return {
    schema: 'aio.georef/1',
    crs: 'epsg' in project.crs ? { epsg: project.crs.epsg } : { wkt: project.crs.wkt },
    anchor,
    axes: 'x-east,y-up,z-south',
    units: 'm',
    modelToCrs,
    heading: { deg, status: user ? 'user' : (prev?.heading.status ?? 'assumed-grid') },
    scale: { factor, status: user ? 'user' : (prev?.scale.status ?? 'provisional') },
    horizontal: user ? { status: 'user' } : (prev?.horizontal ?? { status: 'unplaced' }),
    vertical,
    provenance,
    ...(!user && prev?.deviation ? { deviation: prev.deviation } : {}),
  };
}

/** World E, N, H of a model point under a layer transform in a project (for checks and tests). */
export function worldOfModelPoint(transform: Mat4, project: ProjectGeo, p: Vec3): Vec3 {
  return localToProject(apply(transform, p), project.origin);
}
