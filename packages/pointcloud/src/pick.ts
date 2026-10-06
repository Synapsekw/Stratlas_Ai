import type { SceneHandle } from '@aio/engine';
import { Matrix4, Ray, Vector3, type BufferAttribute, type Plane, type Points } from 'three';
import { getCloudManager } from './adapter';
import { CLASS_SLOTS, MODE_INDEX, type PointMaterial } from './material';
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
  /** The change cloud's value at the point (cloud change: distance, metres). */
  scalar?: number;
}

const mvp = new Matrix4();
const world = new Vector3();

/**
 * Which points of a chunk its material draws, as the vertex shader decides (material.ts): not
 * those of a hidden class and, coloured by change, not those under the change threshold, and none
 * of a cloud without the change field while a change cloud shows. `false` when no point is drawn,
 * `undefined` when every point is.
 */
export function drawnPoints(obj: Points): ((index: number) => boolean) | false | undefined {
  // a chunk drawn with another material (none in the app) shows every point
  const material = obj.material as
    | { uniforms?: Partial<PointMaterial['uniforms']>; defines?: Record<string, unknown> }
    | undefined;
  const u = material?.uniforms;
  if (!u?.uMode || !u.uClassShown || !u.uThreshold || !u.uHideNoScalar) return undefined;
  const defines = material?.defines ?? {};
  const hasClass = 'HAS_CLASS' in defines;
  const hasScalar = 'HAS_SCALAR' in defines;
  const cls = obj.geometry.getAttribute('aClass') as BufferAttribute | undefined;
  const scalar = obj.geometry.getAttribute('aScalar') as BufferAttribute | undefined;
  const shown = u.uClassShown.value;
  const change = u.uMode.value === MODE_INDEX.change;
  if (change && !hasScalar && u.uHideNoScalar.value > 0.5) return false;
  // without the class field every point is unclassified (1)
  if (!hasClass && (shown[1] ?? 1) < 0.5) return false;
  const byClass = hasClass && shown.some((v) => v < 0.5);
  const threshold = change && hasScalar ? u.uThreshold.value : 0;
  if (!byClass && threshold <= 0) return undefined;
  return (i) => {
    if (byClass) {
      const c = Math.round(Math.min(cls?.getX(i) ?? 0, CLASS_SLOTS - 1));
      if ((shown[c] ?? 1) < 0.5) return false;
    }
    return threshold <= 0 || Math.abs(scalar?.getX(i) ?? 0) >= threshold;
  };
}

/**
 * Nearest visible point to normalised device coordinates within `radiusPx` CSS pixels:
 * the front-most point inside the radius, skipping points cut by the shared section planes and
 * points the material does not draw (a hidden class, under the change threshold).
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
  const planes: readonly Plane[] = handle.clippingPlanes;

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
      const drawn = drawnPoints(obj);
      if (drawn === false) continue;
      mvp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(obj.matrixWorld);
      const m = obj.matrixWorld;
      // only points that are drawn: inside the section planes and shown by the material
      const keep =
        planes.length || drawn
          ? (x: number, y: number, z: number, i: number) => {
              if (drawn && !drawn(i)) return false;
              if (!planes.length) return true;
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
  const out: PointPick = {
    point,
    distance: point.distanceTo(origin),
    layerId: best.layerId,
    index: best.index,
    object: best.obj,
  };
  const scalar = best.obj.geometry.getAttribute('aScalar') as BufferAttribute | undefined;
  if (scalar) out.scalar = scalar.getX(best.index);
  return out;
}
