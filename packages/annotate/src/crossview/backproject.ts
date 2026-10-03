import type { ImageGeom, LensModel, Sighting, Vec2, Vec3 } from '@aio/schema';
import type { SceneHandle } from '@aio/engine';
import { Raycaster, Vector3, type Object3D } from 'three';
import { pixelToWorldRay, type CameraPose } from './lens';

export type MeshSighting = Extract<Sighting, { on: 'mesh' }>;

/** Layer id used for sightings that land on the ground plane rather than a mesh layer. */
export const GROUND_LAYER = 'ground';

/** What back-projection needs from the scene: the meshes that receive projections. */
export type RaySurface = Pick<SceneHandle, 'projectionReceivers'>;

/** Pixel centre of an image or frame geometry (null for masks, whose extent is unknown here). */
export function geomCenter(g: ImageGeom): Vec2 | null {
  switch (g.type) {
    case 'box':
    case 'rotbox':
      return [g.x + g.w / 2, g.y + g.h / 2];
    case 'point':
      return [g.x, g.y];
    case 'polygon': {
      let x = 0;
      let y = 0;
      for (const p of g.points) {
        x += p[0];
        y += p[1];
      }
      return [x / g.points.length, y / g.points.length];
    }
    case 'mask':
      return null;
  }
}

/** The mesh layer an object belongs to: the nearest `userData.layerId` up the tree. */
export function layerOf(obj: Object3D): string {
  let o: Object3D | null = obj;
  while (o) {
    const id = (o.userData as { layerId?: unknown }).layerId;
    if (typeof id === 'string' && id) return id;
    o = o.parent;
  }
  return GROUND_LAYER;
}

interface Hit {
  layer: string;
  p: Vec3;
  n: Vec3;
  face?: number;
}

function castRay(origin: Vec3, dir: Vec3, surface: RaySurface): Hit | null {
  const rc = new Raycaster(new Vector3(...origin), new Vector3(...dir).normalize());
  const hits = rc.intersectObjects([...surface.projectionReceivers()], true);
  const hit = hits[0];
  if (hit) {
    const n = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new Vector3(-dir[0], -dir[1], -dir[2]).normalize();
    const out: Hit = {
      layer: layerOf(hit.object),
      p: [hit.point.x, hit.point.y, hit.point.z],
      n: [n.x, n.y, n.z],
    };
    if (hit.faceIndex !== undefined && hit.faceIndex !== null) out.face = hit.faceIndex;
    return out;
  }
  // Ground plane y = 0 (data-conventions section 1: Y up).
  if (dir[1] >= -1e-9 || origin[1] <= 0) return null;
  const t = -origin[1] / dir[1];
  return {
    layer: GROUND_LAYER,
    p: [origin[0] + dir[0] * t, 0, origin[2] + dir[2] * t],
    n: [0, 1, 0],
  };
}

/**
 * ANN-9: the ray from the camera pose through an image pixel, cast against the meshes and the
 * ground, as a mesh sighting (surface point). Null when the ray hits nothing.
 */
export function backProject(
  pose: CameraPose,
  lens: LensModel,
  pixel: Vec2,
  imageSize: Vec2,
  handle: RaySurface,
): MeshSighting | null {
  const ray = pixelToWorldRay(pose, lens, pixel, imageSize);
  const hit = castRay(ray.origin, ray.dir, handle);
  if (!hit) return null;
  const geom: MeshSighting['geom'] =
    hit.face === undefined
      ? { type: 'spoint', p: hit.p, n: hit.n }
      : { type: 'spoint', p: hit.p, n: hit.n, face: hit.face };
  return { on: 'mesh', layer: hit.layer, geom };
}

/** Back-project an outline (polygon or box corners) into a surface polygon; null if any misses. */
export function backProjectOutline(
  pose: CameraPose,
  lens: LensModel,
  outline: readonly Vec2[],
  imageSize: Vec2,
  handle: RaySurface,
): MeshSighting | null {
  const pts: Vec3[] = [];
  let layer: string | null = null;
  for (const px of outline) {
    const ray = pixelToWorldRay(pose, lens, px, imageSize);
    const hit = castRay(ray.origin, ray.dir, handle);
    if (!hit) return null;
    layer ??= hit.layer;
    pts.push(hit.p);
  }
  if (pts.length < 3 || !layer) return null;
  return { on: 'mesh', layer, geom: { type: 'spolygon', points: pts } };
}
