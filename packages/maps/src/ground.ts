import type { Vec3 } from '@aio/schema';
import type { FrameProjection } from './geo';
import type { Bbox } from './packs';

/**
 * Lon/lat box covering a square of `halfSize` metres around the local origin (all four corners
 * converted, so UTM grid convergence is included).
 */
export function siteBbox(proj: FrameProjection, halfSize: number): Bbox {
  const corners: Vec3[] = [
    [-halfSize, 0, -halfSize],
    [halfSize, 0, -halfSize],
    [halfSize, 0, halfSize],
    [-halfSize, 0, halfSize],
  ];
  const ll = corners.map((c) => proj.toLonLat(c));
  return [
    Math.min(...ll.map((p) => p[0])),
    Math.min(...ll.map((p) => p[1])),
    Math.max(...ll.map((p) => p[0])),
    Math.max(...ll.map((p) => p[1])),
  ];
}

/**
 * Local-frame corners (tl, tr, br, bl) of a north-up lon/lat image covering `bbox`, for draping a
 * rendered map image as a ground quad at height `y`.
 */
export function groundCorners(bbox: Bbox, proj: FrameProjection, y = 0): [Vec3, Vec3, Vec3, Vec3] {
  const [w, s, e, n] = bbox;
  const at = (lon: number, lat: number): Vec3 => {
    const [x, , z] = proj.toLocal(lon, lat);
    return [x, y, z];
  };
  return [at(w, n), at(e, n), at(e, s), at(w, s)];
}
