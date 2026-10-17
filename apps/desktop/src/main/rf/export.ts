/*
 * Coverage exports (RF spec D19): a Float32 GeoTIFF of a grid, GeoJSON coverage polygons by
 * marching squares at each threshold, and a CSV of the area of each RSRP class per sector.
 *
 * No GeoTIFF library is a dependency of the app, so this file writes and reads the one layout it
 * needs: a classic little endian TIFF, one band, uncompressed, stripped, with the GeoTIFF tags for
 * a north up grid in an EPSG projected CRS and the GDAL nodata tag. The reader takes the same
 * layout (it also reads 8, 16 and 32 bit integers and 64 bit floats, which a composite grid such
 * as best server may use) and is how the composite grids of a run are loaded for the exports.
 */
import type { RfThresholds } from '@aio/schema';

/** The georeferencing of a run's grid (`RfRun.grid`). */
export interface GridGeo {
  crs: string;
  resolutionM: number;
  /** Top left corner of the grid in the project CRS. */
  origin: readonly [number, number];
  width: number;
  height: number;
  nodata: number;
}

// ---- GeoTIFF -------------------------------------------------------------------------------------

const T = {
  width: 256,
  height: 257,
  bits: 258,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  samples: 277,
  rowsPerStrip: 278,
  stripBytes: 279,
  sampleFormat: 339,
  pixelScale: 33550,
  tiepoint: 33922,
  geoKeys: 34735,
  nodata: 42113,
} as const;
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const ASCII = 2;
const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};
/** About this many bytes of pixels per strip. */
const STRIP_BYTES = 1 << 20;

/** The EPSG code of a CRS name such as `EPSG:32640`; null for anything else. */
export function epsgOf(crs: string): number | null {
  const m = /^(?:EPSG:|urn:ogc:def:crs:EPSG::?\d*:?)?(\d{4,6})$/i.exec(crs.trim());
  return m?.[1] ? Number(m[1]) : null;
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  data: Buffer;
}

const shorts = (v: readonly number[]): Buffer => {
  const b = Buffer.alloc(v.length * 2);
  v.forEach((x, i) => b.writeUInt16LE(x, i * 2));
  return b;
};
const longs = (v: readonly number[]): Buffer => {
  const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeUInt32LE(x, i * 4));
  return b;
};
const doubles = (v: readonly number[]): Buffer => {
  const b = Buffer.alloc(v.length * 8);
  v.forEach((x, i) => b.writeDoubleLE(x, i * 8));
  return b;
};

/** A Float32 GeoTIFF of `data` (row major, top row first) georeferenced by `geo`. */
export function writeGridTiff(data: Float32Array, geo: GridGeo): Buffer {
  const { width, height } = geo;
  if (data.length !== width * height)
    throw new Error(
      `The grid is ${String(width)} x ${String(height)}: expected ${String(width * height)} values, got ${String(data.length)}.`,
    );
  const epsg = epsgOf(geo.crs);
  if (epsg === null)
    throw new Error(
      `The grid's CRS "${geo.crs}" is not an EPSG code, so a GeoTIFF cannot name it.`,
    );

  const rowBytes = width * 4;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(STRIP_BYTES / rowBytes)));
  const strips = Math.ceil(height / rowsPerStrip);
  const stripLen = (s: number): number =>
    Math.min(rowsPerStrip, height - s * rowsPerStrip) * rowBytes;

  // GeoKeyDirectory: header, then ModelType = projected, RasterType = pixel is area, the CRS.
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg];
  const entries = (offsets: readonly number[]): Entry[] => [
    { tag: T.width, type: LONG, count: 1, data: longs([width]) },
    { tag: T.height, type: LONG, count: 1, data: longs([height]) },
    { tag: T.bits, type: SHORT, count: 1, data: shorts([32]) },
    { tag: T.compression, type: SHORT, count: 1, data: shorts([1]) },
    { tag: T.photometric, type: SHORT, count: 1, data: shorts([1]) },
    { tag: T.stripOffsets, type: LONG, count: strips, data: longs(offsets) },
    { tag: T.samples, type: SHORT, count: 1, data: shorts([1]) },
    { tag: T.rowsPerStrip, type: LONG, count: 1, data: longs([rowsPerStrip]) },
    {
      tag: T.stripBytes,
      type: LONG,
      count: strips,
      data: longs(Array.from({ length: strips }, (_, s) => stripLen(s))),
    },
    { tag: T.sampleFormat, type: SHORT, count: 1, data: shorts([3]) },
    {
      tag: T.pixelScale,
      type: DOUBLE,
      count: 3,
      data: doubles([geo.resolutionM, geo.resolutionM, 0]),
    },
    {
      tag: T.tiepoint,
      type: DOUBLE,
      count: 6,
      data: doubles([0, 0, 0, geo.origin[0], geo.origin[1], 0]),
    },
    { tag: T.geoKeys, type: SHORT, count: geoKeys.length, data: shorts(geoKeys) },
    {
      tag: T.nodata,
      type: ASCII,
      count: String(geo.nodata).length + 1,
      data: Buffer.from(`${String(geo.nodata)}\0`, 'latin1'),
    },
  ];

  // Layout: header (8), IFD, out of line values, then the pixels. The size of the first two does not
  // depend on the strip offsets, so a first pass with zero offsets measures them.
  const measure = entries(Array<number>(strips).fill(0));
  const ifdSize = 2 + measure.length * 12 + 4;
  let extra = 0;
  for (const e of measure) if (e.data.length > 4) extra += e.data.length + (e.data.length % 2);
  const pixelStart = 8 + ifdSize + extra;
  const offsets = Array.from(
    { length: strips },
    (_, s) => pixelStart + s * rowsPerStrip * rowBytes,
  );

  const out = Buffer.alloc(pixelStart + data.length * 4);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  const list = entries(offsets);
  out.writeUInt16LE(list.length, 8);
  let at = 8 + 2 + list.length * 12 + 4;
  list.forEach((e, i) => {
    const p = 10 + i * 12;
    out.writeUInt16LE(e.tag, p);
    out.writeUInt16LE(e.type, p + 2);
    out.writeUInt32LE(e.count, p + 4);
    if (e.data.length <= 4) e.data.copy(out, p + 8);
    else {
      out.writeUInt32LE(at, p + 8);
      e.data.copy(out, at);
      at += e.data.length + (e.data.length % 2);
    }
  });
  out.writeUInt32LE(0, 10 + list.length * 12);
  for (let i = 0; i < data.length; i++) out.writeFloatLE(data[i] ?? 0, pixelStart + i * 4);
  return out;
}

export interface GridTiff {
  width: number;
  height: number;
  data: Float32Array;
  /** The projected CRS code from the GeoKey directory, when there is one. */
  epsg: number | null;
  /** Top left corner, when the file has a tiepoint. */
  origin: [number, number] | null;
  pixelSize: [number, number] | null;
  nodata: number | null;
}

/** Read the single band of an uncompressed classic TIFF (see the file comment). */
export function readGridTiff(bytes: Buffer): GridTiff {
  if (bytes.length < 16) throw new Error('This is not a TIFF file.');
  const le = bytes.toString('latin1', 0, 2) === 'II';
  if (!le && bytes.toString('latin1', 0, 2) !== 'MM') throw new Error('This is not a TIFF file.');
  const u16 = (p: number): number => (le ? bytes.readUInt16LE(p) : bytes.readUInt16BE(p));
  const u32 = (p: number): number => (le ? bytes.readUInt32LE(p) : bytes.readUInt32BE(p));
  if (u16(2) !== 42) throw new Error('This is not a classic TIFF file (BigTIFF is not read).');
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = new Map<number, { type: number; count: number; at: number }>();
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const type = u16(p + 2);
    const count = u32(p + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    tags.set(u16(p), { type, count, at: size <= 4 ? p + 8 : u32(p + 8) });
  }
  const nums = (tag: number): number[] => {
    const t = tags.get(tag);
    if (!t) return [];
    const out: number[] = [];
    for (let i = 0; i < t.count; i++) {
      const size = TYPE_SIZE[t.type] ?? 1;
      const p = t.at + i * size;
      if (t.type === SHORT) out.push(u16(p));
      else if (t.type === LONG) out.push(u32(p));
      else if (t.type === DOUBLE) out.push(le ? bytes.readDoubleLE(p) : bytes.readDoubleBE(p));
    }
    return out;
  };
  const one = (tag: number, fallback?: number): number => {
    const v = nums(tag)[0] ?? fallback;
    if (v === undefined) throw new Error(`The TIFF has no tag ${String(tag)}.`);
    return v;
  };
  const width = one(T.width);
  const height = one(T.height);
  if (one(T.compression, 1) !== 1) throw new Error('Only uncompressed TIFF grids are read.');
  if (one(T.samples, 1) !== 1) throw new Error('Only single band TIFF grids are read.');
  const bits = one(T.bits, 1);
  const format = one(T.sampleFormat, 1);
  const offsets = nums(T.stripOffsets);
  const counts = nums(T.stripBytes);
  const rowsPerStrip = one(T.rowsPerStrip, height);
  const bytesPer = bits / 8;
  const data = new Float32Array(width * height);
  const sample = (p: number): number => {
    if (format === 3) {
      if (bits === 32) return le ? bytes.readFloatLE(p) : bytes.readFloatBE(p);
      if (bits === 64) return le ? bytes.readDoubleLE(p) : bytes.readDoubleBE(p);
    } else if (format === 2) {
      if (bits === 8) return bytes.readInt8(p);
      if (bits === 16) return le ? bytes.readInt16LE(p) : bytes.readInt16BE(p);
      if (bits === 32) return le ? bytes.readInt32LE(p) : bytes.readInt32BE(p);
    } else if (format === 1) {
      if (bits === 8) return bytes.readUInt8(p);
      if (bits === 16) return u16(p);
      if (bits === 32) return u32(p);
    }
    throw new Error(`A ${String(bits)} bit sample of format ${String(format)} is not read.`);
  };
  offsets.forEach((start, s) => {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    const len = Math.min(counts[s] ?? rows * width * bytesPer, rows * width * bytesPer);
    if (start + len > bytes.length) throw new Error('The TIFF is cut short.');
    const base = s * rowsPerStrip * width;
    for (let i = 0; i < len / bytesPer; i++) data[base + i] = sample(start + i * bytesPer);
  });

  const keys = nums(T.geoKeys);
  let epsg: number | null = null;
  for (let i = 4; i + 3 < keys.length; i += 4)
    if (keys[i] === 3072 && keys[i + 1] === 0) epsg = keys[i + 3] ?? null;
  const scale = nums(T.pixelScale);
  const tie = nums(T.tiepoint);
  const nd = tags.get(T.nodata);
  const ndText = nd ? bytes.toString('latin1', nd.at, nd.at + nd.count).replace(/\0+$/, '') : '';
  const ndValue = ndText === '' ? null : Number(ndText);
  return {
    width,
    height,
    data,
    epsg,
    origin: tie.length >= 6 ? [tie[3] ?? 0, tie[4] ?? 0] : null,
    pixelSize: scale.length >= 2 ? [scale[0] ?? 0, scale[1] ?? 0] : null,
    nodata: ndValue !== null && Number.isFinite(ndValue) ? ndValue : null,
  };
}

// ---- contours ------------------------------------------------------------------------------------

export type Ring = [number, number][];
/** A polygon: the shell first, then its holes. */
export type Polygon = Ring[];

const valid = (v: number, nodata: number): boolean => Number.isFinite(v) && v !== nodata;

/**
 * Closed polygons of the area where `data >= threshold`, by marching squares over the samples.
 * Coordinates are in the grid's CRS (a sample sits at its pixel centre). Shells run counter
 * clockwise and holes clockwise (RFC 7946); a hole belongs to the smallest shell that contains
 * it, and an island inside a hole is a polygon of its own. Nodata, NaN and the outside of the
 * grid are below every threshold; where a crossing has no valid neighbour to interpolate with it
 * sits half a pixel out, on the pixel edge.
 */
export function contourPolygons(data: Float32Array, geo: GridGeo, threshold: number): Polygon[] {
  const { width: W, height: H, resolutionM: res, nodata } = geo;
  const PW = W + 2; // padded sample columns: one ring of "outside" all round
  const at = (pi: number, pj: number): number => {
    const c = pi - 1;
    const r = pj - 1;
    return c < 0 || r < 0 || c >= W || r >= H ? Number.NaN : (data[r * W + c] ?? Number.NaN);
  };
  const ins = (pi: number, pj: number): boolean => {
    const v = at(pi, pj);
    return valid(v, nodata) && v >= threshold;
  };
  const px = (pi: number): number => geo.origin[0] + (pi - 1 + 0.5) * res;
  const py = (pj: number): number => geo.origin[1] - (pj - 1 + 0.5) * res;

  // Edge ids: the horizontal edge from sample (i, j) to (i + 1, j) is 2 (j PW + i), the vertical
  // one from (i, j) to (i, j + 1) is that plus one. Each crossing is found once and shared by the
  // two cells beside it, so rings close exactly.
  const points = new Map<number, [number, number]>();
  const cross = (id: number, ai: number, aj: number, bi: number, bj: number): number => {
    if (!points.has(id)) {
      const va = at(ai, aj);
      const vb = at(bi, bj);
      let t = 0.5;
      if (valid(va, nodata) && valid(vb, nodata) && va !== vb)
        t = Math.min(1, Math.max(0, (threshold - va) / (vb - va)));
      points.set(id, [px(ai) + (px(bi) - px(ai)) * t, py(aj) + (py(bj) - py(aj)) * t]);
    }
    return id;
  };
  const top = (i: number, j: number): number => cross(2 * (j * PW + i), i, j, i + 1, j);
  const bottom = (i: number, j: number): number =>
    cross(2 * ((j + 1) * PW + i), i, j + 1, i + 1, j + 1);
  const left = (i: number, j: number): number => cross(2 * (j * PW + i) + 1, i, j, i, j + 1);
  const right = (i: number, j: number): number =>
    cross(2 * (j * PW + i + 1) + 1, i + 1, j, i + 1, j + 1);

  // Each segment runs with the covered side on its left (y up); a crossing starts one segment.
  const next = new Map<number, number>();
  const seg = (from: number, to: number): void => {
    next.set(from, to);
  };
  for (let j = 0; j <= H; j++) {
    for (let i = 0; i <= W; i++) {
      const tl = ins(i, j);
      const tr = ins(i + 1, j);
      const br = ins(i + 1, j + 1);
      const bl = ins(i, j + 1);
      const code = (tl ? 1 : 0) | (tr ? 2 : 0) | (br ? 4 : 0) | (bl ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const centre = (): boolean => {
        const vs = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        return vs.every((v) => valid(v, nodata)) && vs.reduce((a, b) => a + b, 0) / 4 >= threshold;
      };
      switch (code) {
        case 1:
          seg(left(i, j), top(i, j));
          break;
        case 2:
          seg(top(i, j), right(i, j));
          break;
        case 4:
          seg(right(i, j), bottom(i, j));
          break;
        case 8:
          seg(bottom(i, j), left(i, j));
          break;
        case 3:
          seg(left(i, j), right(i, j));
          break;
        case 6:
          seg(top(i, j), bottom(i, j));
          break;
        case 12:
          seg(right(i, j), left(i, j));
          break;
        case 9:
          seg(bottom(i, j), top(i, j));
          break;
        case 7:
          seg(left(i, j), bottom(i, j));
          break;
        case 11:
          seg(bottom(i, j), right(i, j));
          break;
        case 13:
          seg(right(i, j), top(i, j));
          break;
        case 14:
          seg(top(i, j), left(i, j));
          break;
        case 5:
          if (centre()) {
            seg(right(i, j), top(i, j));
            seg(left(i, j), bottom(i, j));
          } else {
            seg(left(i, j), top(i, j));
            seg(right(i, j), bottom(i, j));
          }
          break;
        case 10:
          if (centre()) {
            seg(top(i, j), left(i, j));
            seg(bottom(i, j), right(i, j));
          } else {
            seg(top(i, j), right(i, j));
            seg(bottom(i, j), left(i, j));
          }
          break;
      }
    }
  }

  // Follow the segments into closed rings.
  const rings: Ring[] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring: Ring = [];
    let id: number | undefined = start;
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const p = points.get(id);
      if (p) ring.push([round(p[0]), round(p[1])]);
      id = next.get(id);
    }
    const first = ring[0];
    if (first && ring.length >= 3) {
      ring.push([first[0], first[1]]);
      rings.push(ring);
    }
  }

  const shells = rings.map((r) => ({ ring: r, area: signedArea(r) })).filter((r) => r.area > 0);
  const holes = rings.map((r) => ({ ring: r, area: signedArea(r) })).filter((r) => r.area < 0);
  const polygons = shells.map((s) => ({ ...s, holes: [] as Ring[] }));
  for (const h of holes) {
    const probe = h.ring[0];
    if (!probe) continue;
    let owner: (typeof polygons)[number] | undefined;
    for (const p of polygons)
      if (containsPoint(p.ring, probe) && (!owner || p.area < owner.area)) owner = p;
    owner?.holes.push(h.ring);
  }
  return polygons.map((p) => [p.ring, ...p.holes]);
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const p = ring[i];
    const q = ring[i + 1];
    if (p && q) a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function containsPoint(ring: Ring, pt: readonly [number, number]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (
      a[1] > pt[1] !== b[1] > pt[1] &&
      pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      c = !c;
  }
  return c;
}

// ---- GeoJSON and CSV -----------------------------------------------------------------------------

export const RSRP_CLASSES = ['poor', 'fair', 'good', 'excellent'] as const;
type CoverageClass = (typeof RSRP_CLASSES)[number];

export interface CoverageFeature {
  type: 'Feature';
  properties: { class: CoverageClass; thresholdDbm: number; areaM2: number };
  geometry: { type: 'MultiPolygon'; coordinates: Polygon[] };
}

export interface CoverageCollection {
  type: 'FeatureCollection';
  crs: { type: 'name'; properties: { name: string } };
  features: CoverageFeature[];
}

const floorOf = (t: RfThresholds, c: CoverageClass): number =>
  ({ poor: t.poorDbm, fair: t.fairDbm, good: t.goodDbm, excellent: t.excellentDbm })[c];

/**
 * One MultiPolygon per threshold that some pixel reaches, widest (poor) first: the area where
 * RSRP is at or above that class floor. Coordinates stay in the project CRS, named by a `crs`
 * member (not RFC 7946, but the GIS programs read it).
 */
export function coverageGeoJson(
  rsrp: Float32Array,
  geo: GridGeo,
  thresholds: RfThresholds,
): CoverageCollection {
  const epsg = epsgOf(geo.crs);
  const features: CoverageFeature[] = [];
  for (const c of RSRP_CLASSES) {
    const polys = contourPolygons(rsrp, geo, floorOf(thresholds, c));
    if (polys.length === 0) continue;
    const areaM2 = polys.reduce(
      (sum, p) => sum + p.reduce((a, ring) => a + signedArea(ring), 0),
      0,
    );
    features.push({
      type: 'Feature',
      properties: { class: c, thresholdDbm: floorOf(thresholds, c), areaM2: Math.round(areaM2) },
      geometry: { type: 'MultiPolygon', coordinates: polys },
    });
  }
  return {
    type: 'FeatureCollection',
    crs: {
      type: 'name',
      properties: { name: epsg === null ? geo.crs : `urn:ogc:def:crs:EPSG::${String(epsg)}` },
    },
    features,
  };
}

export interface ClassAreasInput {
  rsrp: Float32Array;
  /** Per pixel, the index of the best server in `sectors`; anything else (nodata, -1) is none. */
  bestServer: Float32Array;
  grid: GridGeo;
  thresholds: RfThresholds;
  sectors: readonly { id: string; name: string }[];
}

const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * Area in square metres of each RSRP class per best server sector, and in total. `none` is
 * covered by a server but below the poor floor; `covered` is the four classes together.
 */
export function classAreasCsv(i: ClassAreasInput): string {
  const px = i.grid.resolutionM * i.grid.resolutionM;
  const zero = (): number[] => [0, 0, 0, 0, 0];
  const rows = i.sectors.map(() => zero());
  const t = i.thresholds;
  for (let k = 0; k < i.rsrp.length; k++) {
    const v = i.rsrp[k] ?? Number.NaN;
    if (!valid(v, i.grid.nodata)) continue;
    const s = i.bestServer[k] ?? -1;
    const row = Number.isInteger(s) ? rows[s] : undefined;
    if (!row) continue;
    const c =
      v >= t.excellentDbm ? 0 : v >= t.goodDbm ? 1 : v >= t.fairDbm ? 2 : v >= t.poorDbm ? 3 : 4;
    row[c] = (row[c] ?? 0) + 1;
  }
  const line = (id: string, name: string, counts: readonly number[]): string => {
    const m2 = counts.map((n) => Math.round(n * px));
    const covered = m2.slice(0, 4).reduce((a, b) => a + b, 0);
    return [csvCell(id), csvCell(name), ...m2, covered].join(',');
  };
  const total = zero();
  for (const r of rows) r.forEach((n, c) => (total[c] = (total[c] ?? 0) + n));
  return (
    [
      'sector_id,sector_name,excellent_m2,good_m2,fair_m2,poor_m2,none_m2,covered_m2',
      ...i.sectors.map((s, n) => line(s.id, s.name, rows[n] ?? zero())),
      line('all', 'All sectors', total),
    ].join('\r\n') + '\r\n'
  );
}
