import { hasPos } from '@aio/engine';
import { correctPos, photoCorrection } from '@aio/geo';
import {
  shiftCorners,
  shiftLocal,
  type Layer,
  type OrientationFile,
  type ProjectManifest,
  type Vec3,
} from '@aio/schema';
import { dateShiftOf } from '@aio/workspace';

/** An axis-aligned box in the local frame (x east, y up, z south), metres. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface BoundsDeps {
  manifest: ProjectManifest;
  orientation: OrientationFile | null;
  /** The box of the scene objects tagged with the layer, when the 3D view has drawn them. */
  sceneBox(layerId: string): Box | null;
  /** What main reads from the files (`layer:info` extent), or null. */
  fileExtent(layerId: string): Promise<Box | null>;
  /** Height of the layer's surface straight down at (x, z) in the 3D view, or null. */
  rayDown(x: number, z: number, layerId: string): number | null;
}

export function boxOfPoints(points: readonly Vec3[]): Box | null {
  if (points.length === 0) return null;
  const lo = (k: 0 | 1 | 2) => Math.min(...points.map((p) => p[k]));
  const hi = (k: 0 | 1 | 2) => Math.max(...points.map((p) => p[k]));
  return { min: [lo(0), lo(1), lo(2)], max: [hi(0), hi(1), hi(2)] };
}

export function unionBox(boxes: readonly (Box | null)[]): Box | null {
  return boxOfPoints(boxes.flatMap((b) => (b ? [b.min, b.max] : [])));
}

/** A box at least `2 * half` metres across on each axis, around the same centre. */
export function padBox(b: Box, half = 5): Box {
  const out: Box = { min: [...b.min], max: [...b.max] };
  for (const k of [0, 1, 2] as const) {
    const c = (b.min[k] + b.max[k]) / 2;
    const h = Math.max(half, (b.max[k] - b.min[k]) / 2);
    out.min[k] = c - h;
    out.max[k] = c + h;
  }
  return out;
}

const layerOf = (m: ProjectManifest, id: string) => m.layers.find((l) => l.id === id);

/** Whether a dataset can have a place (for submenus that must be built at once). */
export function knowsWhere(l: Layer): boolean {
  switch (l.kind) {
    case 'mesh':
    case 'pointcloud':
    case 'raster':
    case 'vector':
      return true;
    case 'panoramas':
    case 'photos':
      return l.items.some(hasPos);
    case 'walk':
      // pins alone are no place: the fitted path (`flight`) is written once a placement is saved
      return l.flight !== undefined;
    default:
      return false;
  }
}

export async function layerBounds(layerId: string, deps: BoundsDeps): Promise<Box | null> {
  const l = layerOf(deps.manifest, layerId);
  if (!l) return null;
  // scene boxes and file extents are already where the date lines up; what is read here is not
  const shift = dateShiftOf(deps.manifest, l.id);
  switch (l.kind) {
    case 'mesh':
    case 'pointcloud':
      return deps.sceneBox(l.id) ?? deps.fileExtent(l.id);
    case 'photos':
      return boxOfPoints(
        l.items.flatMap((p) =>
          p.pos
            ? [shiftLocal(correctPos(p.pos, photoCorrection(deps.orientation, l.id, p.id)), shift)]
            : [],
        ),
      );
    case 'panoramas':
      return boxOfPoints(l.items.flatMap((p) => (p.pos ? [shiftLocal(p.pos, shift)] : [])));
    case 'raster': {
      if (l.corners) {
        const { tl, tr, bl } = shiftCorners(l.corners, shift);
        return boxOfPoints([
          tl,
          tr,
          bl,
          [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]],
        ]);
      }
      return deps.fileExtent(l.id);
    }
    case 'vector':
    case 'walk':
      return deps.fileExtent(l.id);
    default:
      return null;
  }
}

export async function boundsOf(layerIds: readonly string[], deps: BoundsDeps): Promise<Box | null> {
  return unionBox(await Promise.all(layerIds.map((id) => layerBounds(id, deps))));
}

/**
 * The target ground of Align to: where a DSM covers (x, z), the DSM's surface straight down in the
 * 3D view (nothing else in the scene counts); else null.
 */
export async function groundAt(x: number, z: number, deps: BoundsDeps): Promise<number | null> {
  for (const l of deps.manifest.layers) {
    if (l.kind !== 'raster' || l.role !== 'dsm') continue;
    const b = await layerBounds(l.id, deps);
    if (!b || x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) continue;
    const y = deps.rayDown(x, z, l.id);
    if (y !== null) return y;
  }
  return null;
}
