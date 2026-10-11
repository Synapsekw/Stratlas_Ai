import type { Vec3 } from '@aio/schema';
import type { FrameProjection } from './geo';
import type { Bbox } from './packs';

/** A rectangle of the local frame (x east, z south), metres. */
export interface GroundExtent {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Lon/lat box covering a square of `halfSize` metres around the local origin (all four corners
 * converted, so UTM grid convergence is included).
 */
export function siteBbox(proj: FrameProjection, halfSize: number): Bbox {
  return extentBbox(proj, { minX: -halfSize, maxX: halfSize, minZ: -halfSize, maxZ: halfSize });
}

/** Lon/lat box covering a rectangle of the local frame (all four corners converted). */
export function extentBbox(proj: FrameProjection, e: GroundExtent): Bbox {
  const corners: Vec3[] = [
    [e.minX, 0, e.minZ],
    [e.maxX, 0, e.minZ],
    [e.maxX, 0, e.maxZ],
    [e.minX, 0, e.maxZ],
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

/** One ring of the street ground: triangles in the local frame and their place in the picture. */
export interface RingGeometry {
  /** x, y, z per vertex. */
  positions: Float32Array;
  /** u, v per vertex: (0, 1) is the picture's top left (north west) corner. */
  uvs: Float32Array;
  indices: number[];
}

/** Web Mercator y of a latitude in degrees. */
function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

const QUAD = [0, 3, 1, 1, 3, 2];
/** North, east, south and west sides between the picture's corners (0 to 3) and the hole's (4 to 7). */
const FRAME = [0, 4, 1, 1, 4, 5, 5, 6, 1, 1, 6, 2, 7, 3, 6, 6, 3, 2, 0, 3, 4, 4, 3, 7];

/**
 * The ground under a north-up Web Mercator picture of `bbox`, at height `y`: one quad, or with
 * `hole` (the box of the ring inside it) a frame around that box, so nested rings never overlap.
 * Vertices are the corners (top left, top right, bottom right, bottom left) of the picture, then
 * of the hole. Each takes its place in the picture from its longitude and its Mercator latitude,
 * so the frame's inner edge shows the same ground as the edge of the ring inside it. A hole that
 * reaches outside the picture is cut to it.
 */
export function ringGeometry(
  bbox: Bbox,
  hole: Bbox | null,
  proj: FrameProjection,
  y = 0,
): RingGeometry {
  const [w, s, e, n] = bbox;
  const south = mercatorY(s);
  const height = mercatorY(n) - south;
  const positions: number[] = [];
  const uvs: number[] = [];
  const corners = ([bw, bs, be, bn]: Bbox) => {
    for (const [lon, lat] of [
      [bw, bn],
      [be, bn],
      [be, bs],
      [bw, bs],
    ] as const) {
      const [x, , z] = proj.toLocal(lon, lat);
      positions.push(x, y, z);
      uvs.push((lon - w) / (e - w), (mercatorY(lat) - south) / height);
    }
  };
  corners(bbox);
  if (hole)
    corners([
      Math.min(e, Math.max(w, hole[0])),
      Math.min(n, Math.max(s, hole[1])),
      Math.max(w, Math.min(e, hole[2])),
      Math.max(s, Math.min(n, hole[3])),
    ]);
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: [...(hole ? FRAME : QUAD)],
  };
}
