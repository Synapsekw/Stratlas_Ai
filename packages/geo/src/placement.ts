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
      /**
       * Scale of the CRS change at the pivot (1 within one CRS), always applied to horizontal
       * distances so the model keeps its ground size; kept apart from the record's own scale.
       */
      projectionScale: number;
      /**
       * Worst horizontal distance, metres, between the one linear map used and the exact CRS
       * change within `extentM` of the pivot (0 within one CRS).
       */
      linearErrorM: number;
      /** Set when the projection scale differs from 1 by more than 1e-4 (it is applied). */
      scaleNote?: string;
      /** Set when Web Mercator is involved: the placement is approximate away from the anchor. */
      approxNote?: string;
      /** Set when either vertical datum is unknown: heights are taken as they are. */
      heightNote?: string;
    }
  | {
      kind: 'needed';
      reason: string;
      /** Horizontal placement when only the height cannot be placed (H taken as is). */
      horizontalOnly?: Mat4;
    };

export interface PlacementOptions {
  /** How far the model reaches from its origin, metres, for `linearErrorM` (default 100). */
  extentM?: number;
}

const RAD = Math.PI / 180;
const WEB_MERCATOR = 3857;
const DEFAULT_EXTENT_M = 100;

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

/** A node of WKT text: its keyword, its quoted or bare values, and its child nodes. */
interface WktNode {
  key: string;
  values: string[];
  children: WktNode[];
}

/** WKT (1 or 2) read into nodes; null when it is not well formed. */
function parseWkt(text: string): WktNode | null {
  let i = 0;
  const s = text.trim();
  const space = () => {
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
  };
  const node = (): WktNode | null => {
    space();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!m) return null;
    const out: WktNode = { key: m[0].toUpperCase(), values: [], children: [] };
    i += m[0].length;
    space();
    const open = s.charAt(i);
    if (open !== '[' && open !== '(') return out;
    const close = open === '[' ? ']' : ')';
    i++;
    for (;;) {
      space();
      const c = s.charAt(i);
      if (c === '"') {
        // a quoted value; "" inside is one quote
        let v = '';
        i++;
        for (;;) {
          if (i >= s.length) return null;
          const q = s.charAt(i);
          if (q === '"' && s.charAt(i + 1) === '"') {
            v += '"';
            i += 2;
          } else if (q === '"') {
            i++;
            break;
          } else {
            v += q;
            i++;
          }
        }
        out.values.push(v);
      } else if (/[A-Za-z_]/.test(c)) {
        const save = i;
        const child = node();
        if (!child) return null;
        // a bare word without brackets is a value (east, Cartesian), not a node
        if (
          i > save &&
          child.values.length === 0 &&
          child.children.length === 0 &&
          !/[[(]/.test(s.slice(save, i))
        )
          out.values.push(child.key.toLowerCase());
        else out.children.push(child);
      } else {
        const n = /^[-+0-9.eE]+/.exec(s.slice(i));
        if (!n) return null;
        out.values.push(n[0]);
        i += n[0].length;
      }
      space();
      const sep = s.charAt(i);
      if (sep === ',') {
        i++;
        continue;
      }
      if (sep === close) {
        i++;
        return out;
      }
      return null;
    }
  };
  const root = node();
  space();
  return root && i === s.length ? root : null;
}

/** Nodes whose subtrees hold units of something other than the CRS's own axes. */
const NOT_AXIS_UNITS = new Set([
  'GEOGCS',
  'GEOCCS',
  'BASEGEOGCRS',
  'BASEGEODCRS',
  'BASEPROJCRS',
  'DATUM',
  'TRF',
  'ELLIPSOID',
  'SPHEROID',
  'PRIMEM',
  'PRIMEMERIDIAN',
  'PROJECTION',
  'CONVERSION',
  'METHOD',
  'PARAMETER',
  'TOWGS84',
  'ABRIDGEDTRANSFORMATION',
  'USAGE',
  'BBOX',
  'ID',
  'AUTHORITY',
]);
const GEOGRAPHIC = new Set(['GEOGCS', 'GEOGCRS', 'GEOGRAPHICCRS', 'GEODCRS', 'GEODETICCRS']);
const COMPOUND = new Set(['COMPD_CS', 'COMPOUNDCRS']);
const VERTICAL = new Set(['VERT_CS', 'VERTCRS', 'VERTICALCRS']);

/**
 * True when a WKT's horizontal axes are in metres: every unit of the CRS's own axes (a UNIT or
 * LENGTHUNIT on the CRS, on its CS or on an AXIS) is a metre. A geographic CRS is in degrees, and
 * a WKT that names no unit for its axes has units that are not known: neither is in metres. A
 * compound CRS answers for its horizontal part.
 */
function wktInMetres(text: string): boolean {
  const root = parseWkt(text);
  if (!root) return false;
  let crs: WktNode | undefined = root;
  if (COMPOUND.has(root.key)) crs = root.children.find((c) => !VERTICAL.has(c.key));
  if (!crs || GEOGRAPHIC.has(crs.key)) return false;
  const units: WktNode[] = [];
  const walk = (n: WktNode) => {
    for (const c of n.children) {
      if (NOT_AXIS_UNITS.has(c.key)) continue;
      if (c.key === 'UNIT' || c.key === 'LENGTHUNIT' || c.key === 'ANGLEUNIT') units.push(c);
      else walk(c);
    }
  };
  walk(crs);
  if (units.length === 0) return false;
  return units.every((u) => {
    if (u.key === 'ANGLEUNIT') return false;
    const name = (u.values[0] ?? '').trim().toLowerCase();
    const factor = Number(u.values[1]);
    return (name === 'metre' || name === 'meter' || name === 'm') && factor === 1;
  });
}

/**
 * One CRS on both sides that needs no registry: the same EPSG code, or WKT text that is identical.
 * Placement copies the record's matrix as it is, so the CRS must be in metres: a code the registry
 * knows is (4326, in degrees, is not a placement frame), a WKT says so in its units, and a code
 * the registry does not know has units that are not known. Null when the two differ.
 */
function sameCrs(
  a: { epsg: number } | { wkt: string },
  b: { epsg: number } | { wkt: string },
): { metres: true } | { metres: false; reason: string } | null {
  if ('epsg' in a && 'epsg' in b) {
    if (a.epsg !== b.epsg) return null;
    if (metricEpsg(a) !== null) return { metres: true };
    const label = crsLabel(a);
    return {
      metres: false,
      reason:
        a.epsg === 4326
          ? `${label} is in degrees, not in metres: place the model with Place model.`
          : `${label} is not one this app can read, so its units are not known: place the model with Place model.`,
    };
  }
  if ('wkt' in a && 'wkt' in b) {
    if (a.wkt.trim() === '' || a.wkt !== b.wkt) return null;
    return wktInMetres(a.wkt)
      ? { metres: true }
      : {
          metres: false,
          reason:
            'The coordinate system is not in metres (or its units are not known): place the model with Place model.',
        };
  }
  return null;
}

const crsLabel = (crs: { epsg: number } | { wkt: string }) =>
  'epsg' in crs ? `EPSG:${String(crs.epsg)}` : 'a WKT definition';

const knownDatum = (d: string | undefined): string | null =>
  d === undefined || d.trim() === '' || d.trim().toLowerCase() === 'unknown' ? null : d.trim();

/**
 * The layer transform that puts a georeferenced model in a project, or why it cannot be placed.
 * Same CRS (one EPSG code the registry knows, or identical WKT in metres, even one the registry
 * does not read): the record's matrix moved into the local frame; one in feet, in degrees or in
 * units that are not known is never placed. Another supported CRS: the model
 * origin's image (the pivot) is carried through WGS84 and the horizontal Jacobian of the CRS change
 * there is applied about it, always: the convergence turn, the projection scale difference
 * (`projectionScale`) and, for EPSG:3857, its east/north difference. The record's own scale is
 * never changed. One linear map is exact at the pivot and strays with distance: between UTM zones
 * by well under 1 mm at 100 m; Web Mercator is approximate (about 3 mm at 100 m at mid latitudes),
 * so `linearErrorM` gives the worst case within `extentM` and `approxNote` says so. An unsupported
 * CRS on either side is never guessed. Heights pass through: an unknown datum stays unknown, and
 * two different known datums leave the height to the user (horizontal placement offered).
 */
export function georefToLayerTransform(
  g: Georef,
  project: ProjectGeo,
  o: PlacementOptions = {},
): PlacementResult {
  // within one CRS no registry is needed: the record's matrix moves into the local frame as it is
  const pair = sameCrs(g.crs, project.crs);
  if (pair && !pair.metres) return { kind: 'needed', reason: pair.reason };
  const same = pair !== null;
  const to = same ? null : metricEpsg(project.crs);
  if (!same && to === null)
    return {
      kind: 'needed',
      reason: `The project's coordinate system (${crsLabel(project.crs)}) cannot be used for placement.`,
    };
  const from = same ? null : metricEpsg(g.crs);
  if (!same && from === null)
    return {
      kind: 'needed',
      reason: `The model's coordinate system (${crsLabel(g.crs)}) is not one this app can read.`,
    };
  if (!isAffine(g.modelToCrs) || !g.anchor.every((v) => Number.isFinite(v)))
    return { kind: 'needed', reason: "The model's placement matrix is not usable." };

  let m: Mat4 = [...g.modelToCrs];
  let headingDeltaDeg = 0;
  let projectionScale = 1;
  let linearErrorM = 0;
  let scaleNote: string | undefined;
  let approxNote: string | undefined;
  const extentM = o.extentM ?? DEFAULT_EXTENT_M;
  if (from !== null && to !== null && from !== to) {
    // The pivot is the model origin's image (where the vertices are), not the anchor field.
    const pivot = apply(m, [0, 0, 0]);
    const moved = transformPoint(pivot, from, to);
    const [lon, lat] = toWgs84(pivot, from);
    headingDeltaDeg = gridConvergenceDeg(lon, lat, to) - gridConvergenceDeg(lon, lat, from);
    // The horizontal part of the CRS change at the pivot, always applied: the convergence turn,
    // the projections' scale difference and the east/north difference of a projection that is
    // not conformal (EPSG:3857) together. Heights never scale with a projection.
    const j = crsJacobian(pivot, from, to);
    projectionScale = Math.sqrt(Math.abs(j.ee * j.nn - j.en * j.ne));
    if (Math.abs(projectionScale - 1) > 1e-4)
      scaleNote = `The two map projections differ in scale by a factor of ${projectionScale.toFixed(6)} here; the model was scaled across by it so it keeps its size on the ground.`;
    const across: Mat4 = [j.ee, j.ne, 0, 0, j.en, j.nn, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    m = mul(translation(moved), mul(across, translation([-pivot[0], -pivot[1], -pivot[2]])));
    m = mul(m, [...g.modelToCrs]);
    linearErrorM = linearError(pivot, moved, j, from, to, extentM);
    if (from === WEB_MERCATOR || to === WEB_MERCATOR)
      approxNote = `Web Mercator placement is approximate away from the anchor: up to ${(linearErrorM * 1000).toFixed(1)} mm within ${String(extentM)} m of it.`;
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
    projectionScale,
    linearErrorM,
    ...(scaleNote !== undefined ? { scaleNote } : {}),
    ...(approxNote !== undefined ? { approxNote } : {}),
    ...(heightNote !== undefined ? { heightNote } : {}),
  };
}

/**
 * The horizontal Jacobian of the change from one CRS to another at `p` (central differences of
 * 10 m in the source grid): d(E', N') / d(E, N).
 */
function crsJacobian(
  p: Vec3,
  from: number,
  to: number,
): { ee: number; ne: number; en: number; nn: number } {
  const step = 10;
  const d = (de: number, dn: number): [number, number] => {
    const a = transformPoint([p[0] + de, p[1] + dn, 0], from, to);
    const b = transformPoint([p[0] - de, p[1] - dn, 0], from, to);
    return [(a[0] - b[0]) / (2 * step), (a[1] - b[1]) / (2 * step)];
  };
  const [ee, ne] = d(step, 0);
  const [en, nn] = d(0, step);
  return { ee, ne, en, nn };
}

/**
 * How far the one linear map strays from the exact CRS change within `radiusM` of the pivot
 * (horizontal metres, the worst of 16 directions on that circle, where the error is largest).
 */
function linearError(
  pivot: Vec3,
  moved: Vec3,
  j: { ee: number; ne: number; en: number; nn: number },
  from: number,
  to: number,
  radiusM: number,
): number {
  let worst = 0;
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * 2 * Math.PI;
    const de = radiusM * Math.cos(t);
    const dn = radiusM * Math.sin(t);
    const exact = transformPoint([pivot[0] + de, pivot[1] + dn, 0], from, to);
    const e = moved[0] + j.ee * de + j.en * dn;
    const n = moved[1] + j.ne * de + j.nn * dn;
    worst = Math.max(worst, Math.hypot(exact[0] - e, exact[1] - n));
  }
  return worst;
}

/**
 * The scale of the change from one CRS to another at `p` (1 within one CRS): how much longer a
 * short horizontal distance is in `to` grid units than in `from` grid units.
 */
export function projectionScaleBetween(p: Vec3, from: number, to: number): number {
  if (from === to) return 1;
  const j = crsJacobian(p, from, to);
  return Math.sqrt(Math.abs(j.ee * j.nn - j.en * j.ne));
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

/** The mean length of a matrix's three axis columns. */
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
  // The record's scale is the model's own. A layer placed from a record (in another CRS, or from
  // a record that was itself saved after such a placement) can carry a projection scale in its
  // matrix, so the scale is carried over from `prev` and changed only by how much the layer was
  // scaled since `prev` placed it here: saving again never drifts.
  const factor = (() => {
    const own = scaleOf(modelToCrs);
    if (!prev) return own;
    const placed = georefToLayerTransform(prev, project);
    const before = placed.kind === 'placed' ? placed.transform : (placed.horizontalOnly ?? null);
    if (!before) return own;
    const was = scaleOf(localToEnh(before, project.origin));
    return was > 0 ? (prev.scale.factor * own) / was : own;
  })();
  const projectDatum = knownDatum(project.verticalDatum);
  const user = by === 'place-model';
  // Place model sets the height in the project frame: the project's datum when it names one, else
  // the model's own known datum (now set by the person), else unknown
  const prevDatum =
    prev && prev.vertical.status !== 'unknown' ? knownDatum(prev.vertical.datum) : null;
  const vertical: Georef['vertical'] = user
    ? projectDatum !== null
      ? { datum: projectDatum, status: 'user' }
      : prevDatum !== null
        ? { datum: prevDatum, status: 'user' }
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
