/**
 * Loaded points the materials draw (the Clean up panel's "N loaded points selected", the e2e
 * checks): every loaded chunk of the visible layers, or of one layer, through `drawnPoints`, the
 * shared section planes and an optional test in the local frame.
 */
import type { SceneHandle } from '@aio/engine';
import { Vector3, type Plane } from 'three';
import { getCloudManager } from '../adapter';
import { drawnPoints } from '../pick';

const p = new Vector3();

export function countDrawn(
  handle: SceneHandle,
  layerId?: string,
  inside?: (x: number, y: number, z: number) => boolean,
): { drawn: number; loaded: number } {
  const manager = getCloudManager(handle);
  let drawn = 0;
  let loaded = 0;
  if (!manager) return { drawn, loaded };
  const planes: readonly Plane[] = handle.clippingPlanes;
  for (const layer of manager.layers.values()) {
    if (!layer.visible || (layerId !== undefined && layer.id !== layerId)) continue;
    for (const c of layer.loaded) {
      const obj = c.object;
      if (!obj) continue;
      const pos = obj.geometry.getAttribute('position');
      loaded += pos.count;
      const d = drawnPoints(obj);
      if (d === false) continue;
      obj.updateMatrixWorld();
      for (let i = 0; i < pos.count; i++) {
        if (d && !d(i)) continue;
        if (planes.length || inside) {
          p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(obj.matrixWorld);
          if (!planes.every((pl) => pl.distanceToPoint(p) >= 0)) continue;
          if (inside && !inside(p.x, p.y, p.z)) continue;
        }
        drawn++;
      }
    }
  }
  return { drawn, loaded };
}
