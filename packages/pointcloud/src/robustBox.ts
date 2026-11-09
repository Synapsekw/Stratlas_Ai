import { Box3, Vector3 } from 'three';
import type { ChunkSeed } from './manager';

type Axis = 0 | 1 | 2;
interface Span {
  a: number;
  b: number;
  w: number;
}
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
  const leaves = seeds.filter((s) => s.points > 0 && (s.children?.length ?? 0) === 0);
  const total = leaves.reduce((n, s) => n + s.points, 0);
  if (leaves.length < 1 || total <= 0) return header.clone();
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const axis of AXES) {
    // each node spreads its points evenly over its own extent: the cut falls inside a coarse
    // node at the share it asks for, not at the node's far wall
    const spans = leaves.map((s) => ({
      a: s.bounds.min[axis],
      b: s.bounds.max[axis],
      w: s.points,
    }));
    lo[axis] = quantile(spans, total, trim);
    hi[axis] = quantile(spans, total, 1 - trim);
  }
  if (![...lo, ...hi].every(Number.isFinite)) return header.clone();
  const box = new Box3(new Vector3(...lo), new Vector3(...hi));
  box.min.max(header.min);
  box.max.min(header.max);
  return box.isEmpty() ? header.clone() : box;
}

/** The coordinate below which `share` of the points lie, each span's points spread evenly. */
function quantile(spans: readonly Span[], total: number, share: number): number {
  const cdf = (x: number) => {
    let n = 0;
    for (const s of spans) {
      const len = s.b - s.a;
      n += s.w * (len > 0 ? Math.min(1, Math.max(0, (x - s.a) / len)) : x >= s.a ? 1 : 0);
    }
    return n / total;
  };
  let from = Math.min(...spans.map((s) => s.a));
  let to = Math.max(...spans.map((s) => s.b));
  for (let i = 0; i < 48; i++) {
    const mid = (from + to) / 2;
    if (cdf(mid) < share) from = mid;
    else to = mid;
  }
  return (from + to) / 2;
}
