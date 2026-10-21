/**
 * Where a measurement was measured: the layer under its vertices and the survey date that layer
 * belongs to. Pure helpers (no store, no scene): the 3D and map picks name a layer for each vertex,
 * `creationDating` turns the first one into the new measurement's `scope`, `source` and
 * `pickedOn`, and `realignPickedOn` keeps `pickedOn` the length of `points` through every edit.
 */
import {
  shiftCorners,
  type MeasurementScope,
  type MeasurementSource,
  type PickedOn,
  type ProjectManifest,
  type SitePoint,
  type Vec3,
} from '@aio/schema';
import { dateShiftOf, type CaptureIndex } from '@aio/workspace';

/** What one picked vertex sits on: its layer (null: none was named) and the kind of surface. */
export interface VertexPick {
  layer: string | null;
  on: PickedOn;
}

type Layers = Pick<ProjectManifest, 'layers'>;
type Dated = Pick<ProjectManifest, 'layers' | 'captures' | 'origin'>;

/** The date's DSM raster, else its ortho raster, else its first dated layer. */
export function baseLayer(
  index: CaptureIndex,
  manifest: Layers,
  capture: string,
): string | undefined {
  const ids = index.layers[capture] ?? [];
  const layers = ids.flatMap((id) => manifest.layers.filter((l) => l.id === id));
  const raster = (role: 'dsm' | 'ortho') =>
    layers.find((l) => l.kind === 'raster' && l.role === role)?.id;
  return raster('dsm') ?? raster('ortho') ?? ids[0];
}

/** Is the local point (x east, z south) inside the quad the three corners span? */
function inside(c: { tl: Vec3; tr: Vec3; bl: Vec3 }, p: Vec3): boolean {
  const ux = c.tr[0] - c.tl[0];
  const uz = c.tr[2] - c.tl[2];
  const vx = c.bl[0] - c.tl[0];
  const vz = c.bl[2] - c.tl[2];
  const det = ux * vz - uz * vx;
  if (Math.abs(det) < 1e-12) return false;
  const dx = p[0] - c.tl[0];
  const dz = p[2] - c.tl[2];
  const a = (dx * vz - dz * vx) / det;
  const b = (ux * dz - uz * dx) / det;
  const eps = 1e-9;
  return a >= -eps && a <= 1 + eps && b >= -eps && b <= 1 + eps;
}

/**
 * The layer a map click lands on: the topmost shown dated raster whose corners (shifted by the
 * layer's date shift, as the map draws them) contain the point, DSM before ortho. Topmost is the
 * last in `manifest.layers` order (the map adds rasters in that order under `RASTERS_TOP`). A
 * raster without `corners` covers every point.
 */
export function mapPickLayer(
  manifest: Dated,
  index: CaptureIndex,
  hidden: Readonly<Record<string, true>>,
  local: Vec3,
): string | null {
  const hit = (role: 'dsm' | 'ortho'): string | null => {
    for (const l of [...manifest.layers].reverse()) {
      if (l.kind !== 'raster' || l.role !== role) continue;
      if (index.of[l.id] === undefined || hidden[l.id] === true) continue;
      if (!l.corners) return l.id;
      if (inside(shiftCorners(l.corners, dateShiftOf(manifest, l.id)), local)) return l.id;
    }
    return null;
  };
  return hit('dsm') ?? hit('ortho');
}

/** The measurement's dating at creation. */
export interface Dating {
  scope: MeasurementScope;
  source?: MeasurementSource;
  pickedOn: PickedOn[];
}

/**
 * Date a new measurement. The layer is the first pick's, else the base layer of the focused date
 * (else the newest). The date is that layer's own, else (a layer common to every date) the focused
 * date, else the newest. A project with no captures keeps the `site` scope but still records the
 * source.
 */
export function creationDating(
  picks: readonly VertexPick[],
  ctx: {
    index: CaptureIndex | null;
    manifest: Layers;
    focus: string | null;
  },
): Dating {
  const { index, manifest } = ctx;
  const pickedOn = picks.map((p) => p.on);
  const named = picks[0]?.layer ?? null;
  const known = (id: string | null | undefined) =>
    index?.captures.some((c) => c.id === id) === true ? (id ?? null) : null;
  const fallback = known(ctx.focus) ?? index?.captures.at(-1)?.id ?? null;
  if (!index || index.captures.length === 0) {
    const raster = (role: 'dsm' | 'ortho') =>
      manifest.layers.find((l) => l.kind === 'raster' && l.role === role)?.id;
    const layer = named ?? raster('dsm') ?? raster('ortho');
    return {
      scope: { kind: 'site' },
      ...(layer ? { source: { layer } } : {}),
      pickedOn,
    };
  }
  const layer = named ?? (fallback ? baseLayer(index, manifest, fallback) : undefined);
  const capture = (layer ? known(index.of[layer]) : null) ?? fallback;
  return {
    scope: capture ? { kind: 'survey', capture } : { kind: 'site' },
    ...(layer ? { source: { layer } } : {}),
    pickedOn,
  };
}

/**
 * The picks after the point count changed: grown with `pick` (or, for a typed or constructed
 * point, the last layer on the ground), shrunk by truncation.
 */
export function alignPicks(
  prev: readonly VertexPick[],
  length: number,
  pick: VertexPick | null,
): VertexPick[] {
  const out = prev.slice(0, Math.max(0, length));
  while (out.length < length) {
    const last = out.at(-1);
    out.push(pick ?? { layer: last?.layer ?? null, on: 'ground' });
  }
  return out;
}

const key = (p: SitePoint) => p.join(',');

/**
 * `pickedOn` after an edit: a vertex whose coordinates were in `before` keeps its kind; any other
 * takes the previous vertex's kind, else `'ground'`. The result has `after.length` entries.
 */
export function realignPickedOn(
  before: readonly SitePoint[],
  after: readonly SitePoint[],
  kinds: readonly PickedOn[],
): PickedOn[] {
  const queues = new Map<string, PickedOn[]>();
  before.forEach((p, i) => {
    const k = kinds[i];
    if (k === undefined) return;
    const q = queues.get(key(p));
    if (q) q.push(k);
    else queues.set(key(p), [k]);
  });
  const out: PickedOn[] = [];
  for (const p of after) {
    const q = queues.get(key(p));
    const kept = q && q.length > 1 ? q.shift() : q?.[0];
    out.push(kept ?? out.at(-1) ?? 'ground');
  }
  return out;
}
