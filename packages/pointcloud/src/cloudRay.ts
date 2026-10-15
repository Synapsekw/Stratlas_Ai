/**
 * Point clouds as `raycastRay` content (findings on a model): a cone around the ray over the
 * loaded chunks of one layer, respecting the section planes and the hidden classes as
 * `pickPoint` does, and the points inside a prism for a finding's selection.
 */
import type { RayProvider, SceneHandle } from '@aio/engine';
import { Sphere, Vector3, type Intersection, type Points } from 'three';
import { getCloudManager } from './adapter';
import { drawnPoints } from './pick';
import { pointsInPrismOf, raycastPoints, type Prism, type RayChunk } from './rayMath';

const world = new Vector3();
const bound = new Sphere();

function chunksOf(
  handle: SceneHandle,
  layerId: string,
  drawnOnly: boolean,
): { chunks: RayChunk[]; objects: Points[] } {
  const layer = getCloudManager(handle)?.layers.get(layerId);
  const chunks: RayChunk[] = [];
  const objects: Points[] = [];
  if (!layer?.visible) return { chunks, objects };
  const planes = handle.clippingPlanes;
  for (const c of layer.chunks) {
    const obj = c.object;
    if (!obj) continue;
    obj.updateMatrixWorld();
    const drawn = drawnOnly ? drawnPoints(obj) : undefined;
    if (drawn === false) continue;
    const m = obj.matrixWorld;
    const keep =
      drawnOnly && (planes.length > 0 || drawn)
        ? (x: number, y: number, z: number, i: number) => {
            if (drawn && !drawn(i)) return false;
            if (!planes.length) return true;
            world.set(x, y, z).applyMatrix4(m);
            return planes.every((p) => p.distanceToPoint(world) >= 0);
          }
        : undefined;
    const spacing = c.spacing ?? layer.baseSize / 2 ** c.lod;
    // the chunk's bounding sphere in the local frame lets a ray skip it without a scan
    if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
    const bs = obj.geometry.boundingSphere;
    let sphere: RayChunk['sphere'];
    if (bs) {
      bound.copy(bs).applyMatrix4(m);
      sphere = { center: [bound.center.x, bound.center.y, bound.center.z], radius: bound.radius };
    }
    chunks.push({
      positions: obj.geometry.getAttribute('position').array,
      matrix: m.elements,
      floor: spacing * 0.75,
      ...(keep ? { keep } : {}),
      ...(sphere ? { sphere } : {}),
    });
    objects.push(obj);
  }
  return { chunks, objects };
}

export function cloudRayProvider(handle: SceneHandle): RayProvider {
  return {
    layers: () => {
      const m = getCloudManager(handle);
      if (!m) return [];
      return [...m.layers.values()].filter((l) => l.visible && l.loaded.size > 0).map((l) => l.id);
    },
    cast: (origin, dir, layer, opts) => {
      const { chunks, objects } = chunksOf(handle, layer, true);
      const hit = raycastPoints(
        { origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z] },
        chunks,
        { coneRad: opts.coneRad ?? 0.002 },
      );
      const object = hit ? objects[hit.chunk] : undefined;
      if (!hit || !object) return null;
      const out: Intersection = {
        distance: hit.t,
        point: new Vector3(...hit.point),
        object,
        index: hit.index,
      };
      return out;
    },
  };
}

/** The loaded points of a cloud layer inside a prism (local frame xyz triples). */
export function pointsInPrism(handle: SceneHandle, layer: string, prism: Prism): Float32Array {
  return pointsInPrismOf(chunksOf(handle, layer, false).chunks, prism);
}
