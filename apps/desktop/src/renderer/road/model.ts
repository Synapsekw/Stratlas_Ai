import type { Issue, PciRating, ProjectManifest, RoadModel, Vec3 } from '@aio/schema';

/**
 * Pure road-survey logic for the road workspace: chainage along the centreline, PCI ratings,
 * density classes and the defect list (rows, filters, sorting, chainage bins).
 */

/** A road survey: the original road review or a road class catalogue (data-conventions 8). */
export function isRoadProject(manifest: ProjectManifest): boolean {
  return (
    manifest.layers.some((l) => l.kind === 'legacy' && l.viewer === 'road') ||
    manifest.classCatalogues.some((c) => c.assetType === 'road')
  );
}

export interface Chainage {
  km: number;
  /** Distance from the centreline, metres. */
  offsetM: number;
}

/** Chainage of the nearest point on the centreline to local (x, z). */
export function chainageAt(road: RoadModel, x: number, z: number): Chainage {
  const pts = road.centreline.points;
  const km = road.centreline.chainageKm;
  let best: Chainage = { km: km[0] ?? 0, offsetM: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / len2)) : 0;
    const px = a[0] + dx * t;
    const pz = a[2] + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.offsetM) {
      const k0 = km[i - 1] ?? 0;
      const k1 = km[i] ?? k0;
      best = { km: k0 + (k1 - k0) * t, offsetM: d };
    }
  }
  return best;
}

/** The centreline point (local frame) at a chainage, clamped to the road. */
export function pointAtKm(road: RoadModel, at: number): Vec3 {
  const pts = road.centreline.points;
  const km = road.centreline.chainageKm;
  const first = pts[0] ?? [0, 0, 0];
  if (at <= (km[0] ?? 0)) return [...first];
  for (let i = 1; i < pts.length; i++) {
    const k0 = km[i - 1] ?? 0;
    const k1 = km[i] ?? k0;
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b || at > k1) continue;
    const t = k1 > k0 ? (at - k0) / (k1 - k0) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  return [...(pts[pts.length - 1] ?? first)];
}

/** The rating class of a PCI value (ratings ordered by `min`, any order). */
export function pciRating(ratings: readonly PciRating[], value: number | null): PciRating | null {
  if (value === null || !Number.isFinite(value)) return null;
  const v = Math.round(value);
  return [...ratings].sort((a, b) => b.min - a.min).find((r) => v >= r.min) ?? null;
}

// ---- density ----

export type DensityMeasure = 'count' | 'pct';
export const DENSITY_PALETTE = ['#27496d', '#2f8f9d', '#f2c94c', '#f2994a', '#e8384f'] as const;
export const DENSITY_ZERO = '#8a97ad';

/**
 * Class breaks: counts at 1 and the 40, 65, 85 and 96 % quantiles of the non-zero cells (kept
 * strictly increasing); share of pavement at fixed 0.5, 2, 5, 10 and 20 %.
 */
export function densityBreaks(values: readonly number[], measure: DensityMeasure): number[] {
  if (measure === 'pct') return [0.5, 2, 5, 10, 20];
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => nz[Math.floor(p * (nz.length - 1))] ?? 1;
  const out: number[] = [];
  for (const b of [1, q(0.4), q(0.65), q(0.85), q(0.96)])
    if (!out.length || b > (out[out.length - 1] ?? 0)) out.push(b);
  return out;
}

/** Colour of a value; null below the first break (an empty cell). The top break is the hottest. */
export function densityColor(value: number, breaks: readonly number[]): string | null {
  let k = -1;
  for (let i = 0; i < breaks.length; i++) if (value >= (breaks[i] ?? Infinity)) k = i;
  if (k < 0) return null;
  return DENSITY_PALETTE[k + (DENSITY_PALETTE.length - breaks.length)] ?? null;
}

/** Local ring (tl, tr, br, bl) of grid cell (i, j). */
export function gridCellRing(origin: Vec3, size: number, i: number, j: number): Vec3[] {
  const x0 = origin[0] + j * size;
  const z0 = origin[2] + i * size;
  return [
    [x0, 0, z0],
    [x0 + size, 0, z0],
    [x0 + size, 0, z0 + size],
    [x0, 0, z0 + size],
  ];
}

// ---- defects ----

export interface DefectRow {
  id: string;
  code: string;
  title: string;
  classId: string;
  classLabel: string;
  classColor: string;
  severity: number;
  severityLabel: string;
  severityColor: string;
  km: number;
  offsetM: number;
  /** Local ground position of the defect centroid (x east, z south). */
  at: [number, number];
  areaM2: number | null;
  extentM: number | null;
  /** The close-up photo with this defect's outline, if any. */
  photo: { layer: string; photo: string } | null;
  /** Lower-case text the search box matches. */
  haystack: string;
}

function mapCentroid(issue: Issue): [number, number] | null {
  for (const s of issue.sightings) {
    if (s.on !== 'map') continue;
    const pts: [number, number][] = [];
    const walk = (g: unknown) => {
      if (!Array.isArray(g)) return;
      if (typeof g[0] === 'number' && typeof g[1] === 'number') pts.push([g[0], g[1]]);
      else for (const x of g) walk(x);
    };
    walk((s.geojson as { coordinates?: unknown }).coordinates);
    // a closed ring repeats its first vertex
    const first = pts[0];
    const last = pts[pts.length - 1];
    const closed = first !== undefined && first[0] === last?.[0] && first[1] === last[1];
    if (pts.length > 2 && closed) pts.pop();
    if (!pts.length) continue;
    const n = pts.length;
    return [pts.reduce((a, p) => a + p[0], 0) / n, pts.reduce((a, p) => a + p[1], 0) / n];
  }
  return null;
}

/** One row per issue with a map sighting, in issue order. */
export function defectRows(
  issues: readonly Issue[],
  manifest: Pick<ProjectManifest, 'severityModels' | 'classCatalogues'>,
  road: RoadModel,
  toLocal: (lon: number, lat: number) => [number, number],
): DefectRow[] {
  const classes = new Map<string, { label: string; color: string }>();
  for (const c of manifest.classCatalogues) for (const k of c.classes) classes.set(k.id, k);
  const models = new Map(manifest.severityModels.map((m) => [m.id, m]));
  const rows: DefectRow[] = [];
  for (const issue of issues) {
    const c = mapCentroid(issue);
    if (!c) continue;
    const [x, z] = toLocal(c[0], c[1]);
    const ch = chainageAt(road, x, z);
    const sev = issue.severity === 'uncertain' ? 0 : issue.severity;
    const level = models.get(issue.severityModelId)?.levels.find((l) => l.value === sev);
    const cls = classes.get(issue.classId);
    const image = issue.sightings.find((s) => s.on === 'image');
    const area = issue.measurements?.find((m) => m.kind === 'area')?.value ?? null;
    const extent = issue.measurements?.find((m) => m.kind === 'distance')?.value ?? null;
    const classLabel = cls?.label ?? issue.classId;
    const severityLabel = level?.label ?? (sev ? String(sev) : 'Uncertain');
    rows.push({
      id: issue.id,
      code: issue.code,
      title: issue.title,
      classId: issue.classId,
      classLabel,
      classColor: cls?.color ?? '#95a0ab',
      severity: sev,
      severityLabel,
      severityColor: level?.color ?? '#95a0ab',
      km: ch.km,
      offsetM: ch.offsetM,
      at: [x, z],
      areaM2: area,
      extentM: extent,
      photo: image?.on === 'image' ? { layer: image.layer, photo: image.photo } : null,
      haystack:
        `${issue.code} ${classLabel} ${severityLabel} km ${ch.km.toFixed(2)} ${issue.title}`.toLowerCase(),
    });
  }
  return rows;
}

export interface DefectFilter {
  /** Severity values to keep (null: all). */
  severities: ReadonlySet<number> | null;
  /** Class ids to keep (null: all). */
  classes: ReadonlySet<string> | null;
  kmRange: readonly [number, number] | null;
  search: string;
}

export const NO_FILTER: DefectFilter = {
  severities: null,
  classes: null,
  kmRange: null,
  search: '',
};

export function filterDefects(rows: readonly DefectRow[], f: DefectFilter): DefectRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!f.severities || f.severities.has(r.severity)) &&
      (!f.classes || f.classes.has(r.classId)) &&
      (!f.kmRange || (r.km >= f.kmRange[0] && r.km <= f.kmRange[1])) &&
      (!q || r.haystack.includes(q)),
  );
}

export type DefectSort = 'severity' | 'chainage' | 'area' | 'code';

export function sortDefects(rows: readonly DefectRow[], by: DefectSort): DefectRow[] {
  const area = (r: DefectRow) => r.areaM2 ?? 0;
  const cmp: Record<DefectSort, (a: DefectRow, b: DefectRow) => number> = {
    severity: (a, b) => b.severity - a.severity || area(b) - area(a) || a.km - b.km,
    chainage: (a, b) => a.km - b.km,
    area: (a, b) => area(b) - area(a),
    code: (a, b) => a.code.localeCompare(b.code),
  };
  return [...rows].sort(cmp[by]);
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The defects as CSV, with project CRS easting and northing of each centroid. */
export function defectsCsv(rows: readonly DefectRow[], origin: Vec3): string {
  const head = 'code,type,severity,area_m2,extent_m,chainage_km,offset_m,easting,northing,closeup';
  const lines = rows.map((r) =>
    [
      r.code,
      r.classLabel,
      r.severityLabel,
      r.areaM2 === null ? '' : String(r.areaM2),
      r.extentM === null ? '' : String(r.extentM),
      r.km.toFixed(3),
      r.offsetM.toFixed(2),
      (origin[0] + r.at[0]).toFixed(2),
      (origin[1] - r.at[1]).toFixed(2),
      r.photo?.photo ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[head, ...lines].join('\n')}\n`;
}

export interface ChainageBin {
  fromKm: number;
  toKm: number;
  total: number;
  bySeverity: Record<number, number>;
}

/** Defect counts per bin of `binKm` along the road (the last bin may be short). */
export function chainageBins(
  rows: readonly DefectRow[],
  lengthKm: number,
  binKm = 0.25,
): ChainageBin[] {
  const n = Math.max(1, Math.ceil(lengthKm / binKm - 1e-9));
  const bins: ChainageBin[] = Array.from({ length: n }, (_, i) => ({
    fromKm: i * binKm,
    toKm: Math.min(lengthKm, (i + 1) * binKm),
    total: 0,
    bySeverity: {},
  }));
  for (const r of rows) {
    const bin = bins[Math.min(n - 1, Math.max(0, Math.floor(r.km / binKm)))];
    if (!bin) continue;
    bin.total += 1;
    bin.bySeverity[r.severity] = (bin.bySeverity[r.severity] ?? 0) + 1;
  }
  return bins;
}
