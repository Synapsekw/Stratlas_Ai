import type { SceneHandle } from '@aio/engine';
import { Matrix4, Ray, Vector3, type Plane, type Points } from 'three';
import { getCloudManager } from './adapter';
import { nearestProjected } from './pickMath';

export interface PointPick {
  /** World position (local frame, metres). */
  point: Vector3;
  /** Camera to point distance, metres (three.js Intersection compatible). */
  distance: number;
  layerId: string;
  /** Index of the point within its chunk. */
  index: number;
  object: Points;
}

const mvp = new Matrix4();
const world = new Vector3();

/**
 * Nearest visible point to normalised device coordinates within `radiusPx` CSS pixels:
 * the front-most point inside the radius, skipping points cut by `renderer.clippingPlanes`.
 */
export function pickPoint(
  handle: SceneHandle,
  ndc: { x: number; y: number },
  radiusPx = 6,
): PointPick | null {
  const manager = getCloudManager(handle);
  if (!manager) return null;
  const cam = handle.camera;
  cam.updateMatrixWorld();
  const el = (handle.renderer as { domElement?: { clientWidth: number; clientHeight: number } })
    .domElement;
  const w = Math.max(1, el?.clientWidth ?? 1);
  const h = Math.max(1, el?.clientHeight ?? 1);
  const rx = (2 * radiusPx) / w;
  const ry = (2 * radiusPx) / h;
  const planes: readonly Plane[] =
    (handle.renderer as { clippingPlanes?: Plane[] }).clippingPlanes ?? [];

  // ray through the cursor, to cull chunks whose bounding sphere is far from it
  const origin = cam.getWorldPosition(new Vector3());
  const dir = new Vector3(ndc.x, ndc.y, 0.5).unproject(cam).sub(origin).normalize();
  const ray = new Ray(origin, dir);
  const pxAngle = (2 * Math.tan((cam.fov * Math.PI) / 360) * radiusPx) / h;

  let best: { depth: number; obj: Points; index: number; layerId: string } | null = null;
  for (const layer of manager.layers.values()) {
    if (!layer.visible) continue;
    for (const c of layer.chunks) {
      const obj = c.object;
      if (!obj) continue;
      obj.updateMatrixWorld();
      const sphere = obj.geometry.boundingSphere;
      if (sphere) {
        const s = sphere.clone().applyMatrix4(obj.matrixWorld);
        const along = Math.max(0, s.center.clone().sub(origin).dot(dir));
        if (ray.distanceToPoint(s.center) > s.radius + along * pxAngle * 2) continue;
      }
      mvp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(obj.matrixWorld);
      const m = obj.matrixWorld;
      const keep = planes.length
        ? (x: number, y: number, z: number) => {
            world.set(x, y, z).applyMatrix4(m);
            return planes.every((p) => p.distanceToPoint(world) >= 0);
          }
        : undefined;
      const pos = obj.geometry.getAttribute('position').array;
      const hit = nearestProjected(pos, pos.length / 3, mvp.elements, ndc.x, ndc.y, rx, ry, keep);
      if (hit && (!best || hit.depth < best.depth)) {
        best = { depth: hit.depth, obj, index: hit.index, layerId: layer.id };
      }
    }
  }
  if (!best) return null;
  const pos = best.obj.geometry.getAttribute('position');
  const point = new Vector3(pos.getX(best.index), pos.getY(best.index), pos.getZ(best.index));
  point.applyMatrix4(best.obj.matrixWorld);
  return {
    point,
    distance: point.distanceTo(origin),
    layerId: best.layerId,
    index: best.index,
    object: best.obj,
  };
}
