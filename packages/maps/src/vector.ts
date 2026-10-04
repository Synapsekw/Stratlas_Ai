import type { ClassCatalogue, Issue, SeverityModel, VectorStyle } from '@aio/schema';
import type { Feature, FeatureCollection, Geometry, Point } from 'geojson';
import type { FrameProjection } from './geo';
import { ALL_ISSUES, issueAnchor, type LonLat, type MapIssueDisplay } from './overlays';

/** One MapLibre style layer of an overlay (the source is the overlay's own). */
export interface OverlayLayer {
  /** Unique within the overlay. */
  id: string;
  type: 'fill' | 'line' | 'circle' | 'symbol';
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  filter?: unknown[];
  minzoom?: number;
  maxzoom?: number;
  /** Draw above the issues (labels, ticks); overlays sit under them by default. */
  above?: boolean;
}

/**
 * A GeoJSON overlay on the map: inline features or a URL (aio://project/...), drawn by its style
 * layers between the project rasters and the issues. Changing `data` (by identity) replaces the
 * features; changing `layers` restyles.
 */
export interface MapOverlay {
  id: string;
  data: FeatureCollection | string;
  layers: OverlayLayer[];
  visible?: boolean;
  /** Text for a hover tooltip over a feature, from its properties; null for none. */
  tooltip?: (properties: Record<string, unknown>) => string | null;
  /** Click on a feature (selection and drawing win over overlays). */
  onClick?: (properties: Record<string, unknown>, lngLat: LonLat) => void;
}

const FALLBACK_LINE = '#9aa6b2';

/** Map layers for a manifest `vector` layer style (an outline when there is no style). */
export function styleLayers(style: VectorStyle | undefined): OverlayLayer[] {
  const s = style ?? { line: { color: FALLBACK_LINE, width: 1.5 } };
  const ramp = (base: string): unknown =>
    s.colorBy
      ? [
          'step',
          ['to-number', ['get', s.colorBy.field], 0],
          s.colorBy.stops[0]?.[1] ?? base,
          ...s.colorBy.stops.slice(1).flat(),
        ]
      : base;
  const zoom = s.minZoom !== undefined ? { minzoom: s.minZoom } : {};
  const out: OverlayLayer[] = [];
  if (s.fill) {
    out.push({
      id: 'fill',
      type: 'fill',
      filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
      paint: { 'fill-color': ramp(s.fill.color), 'fill-opacity': s.fill.opacity },
      ...zoom,
    });
  }
  if (s.line) {
    out.push({
      id: 'line',
      type: 'line',
      filter: ['!=', ['geometry-type'], 'Point'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ramp(s.line.color),
        'line-width': s.line.width,
        ...(s.line.opacity !== undefined ? { 'line-opacity': s.line.opacity } : {}),
        ...(s.line.dash ? { 'line-dasharray': s.line.dash } : {}),
      },
      ...zoom,
    });
  }
  if (s.circle) {
    out.push({
      id: 'circle',
      type: 'circle',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-color': ramp(s.circle.color),
        'circle-radius': s.circle.radius,
        'circle-stroke-color': '#080a0d',
        'circle-stroke-width': 1,
      },
      ...zoom,
    });
  }
  if (s.label) {
    out.push({
      id: 'label',
      type: 'symbol',
      layout: {
        'text-field': ['get', s.label.field],
        'text-font': ['Noto Sans Medium'],
        'text-size': s.label.size ?? 11,
        'symbol-placement': 'point',
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
      },
      paint: { 'text-color': '#eaedf1', 'text-halo-color': '#080a0d', 'text-halo-width': 1.5 },
      ...zoom,
    });
  }
  return out;
}

// ---- geodesic measures (WGS84, local ellipsoid radii; centimetre-level over a site) ----

const A = 6378137;
const E2 = 0.00669437999014;
const RAD = Math.PI / 180;

function radii(latDeg: number): { m: number; n: number } {
  const s = Math.sin(latDeg * RAD);
  const w = Math.sqrt(1 - E2 * s * s);
  return { m: (A * (1 - E2)) / (w * w * w), n: A / w };
}

/** Length of a polyline in metres. */
export function lineLengthM(points: readonly LonLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const { m, n } = radii((a[1] + b[1]) / 2);
    const dy = (b[1] - a[1]) * RAD * m;
    const dx = (b[0] - a[0]) * RAD * n * Math.cos(((a[1] + b[1]) / 2) * RAD);
    total += Math.hypot(dx, dy);
  }
  return total;
}

/** Area of a simple polygon (ring, closed or open) in square metres. */
export function polygonAreaM2(ring: readonly LonLat[]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const { m, n } = radii(lat0);
  const kx = RAD * n * Math.cos(lat0 * RAD);
  const ky = RAD * m;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    sum += (a[0] - lon0) * kx * ((b[1] - lat0) * ky) - (b[0] - lon0) * kx * ((a[1] - lat0) * ky);
  }
  return Math.abs(sum) / 2;
}

// ---- issues ----

export interface IssueFeatureOptions {
  models: readonly SeverityModel[];
  catalogues: readonly ClassCatalogue[];
  selectedId: string | null;
  proj: FrameProjection | null;
  /** Only these issues (null or undefined: all). */
  only?: ReadonlySet<string> | null;
  /** The app's Pins control: off switch, severity threshold, heat map (default: all, no heat). */
  display?: MapIssueDisplay;
  /** The hovered issue, drawn again on top with its code. */
  hoverId?: string | null;
}

/** Map features for the issues; see `issueFeatures`. */
export interface IssueFeatureSet {
  /** Clustered markers: every shown issue with an anchor except the selected one. */
  points: Feature<Point>[];
  /** Never clustered: the selected issue and the hovered one, labelled. */
  focus: Feature<Point>[];
  /** Heat map weights: every issue the severity threshold keeps (when the heat map is on). */
  heat: Feature<Point>[];
  /** Polygon map sightings, drawn from close zooms. */
  shapes: Feature<Shape>[];
}

const NEUTRAL = '#95a0ab';

type Shape = Extract<Geometry, { type: 'Polygon' | 'MultiPolygon' }>;

function shapeOf(issue: Issue): Shape | null {
  for (const s of issue.sightings) {
    if (s.on !== 'map') continue;
    const g = s.geojson as { type?: unknown; coordinates?: unknown; geometry?: unknown };
    const geom = (g.type === 'Feature' ? g.geometry : g) as Geometry | undefined;
    if (geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon')) return geom;
  }
  return null;
}

/**
 * Map features for issues: a point per issue with an anchor (centroid of its map sighting or its
 * first 3D sighting) and a shape per issue with a polygon map sighting. Each carries its severity
 * colour (from its model), its class colour (from the catalogues), its rank (uncertain is -1,
 * for cluster badges) and whether it has a shape; lower severities come first so higher ones
 * draw on top. The selected issue leaves the clusters for `focus`; the Pins threshold and off
 * switch hide the rest (never the selection); `only` hides everything outside it.
 */
export function issueFeatures(
  issues: readonly Issue[],
  {
    models,
    catalogues,
    selectedId,
    proj,
    only,
    display = ALL_ISSUES,
    hoverId = null,
  }: IssueFeatureOptions,
): IssueFeatureSet {
  const modelById = new Map(models.map((m) => [m.id, m]));
  const classColor = new Map<string, string>();
  for (const c of catalogues) for (const k of c.classes) classColor.set(k.id, k.color);
  const top = Math.max(1, ...models.flatMap((m) => m.levels.map((l) => l.value)));
  const rankOf = (i: Issue) => (i.severity === 'uncertain' ? -1 : i.severity);
  const sorted = issues
    .filter((i) => !only || only.has(i.id))
    .sort((a, b) => rankOf(a) - rankOf(b));
  const out: IssueFeatureSet = { points: [], focus: [], heat: [], shapes: [] };
  for (const issue of sorted) {
    const rank = rankOf(issue);
    const kept = display.minSeverity === null || rank >= display.minSeverity;
    const selected = issue.id === selectedId;
    if (!kept && !selected) continue;
    const shown = display.show && kept;
    const model = modelById.get(issue.severityModelId);
    const level =
      issue.severity === 'uncertain'
        ? undefined
        : model?.levels.find((l) => l.value === issue.severity);
    const sevColor =
      issue.severity === 'uncertain'
        ? (model?.uncertain?.color ?? NEUTRAL)
        : (level?.color ?? NEUTRAL);
    const shape = shapeOf(issue);
    const properties = {
      issueId: issue.id,
      code: issue.code,
      title: issue.title,
      rank,
      severity: Math.max(0, rank),
      severityLabel: issue.severity === 'uncertain' ? 'Uncertain' : (level?.label ?? ''),
      sevColor,
      classColor: classColor.get(issue.classId) ?? sevColor,
      selected,
      hasShape: shape !== null,
    };
    if (shape && (shown || selected))
      out.shapes.push({ type: 'Feature', properties, geometry: shape });
    const at = issueAnchor(issue, proj);
    if (!at) continue;
    const geometry: Point = { type: 'Point', coordinates: at };
    if (display.heat && kept) {
      out.heat.push({
        type: 'Feature',
        properties: { weight: rank < 0 ? 0.25 : 0.4 + (0.6 * rank) / top },
        geometry,
      });
    }
    // The hovered pin stays in its cluster source (no re-clustering on hover) and is drawn
    // again on top with its code; the selected one leaves the clusters.
    if (selected || (issue.id === hoverId && shown))
      out.focus.push({ type: 'Feature', properties, geometry });
    if (!selected && shown) out.points.push({ type: 'Feature', properties, geometry });
  }
  return out;
}

/** Bounding box [w, s, e, n] of an issue's map sighting shape, or null. */
export function issueShapeBounds(issue: Issue): [number, number, number, number] | null {
  const g = shapeOf(issue);
  if (!g) return null;
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of rings)
    for (const [x = 0, y = 0] of ring) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
