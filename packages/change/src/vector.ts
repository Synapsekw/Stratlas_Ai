import type { ChangeItem, Vec3 } from '@aio/schema';
import { box2, boxGap, centroid2, hausdorff, lonLatToMetres, type Box2, type XY } from './geometry';

/**
 * Map vector change between two dates (FUS-12): the features of two counterpart GeoJSON layers
 * are matched by a stable property (`id`, `fid`, `name`, or the keys given), else by geometry
 * (centroid distance and bounding boxes, then a Hausdorff check on the vertices).
 * Verdicts: `added`, `removed`, `moved` (with the distance), `reshaped`, `attributes` (changed
 * keys), `unchanged`.
 */

type VectorItem = Extract<ChangeItem, { kind: 'vector' }>;

export const DEFAULT_VECTOR_KEYS = ['id', 'fid', 'name'] as const;
/** Vertices closer than this are the same place. */
const SAME_M = 0.1;
/** Geometry matching: bounding boxes at most this far apart. */
const MATCH_GAP_M = 2;
/** Geometry matching: no vertex further than this (or half the feature's size) from the other. */
const MATCH_HAUSDORFF_M = 10;

interface GeoFeature {
  type?: unknown;
  id?: unknown;
  properties?: unknown;
  geometry?: unknown;
}

export interface VectorChangeInput {
  layerFrom: string;
  layerTo: string;
  /** GeoJSON FeatureCollections (lon/lat). */
  from: unknown;
  to: unknown;
  /** Properties that identify a feature across dates, tried in order. */
  keys?: readonly string[];
  /** Lon/lat to the project local frame, for `at` (fly to). */
  toLocal?: (lonLat: [number, number]) => Vec3;
}

interface F {
  index: number;
  props: Record<string, unknown>;
  topId: string | undefined;
  type: string;
  ll: [number, number][];
  m: XY[];
  box: Box2;
  c: [number, number];
  cll: [number, number];
}

function coords(g: unknown, out: [number, number][]): void {
  if (!Array.isArray(g)) return;
  if (g.length >= 2 && typeof g[0] === 'number' && typeof g[1] === 'number') {
    out.push([g[0], g[1]]);
    return;
  }
  for (const x of g) coords(x, out);
}

function features(fc: unknown): GeoFeature[] {
  const list = (fc as { features?: unknown } | null)?.features;
  return Array.isArray(list) ? (list as GeoFeature[]) : [];
}

function geometryOf(f: GeoFeature): { type: string; ll: [number, number][] } {
  const g = f.geometry as { type?: unknown; coordinates?: unknown } | null | undefined;
  const ll: [number, number][] = [];
  coords(g?.coordinates, ll);
  return { type: typeof g?.type === 'string' ? g.type : 'none', ll };
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The vector change items of one pair of counterpart layers. */
export function vectorChanges(input: VectorChangeInput): VectorItem[] {
  const rawA = features(input.from);
  const rawB = features(input.to);
  const all: [number, number][] = [];
  const geoA = rawA.map(geometryOf);
  const geoB = rawB.map(geometryOf);
  for (const g of [...geoA, ...geoB]) all.push(...g.ll);
  const origin = all.length ? centroid2(all) : ([0, 0] as [number, number]);
  const make = (f: GeoFeature, g: { type: string; ll: [number, number][] }, i: number): F => {
    const m = g.ll.map((p) => lonLatToMetres(p, origin));
    return {
      index: i,
      props: (f.properties && typeof f.properties === 'object' ? f.properties : {}) as Record<
        string,
        unknown
      >,
      topId: text(f.id),
      type: g.type,
      ll: g.ll,
      m,
      box: box2(m),
      c: centroid2(m),
      cll: centroid2(g.ll),
    };
  };
  const A = rawA.map((f, i) => make(f, geoA[i] ?? { type: 'none', ll: [] }, i));
  const B = rawB.map((f, i) => make(f, geoB[i] ?? { type: 'none', ll: [] }, i));

  const pairs: { a: F; b: F; key: string; by: string }[] = [];
  const doneA = new Set<F>();
  const doneB = new Set<F>();
  // 1. a stable property (unique on each date)
  const keyed = (list: F[], k: string) => {
    const m = new Map<string, F | null>();
    for (const f of list) {
      const v = k === '$id' ? f.topId : text(f.props[k]);
      if (v === undefined) continue;
      m.set(v, m.has(v) ? null : f);
    }
    return m;
  };
  for (const k of ['$id', ...(input.keys ?? DEFAULT_VECTOR_KEYS)]) {
    const ma = keyed(A, k);
    const mb = keyed(B, k);
    for (const [v, a] of ma) {
      const b = mb.get(v);
      if (!a || !b || doneA.has(a) || doneB.has(b)) continue;
      pairs.push({ a, b, key: v, by: k === '$id' ? 'id' : k });
      doneA.add(a);
      doneB.add(b);
    }
  }
  // 2. geometry: same type, boxes close, nearest centroid, then the vertices agree
  for (const a of A) {
    if (doneA.has(a) || a.m.length === 0) continue;
    let best: F | null = null;
    let bestD = Infinity;
    for (const b of B) {
      if (doneB.has(b) || b.type !== a.type || b.m.length === 0) continue;
      if (boxGap(a.box, b.box) > MATCH_GAP_M) continue;
      const d = Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]);
      if (d < bestD) {
        best = b;
        bestD = d;
      }
    }
    if (!best) continue;
    const size = Math.hypot(a.box.maxX - a.box.minX, a.box.maxY - a.box.minY);
    if (hausdorff(a.m, best.m) > Math.max(MATCH_HAUSDORFF_M, size / 2)) continue;
    pairs.push({ a, b: best, key: `#${String(a.index)}`, by: 'geometry' });
    doneA.add(a);
    doneB.add(best);
  }

  const name = (f: F, key: string) => text(f.props.name) ?? text(f.props.id) ?? key;
  const at = (f: F): Pick<VectorItem, 'at'> =>
    input.toLocal && f.ll.length ? { at: input.toLocal(f.cll) } : {};
  const items: VectorItem[] = [];
  for (const { a, b, key, by } of pairs) {
    const h = hausdorff(a.m, b.m);
    const shift: XY = [b.c[0] - a.c[0], b.c[1] - a.c[1]];
    const shiftM = Math.hypot(shift[0], shift[1]);
    const changed = Object.keys({ ...a.props, ...b.props })
      .filter((k) => k !== by && !same(a.props[k], b.props[k]))
      .sort();
    let verdict: VectorItem['verdict'] = 'unchanged';
    let distanceM: number | undefined;
    if (h > SAME_M) {
      const moved = a.m.map((p) => [p[0] + shift[0], p[1] + shift[1]] as XY);
      const h2 = hausdorff(moved, b.m);
      verdict = h2 <= Math.max(SAME_M, 0.2 * shiftM) ? 'moved' : 'reshaped';
      distanceM = Math.round((verdict === 'moved' ? shiftM : h) * 100) / 100;
    } else if (changed.length) verdict = 'attributes';
    const n = name(b, key);
    items.push({
      kind: 'vector',
      id: `vector:${input.layerFrom}:${key}`,
      verdict,
      label:
        verdict === 'moved'
          ? `${n} moved ${String(distanceM)} m`
          : verdict === 'reshaped'
            ? `${n} reshaped, up to ${String(distanceM)} m`
            : verdict === 'attributes'
              ? `${n}: ${changed.join(', ')} changed`
              : `${n} unchanged`,
      layerFrom: input.layerFrom,
      layerTo: input.layerTo,
      featureFrom: a.topId ?? a.index,
      featureTo: b.topId ?? b.index,
      method: by === 'geometry' ? 'geometry' : 'property',
      ...at(b),
      ...(distanceM !== undefined ? { distanceM } : {}),
      ...(changed.length ? { keys: changed } : {}),
    });
  }
  for (const a of A) {
    if (doneA.has(a)) continue;
    const key = keyOf(a, input.keys) ?? `#${String(a.index)}`;
    items.push({
      kind: 'vector',
      id: `vector:${input.layerFrom}:${key}`,
      verdict: 'removed',
      label: `${name(a, key)} removed`,
      layerFrom: input.layerFrom,
      featureFrom: a.topId ?? a.index,
      ...at(a),
    });
  }
  for (const b of B) {
    if (doneB.has(b)) continue;
    const key = keyOf(b, input.keys) ?? `#to${String(b.index)}`;
    items.push({
      kind: 'vector',
      id: `vector:${input.layerFrom}:${key}`,
      verdict: 'added',
      label: `${name(b, key)} added`,
      layerTo: input.layerTo,
      featureTo: b.topId ?? b.index,
      ...at(b),
    });
  }
  // ids stay unique when a key value repeats on one date
  const seen = new Map<string, number>();
  return items.map((it) => {
    const n = seen.get(it.id) ?? 0;
    seen.set(it.id, n + 1);
    return n === 0 ? it : { ...it, id: `${it.id}~${String(n)}` };
  });
}

function keyOf(f: F, keys: readonly string[] | undefined): string | undefined {
  if (f.topId) return f.topId;
  for (const k of keys ?? DEFAULT_VECTOR_KEYS) {
    const v = text(f.props[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}
