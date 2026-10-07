import type { LensModel, Quat, Vec3 } from '@aio/schema';
import { imageToRay } from '@aio/video';
import { Quaternion, Vector3 } from 'three';

/*
 * The video frame laid on the ground where the camera sees it (Set camera direction): a grid of
 * image points cast onto the ground plane through the lens, then each grid cell drawn as two
 * affine triangles into a canvas covering the footprint's box. Fine enough for the perspective
 * of any drone frame; cells that reach past the horizon are left out.
 */

export type LonLat = [number, number];

/** One grid triangle: image points (0..1) and canvas pixels. */
export interface DrapeTriangle {
  src: [[number, number], [number, number], [number, number]];
  dst: [[number, number], [number, number], [number, number]];
}

export interface DrapeMesh {
  /** Corners of the canvas on the map: top-left, top-right, bottom-right, bottom-left. */
  corners: [LonLat, LonLat, LonLat, LonLat];
  width: number;
  height: number;
  triangles: DrapeTriangle[];
}

export interface DrapeOptions {
  /** Grid cells per side. Default 10. */
  cells?: number;
  /** Ground plane height (local y). Default 0. */
  groundY?: number;
  /** Image points further than this from the camera are dropped. Default 8x the height. */
  maxRange?: number;
  /** Longest canvas edge in pixels. Default 1024. */
  size?: number;
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/**
 * Where each image point of a camera falls on the ground, as a canvas mesh over the map, or null
 * when no part of the frame reaches the ground (looking at the sky).
 */
export function drapeMesh(
  pose: { pos: Vec3; q: Quat },
  lens: LensModel,
  toLonLat: (local: Vec3) => LonLat,
  o: DrapeOptions = {},
): DrapeMesh | null {
  const n = o.cells ?? 10;
  const groundY = o.groundY ?? 0;
  const height = pose.pos[1] - groundY;
  if (!(height > 0.1)) return null;
  const maxRange = o.maxRange ?? Math.min(3000, Math.max(50, height * 8));
  const q = new Quaternion(...pose.q);
  const origin = new Vector3(...pose.pos);
  // ground points of the grid, null past the range or above the horizon
  const grid: (LonLat | null)[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const ray = new Vector3(...imageToRay(lens, i / n, j / n)).applyQuaternion(q);
      let hit: LonLat | null = null;
      if (ray.y < -1e-6) {
        const t = (groundY - origin.y) / ray.y;
        if (t <= maxRange) {
          const p = origin.clone().addScaledVector(ray, t);
          hit = toLonLat([p.x, groundY, p.z]);
        }
      }
      grid.push(hit);
    }
  }
  const pts = grid.filter((p): p is LonLat => p !== null);
  if (pts.length < 3) return null;
  const west = Math.min(...pts.map((p) => p[0]));
  const east = Math.max(...pts.map((p) => p[0]));
  const south = Math.min(...pts.map((p) => p[1]));
  const north = Math.max(...pts.map((p) => p[1]));
  if (!(east > west) || !(north > south)) return null;
  const yN = mercY(north);
  const yS = mercY(south);
  // the canvas keeps the footprint's shape in Web Mercator (what MapLibre stretches it over)
  const aspect = ((east - west) * Math.PI) / 180 / (yN - yS);
  const size = o.size ?? 1024;
  const width = Math.max(2, Math.round(aspect >= 1 ? size : size * aspect));
  const heightPx = Math.max(2, Math.round(aspect >= 1 ? size / aspect : size));
  const px = (p: LonLat): [number, number] => [
    ((p[0] - west) / (east - west)) * width,
    ((yN - mercY(p[1])) / (yN - yS)) * heightPx,
  ];
  const at = (i: number, j: number) => grid[j * (n + 1) + i] ?? null;
  const triangles: DrapeTriangle[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      const u0 = i / n;
      const u1 = (i + 1) / n;
      const v0 = j / n;
      const v1 = (j + 1) / n;
      if (a && b && c)
        triangles.push({
          src: [
            [u0, v0],
            [u1, v0],
            [u1, v1],
          ],
          dst: [px(a), px(b), px(c)],
        });
      if (a && c && d)
        triangles.push({
          src: [
            [u0, v0],
            [u1, v1],
            [u0, v1],
          ],
          dst: [px(a), px(c), px(d)],
        });
    }
  }
  if (!triangles.length) return null;
  return {
    corners: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
    width,
    height: heightPx,
    triangles,
  };
}

/**
 * Draw `image` (width x height pixels) over a drape mesh: each triangle by the affine map of its
 * image corners to its canvas corners, clipped to the triangle grown by half a pixel (no seams).
 */
export function drawDrape(
  g: CanvasRenderingContext2D,
  image: CanvasImageSource,
  imageW: number,
  imageH: number,
  mesh: DrapeMesh,
): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, mesh.width, mesh.height);
  for (const tri of mesh.triangles) {
    const [[u0, v0], [u1, v1], [u2, v2]] = tri.src.map(([u, v]) => [u * imageW, v * imageH]) as [
      [number, number],
      [number, number],
      [number, number],
    ];
    const [[x0, y0], [x1, y1], [x2, y2]] = tri.dst;
    const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (Math.abs(det) < 1e-9) continue;
    // affine x = a u + c v + e, y = b u + d v + f through the three pairs
    const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
    const c = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
    const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
    const d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
    const e = x0 - a * u0 - c * v0;
    const f = y0 - b * u0 - d * v0;
    // grow the clip triangle half a pixel around its centre
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const grow = (x: number, y: number): [number, number] => {
      const l = Math.hypot(x - cx, y - cy) || 1;
      return [x + ((x - cx) / l) * 0.6, y + ((y - cy) / l) * 0.6];
    };
    g.save();
    g.beginPath();
    g.moveTo(...grow(x0, y0));
    g.lineTo(...grow(x1, y1));
    g.lineTo(...grow(x2, y2));
    g.closePath();
    g.clip();
    g.setTransform(a, b, c, d, e, f);
    g.drawImage(image, 0, 0, imageW, imageH);
    g.restore();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}
