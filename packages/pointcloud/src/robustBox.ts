import { Box3, Vector3 } from 'three';
import type { ChunkSeed } from './manager';

type Axis = 0 | 1 | 2;
const AXES: readonly Axis[] = [0, 1, 2];

/**
 * A framing box for a cloud that lidar outliers stretch: the box of the octree's finest known
 * nodes, once the nodes that hold the outermost `trim` share of the points on each axis are left
 * out. The header box of a confined-space scan can be five times the chamber, so framing on it
 * shows the chamber as a speck. Reads only the hierarchy page already loaded (point counts and
 * node boxes), never the points. Falls back to `header` when the page says too little, and never
 * returns more than `header`. Local frame, like the seeds.
 */
export function robustCloudBox(seeds: readonly ChunkSeed[], header: Box3, trim: number): Box3 {
  const leaves = seeds.filter((s) => s.points > 0 && s.children.length === 0);
  const total = leaves.reduce((n, s) => n + s.points, 0);
  if (leaves.length < 1 || total <= 0) return header.clone();
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const axis of AXES) {
    const centre = (s: ChunkSeed) => (s.bounds.min[axis] + s.bounds.max[axis]) / 2;
    const sorted = [...leaves].sort((a, b) => centre(a) - centre(b));
    let before = 0;
    for (const s of sorted) {
      // keep a node unless it lies wholly inside the trimmed share at either end
      const from = before / total;
      const to = (before + s.points) / total;
      before += s.points;
      if (to <= trim || from >= 1 - trim) continue;
      lo[axis] = Math.min(lo[axis], s.bounds.min[axis]);
      hi[axis] = Math.max(hi[axis], s.bounds.max[axis]);
    }
  }
  if (![...lo, ...hi].every(Number.isFinite)) return header.clone();
  const box = new Box3(new Vector3(...lo), new Vector3(...hi));
  box.min.max(header.min);
  box.max.min(header.max);
  return box.isEmpty() ? header.clone() : box;
}
