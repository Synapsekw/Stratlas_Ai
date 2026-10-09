/**
 * What the site views draw of a design (M11 G6, DSN-1): plain geometry built from the design's
 * normalised files, in the project CRS (E, N, Z metres), for `designsScene.ts`. A surface layer
 * (`aio.tin/1`) is its triangles and its outline (the edges of one triangle only, chained);
 * linework (GeoJSON with Z) its lines; points their positions and ids; an alignment its centreline
 * with a tick and a station label at every interval (`intervalM`, else 20 m).
 */
import type { Alignment } from '@aio/schema';
import { alignmentPolyline, pointAt, stationLabels } from '@aio/survey';

export type P3 = [number, number, number];
export type P2 = [number, number];

/**
 * The outline of a triangulation: every edge that belongs to one triangle only, chained into
 * polylines of vertex indices (a closed loop ends on its first vertex).
 */
export function tinOutline(triangles: ArrayLike<number>, vertexCount: number): number[][] {
  const n = Math.max(1, vertexCount);
  // undirected edge key to its directed (a, b) and use count
  const edges = new Map<number, { a: number; b: number; uses: number }>();
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const c = [triangles[t] ?? 0, triangles[t + 1] ?? 0, triangles[t + 2] ?? 0];
    for (let k = 0; k < 3; k++) {
      const a = c[k] ?? 0;
      const b = c[(k + 1) % 3] ?? 0;
      if (a === b) continue;
      const key = Math.min(a, b) * n + Math.max(a, b);
      const e = edges.get(key);
      if (e) e.uses++;
      else edges.set(key, { a, b, uses: 1 });
    }
  }
  const next = new Map<number, number[]>();
  for (const e of edges.values())
    if (e.uses === 1) {
      const list = next.get(e.a);
      if (list) list.push(e.b);
      else next.set(e.a, [e.b]);
    }
  const chains: number[][] = [];
  const take = (from: number): number | undefined => {
    const list = next.get(from);
    const to = list?.pop();
    if (list?.length === 0) next.delete(from);
    return to;
  };
  // open chains first (start where nothing ends), then the loops
  const ends = new Set<number>();
  for (const list of next.values()) for (const b of list) ends.add(b);
  const starts = [...next.keys()].filter((a) => !ends.has(a));
  for (const start of [...starts, ...next.keys()]) {
    while (next.has(start)) {
      const chain = [start];
      let at: number | undefined = start;
      while (at !== undefined) {
        at = take(at);
        if (at !== undefined) chain.push(at);
        if (at === start) break;
      }
      if (chain.length > 1) chains.push(chain);
    }
  }
  return chains;
}

interface GeoJsonish {
  features?: { geometry?: { type?: string; coordinates?: unknown } | null; properties?: unknown }[];
}

const p3 = (c: unknown): P3 | null => {
  if (!Array.isArray(c) || c.length < 2) return null;
  const [e, n, z] = c as unknown[];
  if (typeof e !== 'number' || typeof n !== 'number') return null;
  return [e, n, typeof z === 'number' && Number.isFinite(z) ? z : 0];
};
const line = (c: unknown): P3[] =>
  Array.isArray(c) ? c.map(p3).filter((p): p is P3 => p !== null) : [];

/** The lines of a linework layer (LineString, MultiLineString, Polygon and MultiPolygon rings). */
export function lineworkLines(json: unknown): P3[][] {
  const out: P3[][] = [];
  for (const f of (json as GeoJsonish | null)?.features ?? []) {
    const g = f.geometry;
    const c = g?.coordinates;
    if (!g || !Array.isArray(c)) continue;
    if (g.type === 'LineString') out.push(line(c));
    else if (g.type === 'MultiLineString' || g.type === 'Polygon')
      for (const l of c) out.push(line(l));
    else if (g.type === 'MultiPolygon')
      for (const poly of c) if (Array.isArray(poly)) for (const l of poly) out.push(line(l));
  }
  return out.filter((l) => l.length >= 2);
}

export interface DesignPoint {
  p: P3;
  id: string;
}

/** The points of a points layer (GeoJSON Point features with Z and an `id`). */
export function designPoints(json: unknown): DesignPoint[] {
  const out: DesignPoint[] = [];
  for (const f of (json as GeoJsonish | null)?.features ?? []) {
    if (f.geometry?.type !== 'Point') continue;
    const p = p3(f.geometry.coordinates);
    if (!p) continue;
    const props = (f.properties ?? {}) as { id?: unknown };
    out.push({ p, id: typeof props.id === 'string' ? props.id : String(out.length + 1) });
  }
  return out;
}

export interface StationTick {
  /** Where the label sits (the tick's right end). */
  at: P2;
  /** The tick across the centreline. */
  a: P2;
  b: P2;
  label: string;
}

export interface AlignmentDrawing {
  line: P2[];
  ticks: StationTick[];
}

/** At most this many station ticks are drawn (a very long alignment at a short interval). */
export const MAX_TICKS = 2000;

/**
 * An alignment's centreline (a point every `stepM` on curves) and a tick `tickM` long across it at
 * every station label (`stationLabels`, at the layer's interval when given).
 */
export function alignmentDrawing(
  al: Alignment,
  opts: { intervalM?: number; tickM?: number; stepM?: number } = {},
): AlignmentDrawing {
  const half = (opts.tickM ?? 4) / 2;
  const labels = stationLabels(al, opts.intervalM);
  const every = Math.max(1, Math.ceil(labels.length / MAX_TICKS));
  const ticks: StationTick[] = [];
  for (let i = 0; i < labels.length; i += every) {
    const l = labels[i];
    if (!l) continue;
    const [e, n, b] = pointAt(al, l.distance);
    // the bearing is clockwise from grid north: right of the direction of travel is (cos, -sin)
    const re = Math.cos(b);
    const rn = -Math.sin(b);
    ticks.push({
      at: [e + re * half, n + rn * half],
      a: [e - re * half, n - rn * half],
      b: [e + re * half, n + rn * half],
      label: l.label,
    });
  }
  return { line: alignmentPolyline(al, opts.stepM ?? 2), ticks };
}

/** Heights for horizontal geometry: the terrain where there is one, else `fallback`. */
export function drape(
  points: readonly P2[],
  heightAt: ((e: number, n: number) => number | null) | null,
  fallback: number,
): P3[] {
  return points.map(([e, n]) => [e, n, heightAt?.(e, n) ?? fallback]);
}
