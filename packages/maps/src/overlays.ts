import type { Issue, LensModel, PoseSample, SeverityModel, Vec3 } from '@aio/schema';
import type { Feature, Point } from 'geojson';
import { Quaternion, Vector3 } from 'three';
import type { FrameProjection } from './geo';

export type LonLat = [number, number];

/** Local raster corners (data-conventions section 5) to a MapLibre image quad: tl, tr, br, bl. */
export function rasterQuad(
  corners: { tl: Vec3; tr: Vec3; bl: Vec3 },
  proj: FrameProjection,
): [LonLat, LonLat, LonLat, LonLat] {
  const { tl, tr, bl } = corners;
  const br: Vec3 = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]];
  return [proj.toLonLat(tl), proj.toLonLat(tr), proj.toLonLat(br), proj.toLonLat(bl)];
}

/** Pose at flight time `t` (ms since flight start): linear position, slerped orientation. */
export function poseAt(samples: readonly PoseSample[], t: number): PoseSample | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid]?.t ?? 0) <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo] ?? first;
  const b = samples[hi] ?? last;
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const q = new Quaternion(...a.q).slerp(new Quaternion(...b.q), k);
  return {
    t,
    pos: [
      a.pos[0] + (b.pos[0] - a.pos[0]) * k,
      a.pos[1] + (b.pos[1] - a.pos[1]) * k,
      a.pos[2] + (b.pos[2] - a.pos[2]) * k,
    ],
    q: [q.x, q.y, q.z, q.w],
  };
}

/** Camera-space directions of the four image corners (tl, tr, br, bl); camera looks along -Z. */
function cornerRays(lens: LensModel): Vector3[] {
  const half = ((lens.hfovDeg / 2) * Math.PI) / 180;
  const signs: [number, number][] = [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ];
  if (lens.model === 'pinhole') {
    const tx = Math.tan(half);
    const ty = tx / lens.aspect;
    return signs.map(([sx, sy]) => new Vector3(sx * tx, sy * ty, -1).normalize());
  }
  // f-theta (equidistant): angle from the axis grows linearly with image radius.
  const phi = Math.atan2(1 / lens.aspect, 1);
  const theta = Math.min(half * Math.hypot(1, 1 / lens.aspect), (89 * Math.PI) / 180);
  return signs.map(([sx, sy]) =>
    new Vector3(
      sx * Math.sin(theta) * Math.cos(phi),
      sy * Math.sin(theta) * Math.sin(phi),
      -Math.cos(theta),
    ).normalize(),
  );
}

/**
 * Ground footprint (local frame, on the plane y = groundY) of a camera pose: the four image
 * corners cast onto the ground, each capped at `maxRange` metres from the camera.
 */
export function footprint(
  pose: PoseSample,
  lens: LensModel,
  { groundY = 0, maxRange = 2000 }: { groundY?: number; maxRange?: number } = {},
): Vec3[] {
  const q = new Quaternion(...pose.q);
  const origin = new Vector3(...pose.pos);
  return cornerRays(lens).map((ray) => {
    const dir = ray.applyQuaternion(q);
    let t = maxRange;
    if (dir.y < -1e-9) t = Math.min(t, (groundY - origin.y) / dir.y);
    if (t < 0) t = 0;
    const p = origin.clone().addScaledVector(dir, t);
    // Rays capped above the ground are dropped onto it so the polygon stays planar.
    return [p.x, groundY, p.z];
  });
}

function centroid(points: readonly (readonly number[])[]): number[] | null {
  if (!points.length) return null;
  const n = points[0]?.length ?? 0;
  const sum = new Array<number>(n).fill(0);
  for (const p of points) for (let i = 0; i < n; i++) sum[i] = (sum[i] ?? 0) + (p[i] ?? 0);
  return sum.map((s) => s / points.length);
}

/** Every [lon, lat] position in a GeoJSON geometry, feature or feature collection. */
function geojsonPositions(g: unknown, out: LonLat[] = []): LonLat[] {
  if (Array.isArray(g)) {
    if (g.length >= 2 && typeof g[0] === 'number' && typeof g[1] === 'number')
      out.push([g[0], g[1]]);
    else for (const x of g) geojsonPositions(x, out);
  } else if (g && typeof g === 'object') {
    const o = g as Record<string, unknown>;
    if ('coordinates' in o) geojsonPositions(o.coordinates, out);
    if ('geometry' in o) geojsonPositions(o.geometry, out);
    if (Array.isArray(o.features)) for (const f of o.features) geojsonPositions(f, out);
    if (Array.isArray(o.geometries)) for (const f of o.geometries) geojsonPositions(f, out);
  }
  return out;
}

/** Where an issue sits on the map: a map sighting, else the first 3D sighting. Null if none. */
export function issueAnchor(issue: Issue, proj: FrameProjection | null): LonLat | null {
  for (const s of issue.sightings) {
    if (s.on !== 'map') continue;
    const c = centroid(geojsonPositions(s.geojson));
    if (c) return [c[0] ?? 0, c[1] ?? 0];
  }
  if (!proj) return null;
  for (const s of issue.sightings) {
    let local: number[] | null = null;
    if (s.on === 'mesh') {
      const g = s.geom;
      if (g.type === 'spoint') local = g.p;
      else if (g.type === 'spolyline' || g.type === 'spolygon') local = centroid(g.points);
      else if (g.center) local = g.center;
    } else if (s.on === 'pointcloud') {
      const g = s.geom;
      if (g.type === 'point3') local = g.p;
      else if (g.type === 'box3') local = centroid([g.min, g.max]);
      else if (g.type === 'polygon3') local = centroid(g.points);
    }
    if (local) return proj.toLonLat([local[0] ?? 0, local[1] ?? 0, local[2] ?? 0]);
  }
  return null;
}

/** How issues are drawn on the map (the app's Pins control). */
export interface MapIssueDisplay {
  /** False: no markers except the selected issue. */
  show: boolean;
  /** Only graded severities at or above this level (uncertain left out); null for all. */
  minSeverity: number | null;
  /** Severity density heat map under the markers. */
  heat: boolean;
}

export const ALL_ISSUES: MapIssueDisplay = { show: true, minSeverity: null, heat: false };

const NEUTRAL = '#8a94a6';
const rankOf = (s: Issue['severity']) => (s === 'uncertain' ? -1 : s);

function colorOf(models: readonly SeverityModel[], issue: Issue): string {
  const m = models.find((x) => x.id === issue.severityModelId);
  if (!m) return NEUTRAL;
  if (issue.severity === 'uncertain') return m.uncertain?.color ?? NEUTRAL;
  return m.levels.find((l) => l.value === issue.severity)?.color ?? NEUTRAL;
}

/** Rank to colour pairs (ascending) over the project's models: cluster badges by worst member. */
export function severityRankColors(models: readonly SeverityModel[]): [number, string][] {
  const out = new Map<number, string>();
  for (const m of models) {
    if (m.uncertain && !out.has(-1)) out.set(-1, m.uncertain.color);
    for (const l of m.levels) if (!out.has(l.value)) out.set(l.value, l.color);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Issue markers for the map: `points` feed the clustered source (filtered, without the
 * selected issue), `focus` holds the selected issue (never clustered) and the hovered one (drawn
 * again on top), both labelled, and `heat` every issue the severity threshold keeps, weighted
 * by severity.
 */
export function issueFeatures(
  issues: readonly Issue[],
  proj: FrameProjection | null,
  models: readonly SeverityModel[],
  display: MapIssueDisplay,
  focus: { selected: string | null; hover: string | null },
): { points: Feature<Point>[]; focus: Feature<Point>[]; heat: Feature<Point>[] } {
  const points: Feature<Point>[] = [];
  const near: Feature<Point>[] = [];
  const heat: Feature<Point>[] = [];
  const top = Math.max(1, ...models.flatMap((m) => m.levels.map((l) => l.value)));
  for (const issue of issues) {
    const rank = rankOf(issue.severity);
    const kept = display.minSeverity === null || rank >= display.minSeverity;
    const selected = issue.id === focus.selected;
    const hovered = issue.id === focus.hover;
    if (!kept && !selected) continue;
    const at = issueAnchor(issue, proj);
    if (!at) continue;
    const geometry: Point = { type: 'Point', coordinates: at };
    if (display.heat && kept) {
      heat.push({
        type: 'Feature',
        properties: { weight: rank < 0 ? 0.25 : 0.4 + (0.6 * rank) / top },
        geometry,
      });
    }
    const properties = {
      issueId: issue.id,
      code: issue.code,
      rank,
      color: colorOf(models, issue),
      selected,
    };
    // The hovered pin stays in its cluster source (no re-clustering on hover) and is drawn
    // again on top with its code; the selected one leaves the clusters.
    if (selected || (hovered && display.show && kept)) {
      near.push({ type: 'Feature', properties, geometry });
    }
    if (!selected && display.show && kept) {
      points.push({ type: 'Feature', properties, geometry });
    }
  }
  return { points, focus: near, heat };
}
