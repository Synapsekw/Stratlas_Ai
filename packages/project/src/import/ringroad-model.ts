import { z } from 'zod';
import {
  Issue,
  type ClassCatalogue,
  type SeverityModel,
  type Sighting,
  type Vec3,
} from '@aio/schema';

// Source formats (the 1st Ring Road review, data/defects.js and data/grid.js) ----------------------

const LonLat = z.tuple([z.number(), z.number()]);

/** `window.RR_DATA`: defect records as rows under a field list, the centreline and its chainage. */
export const RrData = z.object({
  fields: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  centerline: z.array(LonLat),
  chainage: z.array(z.number()),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type RrData = z.infer<typeof RrData>;

const Defect = z.object({
  id: z.number().int().nonnegative(),
  type: z.string(),
  stage: z.number().int(),
  area: z.number(),
  clusterArea: z.number(),
  pct: z.number(),
  km: z.number(),
  c: LonLat,
  g: z.array(LonLat).min(4),
  path: z.string(),
  cropWH: z.tuple([z.number(), z.number()]),
  len: z.number(),
  utm: z.tuple([z.number(), z.number()]),
});
export type RrDefect = z.infer<typeof Defect>;

const PciTriple = z.tuple([z.number(), z.number(), z.number()]);
const Cell = z.tuple([z.number().int(), z.number().int()]);

/** `window.RR_GRID`: density grids and ASTM D6433 sample units on a UTM-aligned grid. */
export const RrGrid = z.object({
  origin: z.tuple([z.number(), z.number()]),
  density: z.record(z.string(), z.array(z.array(z.number()))),
  pci: z.object({
    unit_m: z.number().positive(),
    min_pavement_m2: z.number().optional(),
    coverage_pct: z.number(),
    road: PciTriple,
    sections: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])),
    units: z.array(
      z.tuple([
        z.number().int(),
        z.number().int(),
        z.number(),
        PciTriple,
        z.number(),
        z.array(z.tuple([z.string(), z.number(), z.number()])),
        z.array(Cell),
      ]),
    ),
  }),
});
export type RrGrid = z.infer<typeof RrGrid>;

/** `_build/crops.json`: UTM box (E0, N0, E1, N1) of each close-up, by FID. */
export const RrCrops = z.array(
  z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]),
);

/** Defect records by the field list of `RR_DATA`. */
export function readDefects(d: RrData): RrDefect[] {
  return d.rows.map((row) => {
    const o: Record<string, unknown> = {};
    d.fields.forEach((f, i) => (o[f] = row[i]));
    return Defect.parse(o);
  });
}

// Severity model and classes -----------------------------------------------------------------------

export const STAGE_LABEL: Record<number, string> = { 1: 'Few', 2: 'Intermediate', 3: 'Extensive' };

/**
 * The delivered "stage" (Few, Intermediate, Extensive) graded on the ASTM D6433 severity scale
 * (Low, Medium, High). A 2D ortho cannot measure crack width or depth, so this is a screening grade.
 */
export const ROAD_SEVERITY_MODEL: SeverityModel = {
  id: 'road-astm-d6433',
  name: 'Road distress (ASTM D6433)',
  levels: [
    {
      value: 1,
      label: 'Low',
      color: '#fad34b',
      criteria:
        'Delivered stage Few. Low severity per ASTM D6433 (screening grade from the ortho, crack width and depth not measured).',
      action: 'Monitor',
    },
    {
      value: 2,
      label: 'Medium',
      color: '#ff7a2d',
      criteria:
        'Delivered stage Intermediate. Medium severity per ASTM D6433 (screening grade from the ortho).',
      action: 'Plan maintenance',
    },
    {
      value: 3,
      label: 'High',
      color: '#ee3f4b',
      criteria:
        'Delivered stage Extensive. High severity per ASTM D6433 (screening grade from the ortho).',
      action: 'Plan repair',
    },
  ],
};

export function severityOfStage(stage: number): 1 | 2 | 3 {
  if (stage === 1 || stage === 2 || stage === 3) return stage;
  throw new Error(`Unknown defect stage ${stage} (expected 1 Few, 2 Intermediate, 3 Extensive)`);
}

/** Delivered type, class id, label and the review viewer's colour. */
const TYPES: readonly [string, string, string, string][] = [
  ['Longitudinal Cracking', 'longitudinal-cracking', 'Longitudinal cracking', '#3fa9f5'],
  ['Transverse Cracking', 'transverse-cracking', 'Transverse cracking', '#b68ef8'],
  ['Bleeding', 'bleeding', 'Bleeding', '#ff7a2d'],
  ['Raveling', 'raveling', 'Raveling', '#2ec4b6'],
  ['Block Cracking', 'block-cracking', 'Block cracking', '#fad34b'],
  ['Alligator Cracker', 'alligator-cracking', 'Alligator cracking', '#ee3f4b'],
  ['Patching', 'patching', 'Patching', '#9be15d'],
  ['Potholes', 'potholes', 'Potholes', '#ff4fa3'],
  ['Rutting', 'rutting', 'Rutting', '#ffffff'],
  ['Edge Cracking', 'edge-cracking', 'Edge cracking', '#c9a36b'],
];

export const ROAD_CATALOGUE: ClassCatalogue = {
  id: 'road-distress',
  name: 'Asphalt road distress',
  assetType: 'road',
  classes: TYPES.map(([, id, label, color]) => ({
    id,
    label,
    color,
    severityModel: ROAD_SEVERITY_MODEL.id,
  })),
};

export function classIdOf(type: string): string {
  const t = TYPES.find((x) => x[0] === type);
  if (!t) throw new Error(`Unknown defect type "${type}"`);
  return t[1];
}

const classLabel = (type: string) => TYPES.find((x) => x[0] === type)?.[2] ?? type;

export const defectCode = (fid: number) => `D${String(fid).padStart(4, '0')}`;
export const photoIdOf = (fid: number) => `f${String(fid).padStart(4, '0')}`;

// Close-up outlines --------------------------------------------------------------------------------

/** Rings of an SVG path made of `M x,y x,y ... Z` subpaths. */
export function svgPathRings(path: string): [number, number][][] {
  return path
    .split(/M/i)
    .map((s) => s.replace(/Z/gi, '').trim())
    .filter(Boolean)
    .map((s) =>
      s
        .split(/\s+/)
        .map((p) => p.split(',').map(Number))
        .filter((p): p is [number, number] => p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => [x, y] as [number, number]),
    );
}

const ringArea = (r: readonly [number, number][]) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    if (p && q) a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
};

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The close-up outline in image pixels: the viewer draws `path` in a 0..1000 view box stretched
 * over the image, so x scales by width / 1000 and y by height / 1000. The largest ring is kept.
 */
export function pathToImagePolygon(
  path: string,
  width: number,
  height: number,
): [number, number][] {
  const rings = svgPathRings(path);
  let best = rings[0] ?? [];
  for (const r of rings) if (ringArea(r) > ringArea(best)) best = r;
  const pts = best.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && first && first[0] === last?.[0] && first[1] === last[1]) pts.pop();
  return pts.map(([x, y]) => [r2((x / 1000) * width), r2((y / 1000) * height)]);
}

/** Georeferencing of one source GeoTIFF block (pixel-is-area tie point at the top-left corner). */
export interface OrthoBlock {
  name: string;
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  w: number;
  h: number;
}

/**
 * The ground window a close-up image really shows. `_build/closeups.py` reads the overview level
 * `L = floor(log2(side / 0.0126 / 1200))` (at least 0) and the source pixels from
 * `int((X0 - ox) / rx)` to `ceil((X1 - ox) / rx)` (rows likewise), then stretches that window over
 * the image: up to one source pixel more than the crop box on each side. Blocks are drawn in order,
 * so the last block covering the box centre is the one on top.
 */
export function closeupFrame(
  box: readonly [number, number, number, number],
  blocks: readonly OrthoBlock[],
): { block: string; level: number; left: number; right: number; top: number; bottom: number } {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const covering = blocks.filter(
    (b) => cx >= b.ox && cx <= b.ox + b.w * b.sx && cy <= b.oy && cy >= b.oy - b.h * b.sy,
  );
  const b = covering[covering.length - 1] ?? blocks[blocks.length - 1];
  if (!b) throw new Error('No ortho blocks');
  const side = Math.max(x1 - x0, y1 - y0);
  const level = Math.max(0, Math.floor(Math.log2(Math.max(side / 0.0126 / 1200, 1))));
  const rx = b.sx * 2 ** level;
  const ry = b.sy * 2 ** level;
  const c0 = Math.trunc((x0 - b.ox) / rx);
  const c1 = Math.ceil((x1 - b.ox) / rx);
  const r0 = Math.trunc((b.oy - y1) / ry);
  const r1 = Math.ceil((b.oy - y0) / ry);
  return {
    block: b.name,
    level,
    left: b.ox + c0 * rx,
    right: b.ox + c1 * rx,
    top: b.oy - r0 * ry,
    bottom: b.oy - r1 * ry,
  };
}

// PCI sample units ---------------------------------------------------------------------------------

export interface PciUnit {
  id: string;
  pavementM2: number;
  pci: [number, number, number];
  km: number;
  deducts: [string, number, number][];
  cells: [number, number][];
}

/** Cell (i down from the grid origin, j east) to unit; `at(E, N)` finds the unit of a position. */
export function buildPciIndex(g: RrGrid): {
  units: PciUnit[];
  at: (e: number, n: number) => PciUnit | null;
} {
  const c = g.pci.unit_m;
  const [ox, oy] = g.origin;
  const byCell = new Map<string, PciUnit>();
  const units = g.pci.units.map(([i, j, pav, pci, km, det, cells]) => {
    const u: PciUnit = { id: `u${i}-${j}`, pavementM2: pav, pci, km, deducts: det, cells };
    for (const [ci, cj] of cells) byCell.set(`${ci},${cj}`, u);
    return u;
  });
  return {
    units,
    at: (e, n) => byCell.get(`${Math.floor((oy - n) / c)},${Math.floor((e - ox) / c)}`) ?? null,
  };
}

interface Feature<G> {
  type: 'Feature';
  geometry: G;
  properties: Record<string, unknown>;
}
interface FeatureCollection<G> {
  type: 'FeatureCollection';
  features: Feature<G>[];
}
interface MultiPolygon {
  type: 'MultiPolygon';
  coordinates: [number, number][][][];
}

const r7 = (v: number) => Math.round(v * 1e7) / 1e7;

/** PCI units as GeoJSON (lon/lat): one MultiPolygon of 15 m cells per unit, PCI per severity. */
export function pciUnitsGeojson(
  g: RrGrid,
  toLonLat: (e: number, n: number) => [number, number],
): FeatureCollection<MultiPolygon> {
  const c = g.pci.unit_m;
  const [ox, oy] = g.origin;
  const ll = (e: number, n: number): [number, number] => {
    const [lon, lat] = toLonLat(e, n);
    return [r7(lon), r7(lat)];
  };
  return {
    type: 'FeatureCollection',
    features: buildPciIndex(g).units.map((u) => ({
      type: 'Feature',
      geometry: {
        type: 'MultiPolygon',
        coordinates: u.cells.map(([i, j]) => {
          const e0 = ox + j * c;
          const n0 = oy - i * c;
          return [[ll(e0, n0), ll(e0 + c, n0), ll(e0 + c, n0 - c), ll(e0, n0 - c), ll(e0, n0)]];
        }),
      },
      properties: {
        id: u.id,
        pavementM2: u.pavementM2,
        km: u.km,
        pciLow: u.pci[0],
        pciMedium: u.pci[1],
        pciHigh: u.pci[2],
      },
    })),
  };
}

// Issues -------------------------------------------------------------------------------------------

export interface RoadIssueContext {
  mapLayer: string;
  photosLayer: string;
  /** Pixel size of a close-up by photo id, or null when it is not in the layer. */
  photoSize(id: string): { width: number; height: number } | null;
  pciUnitAt(e: number, n: number): PciUnit | null;
  createdAt: string;
  author: string;
}

const fmt = (v: number, d: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** One delivered defect polygon as an issue: map polygon (lon/lat) plus the close-up outline. */
export function buildRoadIssue(d: RrDefect, ctx: RoadIssueContext): Issue {
  const sightings: Sighting[] = [
    {
      on: 'map',
      layer: ctx.mapLayer,
      geojson: { type: 'Polygon', coordinates: [d.g] },
    },
  ];
  const photo = photoIdOf(d.id);
  const size = ctx.photoSize(photo);
  if (size) {
    const points = pathToImagePolygon(d.path, size.width, size.height);
    if (points.length >= 3) {
      sightings.push({
        on: 'image',
        layer: ctx.photosLayer,
        photo,
        geom: { type: 'polygon', points },
      });
    }
  }
  const sev = severityOfStage(d.stage);
  const sevLabel = ROAD_SEVERITY_MODEL.levels.find((l) => l.value === sev)?.label ?? '';
  const unit = ctx.pciUnitAt(d.utm[0], d.utm[1]);
  const pci = unit
    ? `PCI sample unit ${unit.id} (${fmt(unit.pavementM2, 0)} m² of pavement, km ${unit.km.toFixed(3)}): PCI ${fmt(unit.pci[0], 0)} Low, ${fmt(unit.pci[1], 0)} Medium, ${fmt(unit.pci[2], 0)} High severity assumption.`
    : 'The centroid lies outside the PCI sample units.';
  const note = [
    `Stage as delivered: ${STAGE_LABEL[d.stage] ?? d.stage} (graded ${sevLabel}).`,
    `Mapped area ${fmt(d.area, 2)} m², extent ${fmt(d.len, 1)} m, ${fmt(d.pct, 2)}% of a ${fmt(d.clusterArea, 1)} m² cluster.`,
    pci,
    `UTM 38N ${fmt(d.utm[0], 1)} E, ${fmt(d.utm[1], 1)} N. FID ${d.id} in the delivered shapefile and Excel.`,
  ].join(' ');
  return Issue.parse({
    id: `rr-${String(d.id).padStart(4, '0')}`,
    code: defectCode(d.id),
    classId: classIdOf(d.type),
    severityModelId: ROAD_SEVERITY_MODEL.id,
    severity: sev,
    status: 'reviewed',
    title: `${classLabel(d.type)} at km ${d.km.toFixed(3)}`,
    note,
    author: ctx.author,
    createdAt: ctx.createdAt,
    updatedAt: ctx.createdAt,
    sightings,
    measurements: [
      { kind: 'area', value: d.area, unit: 'm2' },
      { kind: 'distance', value: d.len, unit: 'm' },
    ],
    source: 'import',
  });
}

// road.json ----------------------------------------------------------------------------------------

export const ROAD_SCHEMA = 'aio.road/1';

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const triple = ([low, medium, high]: readonly [number, number, number]) => ({ low, medium, high });

export interface RoadDocOptions {
  origin: Vec3;
  toProject: (lon: number, lat: number) => [number, number];
  overlays: { centreline: string; pciUnits: string };
}

/**
 * The road model for a native road panel: centreline (local frame) with chainage, PCI sample
 * units on their UTM-aligned grid (cell (i, j) spans x `origin.x + j c` to `+ c`, z `origin.z +
 * i c` to `+ c`), sections, network PCI, density grids, and the GeoJSON overlays.
 */
export function buildRoadDoc(d: RrData, g: RrGrid, o: RoadDocOptions) {
  const local = (e: number, n: number): Vec3 => [r3(e - o.origin[0]), 0, r3(0 - (n - o.origin[1]))];
  const sizes: Record<
    string,
    {
      i: number;
      j: number;
      pavementM2: number;
      defects: number;
      defectM2: number;
      coverPct: number;
    }[]
  > = {};
  for (const [size, cells] of Object.entries(g.density)) {
    sizes[size] = cells.map(([i = 0, j = 0, pav = 0, n = 0, area = 0, pct = 0]) => ({
      i,
      j,
      pavementM2: pav,
      defects: n,
      defectM2: area,
      coverPct: pct,
    }));
  }
  return {
    schema: ROAD_SCHEMA,
    name: typeof d.meta.road === 'string' ? d.meta.road : 'Road',
    centreline: {
      points: d.centerline.map(([lon, lat]) => local(...o.toProject(lon, lat))),
      chainageKm: d.chainage,
      lengthKm: d.chainage[d.chainage.length - 1] ?? 0,
    },
    pci: {
      standard: 'ASTM D6433',
      severities: ['Low', 'Medium', 'High'],
      headline: 'medium',
      network: triple(g.pci.road),
      coveragePct: g.pci.coverage_pct,
      ratings: [
        { min: 86, label: 'Good', color: '#1f9d55' },
        { min: 71, label: 'Satisfactory', color: '#8bc34a' },
        { min: 56, label: 'Fair', color: '#f2c94c' },
        { min: 41, label: 'Poor', color: '#f2994a' },
        { min: 26, label: 'Very Poor', color: '#eb5757' },
        { min: 11, label: 'Serious', color: '#b0232a' },
        { min: 0, label: 'Failed', color: '#6d6d6d' },
      ],
      grid: { cellM: g.pci.unit_m, origin: local(g.origin[0], g.origin[1]) },
      sections: g.pci.sections.map(([fromKm, pav, lo, me, hi]) => ({
        fromKm,
        toKm: r3(fromKm + 0.25),
        pavementM2: pav,
        pci: { low: lo, medium: me, high: hi },
      })),
      units: buildPciIndex(g).units.map((u) => ({
        id: u.id,
        pavementM2: u.pavementM2,
        pci: triple(u.pci),
        km: u.km,
        deducts: u.deducts.map(([distress, densityPct, deduct]) => ({
          distress,
          densityPct,
          deduct,
        })),
        cells: u.cells,
      })),
    },
    density: { gridOrigin: local(g.origin[0], g.origin[1]), sizes },
    overlays: o.overlays,
  };
}
