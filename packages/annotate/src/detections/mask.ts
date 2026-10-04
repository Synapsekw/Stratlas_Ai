import type { Vec2 } from '@aio/schema';
import type { Polygon } from './geometry';

/*
 * Mask assist (BLD-10, optional): a SAM-class model turns a box drawn by the reviewer into an
 * outline. The model runs in the main process through onnxruntime only when the pipeline pack
 * carries a model (none is shipped: licences); this module holds the model-free parts, so the
 * seam is tested without one: the binary mask a decoder returns becomes a polygon here.
 */

/** Availability of mask assist on this workstation. */
export type MaskAssistStatus =
  | { available: true; model: string }
  | { available: false; reason: 'no-model' | 'no-runtime' | 'failed'; detail?: string };

/** A binary mask on a grid (row major, 1 byte per cell, non-zero is inside). */
export interface BinaryMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Keep only the largest 4-connected region of the mask. */
export function largestRegion(mask: BinaryMask): BinaryMask {
  const { width: W, height: H, data } = mask;
  const label = new Int32Array(W * H);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!data[i] || label[i]) continue;
    next += 1;
    let size = 0;
    label[i] = next;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop() ?? 0;
      size += 1;
      const x = p % W;
      const y = (p - x) / W;
      const visit = (q: number) => {
        if (data[q] && !label[q]) {
          label[q] = next;
          stack.push(q);
        }
      };
      if (x > 0) visit(p - 1);
      if (x < W - 1) visit(p + 1);
      if (y > 0) visit(p - W);
      if (y < H - 1) visit(p + W);
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  const out = new Uint8Array(W * H);
  if (best) for (let i = 0; i < W * H; i++) out[i] = label[i] === best ? 1 : 0;
  return { width: W, height: H, data: out };
}

// Clockwise neighbours in image coordinates (y down), starting west.
const DIRS: readonly Vec2[] = [
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
];

/** Outer boundary of the region as cell centres, clockwise (Moore neighbour tracing). */
export function traceBoundary(mask: BinaryMask): Vec2[] {
  const { width: W, height: H, data } = mask;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && !!data[y * W + x];
  let start = -1;
  for (let i = 0; i < W * H; i++) {
    if (data[i]) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const sx = start % W;
  const sy = (start - sx) / W;
  const out: Vec2[] = [[sx, sy]];
  let cx = sx;
  let cy = sy;
  // the cell west of the first one is outside (raster order)
  let back = 0;
  const limit = 4 * W * H + 8;
  for (let n = 0; n < limit; n++) {
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const idx = (back + k) % 8;
      const d = DIRS[idx];
      if (!d) continue;
      const nx = cx + d[0];
      const ny = cy + d[1];
      if (!inside(nx, ny)) continue;
      const prev = DIRS[(back + k - 1) % 8] ?? [0, 0];
      const bx = cx + prev[0] - nx;
      const by = cy + prev[1] - ny;
      back = DIRS.findIndex(([x, y]) => x === bx && y === by);
      if (back < 0) back = 0;
      cx = nx;
      cy = ny;
      moved = true;
      break;
    }
    if (!moved) break; // a single cell
    if (cx === sx && cy === sy) break;
    out.push([cx, cy]);
  }
  return out;
}

function perpendicular(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Ramer-Douglas-Peucker on an open polyline. */
export function simplify(points: readonly Vec2[], epsilon: number): Vec2[] {
  if (points.length < 3) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [...points];
  let index = 0;
  let max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (!p) continue;
    const d = perpendicular(p, first, last);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [first, last];
  const left = simplify(points.slice(0, index + 1), epsilon);
  const right = simplify(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

/**
 * The outline of a mask's largest region as an image polygon. The mask grid may be smaller than
 * the image (a decoder's low-resolution mask): `size` scales it. Null when nothing is inside or
 * the region is too small for three corners.
 */
export function maskToPolygon(
  mask: BinaryMask,
  size: { width: number; height: number },
  epsilonCells = 1,
): Polygon | null {
  const region = largestRegion(mask);
  const ring = traceBoundary(region);
  if (ring.length < 3) return null;
  // split the closed ring at its far point so RDP keeps both halves
  const first = ring[0] ?? [0, 0];
  let far = 0;
  let farD = -1;
  ring.forEach((p, i) => {
    const d = Math.hypot(p[0] - first[0], p[1] - first[1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  });
  const a = simplify(ring.slice(0, far + 1), epsilonCells);
  const b = simplify([...ring.slice(far), first], epsilonCells);
  const pts = [...a.slice(0, -1), ...b.slice(0, -1)];
  if (pts.length < 3) return null;
  const sx = size.width / mask.width;
  const sy = size.height / mask.height;
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    type: 'polygon',
    points: pts.map(([x, y]): Vec2 => [r((x + 0.5) * sx), r((y + 0.5) * sy)]),
  };
}
