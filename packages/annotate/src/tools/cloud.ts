import type { SceneHandle } from '@aio/engine';
import type { Sighting, Vec3 } from '@aio/schema';
import { layerOf } from '../crossview/backproject';

/**
 * Point-cloud sightings (ANN-4). Points are placed with `SceneHandle.raycast`, which includes
 * point clouds; @aio/pointcloud does not export a `pickPoint` yet (seam for stream S4).
 */
export type CloudSighting = Extract<Sighting, { on: 'pointcloud' }>;

export function cloudPointSighting(layer: string, p: Vec3): CloudSighting {
  return { on: 'pointcloud', layer, geom: { type: 'point3', p } };
}

/** Axis-aligned box region from two picked corners, grown by `pad` metres on every side. */
export function cloudBoxSighting(layer: string, a: Vec3, b: Vec3, pad = 0): CloudSighting {
  const min: Vec3 = [
    Math.min(a[0], b[0]) - pad,
    Math.min(a[1], b[1]) - pad,
    Math.min(a[2], b[2]) - pad,
  ];
  const max: Vec3 = [
    Math.max(a[0], b[0]) + pad,
    Math.max(a[1], b[1]) + pad,
    Math.max(a[2], b[2]) + pad,
  ];
  return { on: 'pointcloud', layer, geom: { type: 'box3', min, max } };
}

/** Prism region: a ground polygon (XZ) extruded `height` metres up from its lowest vertex. */
export function cloudPolygonSighting(
  layer: string,
  points: readonly Vec3[],
  height?: number,
): CloudSighting {
  const geom: CloudSighting['geom'] =
    height === undefined
      ? { type: 'polygon3', points: [...points] }
      : { type: 'polygon3', points: [...points], height };
  return { on: 'pointcloud', layer, geom };
}

/** Indices of points (xyz triples) inside an axis-aligned box. */
export function pointsInBox(positions: Float32Array, box: { min: Vec3; max: Vec3 }): number[] {
  const out: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3] ?? 0;
    const y = positions[i * 3 + 1] ?? 0;
    const z = positions[i * 3 + 2] ?? 0;
    if (
      x >= box.min[0] &&
      x <= box.max[0] &&
      y >= box.min[1] &&
      y <= box.max[1] &&
      z >= box.min[2] &&
      z <= box.max[2]
    ) {
      out.push(i);
    }
  }
  return out;
}

function insideXZ(x: number, z: number, ring: readonly Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a[2] > z !== b[2] > z && x < ((b[0] - a[0]) * (z - a[2])) / (b[2] - a[2]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** Indices of points inside a ground polygon (XZ), optionally limited to a height band. */
export function pointsInPolygon(
  positions: Float32Array,
  ring: readonly Vec3[],
  height?: number,
): number[] {
  const base = Math.min(...ring.map((p) => p[1]));
  const out: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3] ?? 0;
    const y = positions[i * 3 + 1] ?? 0;
    const z = positions[i * 3 + 2] ?? 0;
    if (height !== undefined && (y < base || y > base + height)) continue;
    if (insideXZ(x, z, ring)) out.push(i);
  }
  return out;
}

/** Pick a point-cloud point under the cursor (NDC). Null when the hit is not a cloud. */
export function pickCloudPoint(
  handle: Pick<SceneHandle, 'raycast'>,
  ndcX: number,
  ndcY: number,
): { layer: string; p: Vec3 } | null {
  const hit = handle.raycast(ndcX, ndcY);
  if (!hit || !(hit.object as { isPoints?: boolean }).isPoints) return null;
  return { layer: layerOf(hit.object), p: [hit.point.x, hit.point.y, hit.point.z] };
}
