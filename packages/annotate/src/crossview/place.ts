/**
 * Findings on a model (plan 2026-10-15-findings-on-model, spec section 3): project an issue's
 * photo or frame shape onto a mesh or point-cloud layer as a real area. Every image or video
 * sighting with a box or polygon is a candidate; the best hit rate wins, ties to the larger
 * shape. Nothing is written here: the caller writes the selection file and commits the result
 * through the issue editor (`withPlacedArea`, `commitIssues`).
 */
import type { RayOptions } from '@aio/engine';
import type { AssetRef, Issue, Layer, Sighting, Vec2, Vec3 } from '@aio/schema';
import { Vector3, type Intersection } from 'three';
import { sightingCamera, type CameraSources, type SightingCamera } from './camera';
import { photoFrustum, type PhotoFrustum } from './frustum';
import { pixelToWorldRay } from './lens';
import { densify, gridInside, mad, median, outlineOf, padHull, ringArea } from './outline';

export const STEP_PX = 8;
export const GRID = 7;
export const MIN_HIT_RATE = 0.6;
export const MIN_POINTS = 3;
export const MAD_K = 3;
export const MIN_SIZE_M = 0.1;
export const REFINE_MS = 3000;

export type PlaceFailure = 'no-photo-shape' | 'missed' | 'layer-not-loaded';

/** A vertical prism: a plan-view ring (x, z) and a height range (local y). */
export interface PrismQuery {
  ring: readonly Vec2[];
  minY: number;
  maxY: number;
}

/** What the projector needs of the point clouds (the app wires @aio/pointcloud here). */
export interface CloudPlaceOps {
  refineAround(focus: PhotoFrustum, timeoutMs: number): Promise<{ depth: number; release(): void }>;
  pointsInPrism(layer: string, prism: PrismQuery): Float32Array;
}

/** What the projector needs of the scene (a `SceneHandle` fits, plus the cloud operations). */
export interface PlaceScene {
  raycastRay(origin: Vector3, dir: Vector3, opts?: RayOptions): Intersection | null;
  rayLayers?(): ReadonlySet<string>;
  cloud?: CloudPlaceOps;
}

/** The points of a cloud finding, before their file is written. */
export interface PendingSelection {
  positions: Float32Array;
  count: number;
  lod: number;
}

export type PlaceResult =
  | { ok: true; sightings: Sighting[]; from: number; hitRate: number; selection?: PendingSelection }
  | { ok: false; reason: PlaceFailure };

export interface PlaceCandidate {
  /** Index of the image or video sighting. */
  index: number;
  cam: SightingCamera;
  ring: Vec2[];
  /** Area in image pixels (the tie-break). */
  area: number;
}

interface Placed {
  sightings: Sighting[];
  hitRate: number;
  selection?: PendingSelection;
}

/** The image and video sightings with a box or polygon and a known camera (masks skipped). */
export function placeCandidates(issue: Issue, src: CameraSources): PlaceCandidate[] {
  const out: PlaceCandidate[] = [];
  issue.sightings.forEach((s, index) => {
    if (s.on !== 'image' && s.on !== 'video') return;
    const cam = sightingCamera(s, src);
    const ring = cam ? outlineOf(cam.geom) : null;
    if (!cam || !ring || ring.length < 3) return;
    out.push({ index, cam, ring, area: ringArea(ring) });
  });
  return out;
}

function rayOf(cam: SightingCamera, px: Vec2): { o: Vector3; d: Vector3 } {
  const r = pixelToWorldRay(cam.pose, cam.lens, px, cam.size);
  return { o: new Vector3(...r.origin), d: new Vector3(...r.dir) };
}

const hitPoint = (h: Intersection): Vec3 => [h.point.x, h.point.y, h.point.z];

function placeMesh(c: PlaceCandidate, layer: string, scene: PlaceScene): Placed | null {
  const samples = densify(c.ring, STEP_PX);
  const points: Vec3[] = [];
  for (const px of samples) {
    const { o, d } = rayOf(c.cam, px);
    const hit = scene.raycastRay(o, d, { layer });
    if (hit) points.push(hitPoint(hit));
  }
  const hitRate = samples.length ? points.length / samples.length : 0;
  if (hitRate < MIN_HIT_RATE || points.length < MIN_POINTS) return null;
  return {
    hitRate,
    sightings: [
      { on: 'mesh', layer, geom: { type: 'spolygon', points }, from: { sighting: c.index } },
    ],
  };
}

/** Half-angle of the cloud search cone: two pixels of the photo. */
const coneOf = (c: PlaceCandidate) => (2 * ((c.cam.lens.hfovDeg * Math.PI) / 180)) / c.cam.size[0];

async function placeCloud(
  c: PlaceCandidate,
  layer: string,
  scene: PlaceScene,
  ops: CloudPlaceOps,
): Promise<Placed | null> {
  const detail = await ops.refineAround(
    photoFrustum(c.cam.pose, c.cam.lens, c.cam.size),
    REFINE_MS,
  );
  try {
    const coneRad = coneOf(c);
    const cast = (px: Vec2) => {
      const { o, d } = rayOf(c.cam, px);
      return scene.raycastRay(o, d, { layer, coneRad });
    };
    const isHit = (h: Intersection | null): h is Intersection => h !== null;
    const grid = gridInside(c.ring, GRID);
    const gridHits = grid.map(cast).filter(isHit);
    const hitRate = grid.length ? gridHits.length / grid.length : 0;
    if (hitRate < MIN_HIT_RATE) return null;
    const hits = [...gridHits, ...densify(c.ring, STEP_PX).map(cast).filter(isHit)];
    // hits far behind the rest saw the background through a gap
    const depths = hits.map((h) => h.distance);
    const mid = median(depths);
    const spread = Math.max(mad(depths, mid), 0.01);
    const kept = hits.filter((h) => Math.abs(h.distance - mid) <= MAD_K * spread);
    if (kept.length < MIN_POINTS) return null;
    const ys = kept.map((h) => h.point.y);
    const base = Math.min(...ys);
    const height = Math.max(Math.max(...ys) - base, MIN_SIZE_M);
    const ring = padHull(
      kept.map((h): Vec2 => [h.point.x, h.point.z]),
      MIN_SIZE_M,
    );
    if (ring.length < MIN_POINTS) return null;
    const points = ring.map(([x, z]): Vec3 => [x, base, z]);
    const positions = ops.pointsInPrism(layer, { ring, minY: base, maxY: base + height });
    const count = Math.floor(positions.length / 3);
    return {
      hitRate,
      sightings: [
        {
          on: 'pointcloud',
          layer,
          geom: { type: 'polygon3', points, height },
          from: { sighting: c.index },
        },
      ],
      ...(count > 0 ? { selection: { positions, count, lod: detail.depth } } : {}),
    };
  } finally {
    detail.release();
  }
}

/** Project the issue's best photo or frame shape onto `layer` (spec section 3). */
export async function placeOnLayer(
  issue: Issue,
  layer: Layer,
  scene: PlaceScene,
  src: CameraSources,
): Promise<PlaceResult> {
  if (layer.kind !== 'mesh' && layer.kind !== 'pointcloud')
    return { ok: false, reason: 'layer-not-loaded' };
  const candidates = placeCandidates(issue, src);
  if (candidates.length === 0) return { ok: false, reason: 'no-photo-shape' };
  if (scene.rayLayers && !scene.rayLayers().has(layer.id))
    return { ok: false, reason: 'layer-not-loaded' };
  const cloud = scene.cloud;
  if (layer.kind === 'pointcloud' && !cloud) return { ok: false, reason: 'layer-not-loaded' };
  let best: { c: PlaceCandidate; r: Placed } | null = null;
  for (const c of candidates) {
    const r =
      layer.kind === 'mesh'
        ? placeMesh(c, layer.id, scene)
        : cloud
          ? await placeCloud(c, layer.id, scene, cloud)
          : null;
    if (!r) continue;
    if (
      !best ||
      r.hitRate > best.r.hitRate ||
      (r.hitRate === best.r.hitRate && c.area > best.c.area)
    )
      best = { c, r };
  }
  if (!best) return { ok: false, reason: 'missed' };
  return {
    ok: true,
    sightings: best.r.sightings,
    from: best.c.index,
    hitRate: best.r.hitRate,
    ...(best.r.selection ? { selection: best.r.selection } : {}),
  };
}

/** The selection sighting once its file is written. */
export function selectionSighting(
  layer: string,
  src: AssetRef,
  sel: PendingSelection,
  from: number,
): Sighting {
  return {
    on: 'pointcloud',
    layer,
    geom: { type: 'selection', src, count: sel.count, lod: sel.lod },
    from: { sighting: from },
  };
}

/** The selection file name (`SelectionName`): issue id and layer id, made safe. */
export function selectionName(issueId: string, layer: string): string {
  return `${issueId}-${layer}`.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 120) || 'selection';
}
