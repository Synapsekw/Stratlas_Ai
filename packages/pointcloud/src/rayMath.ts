/**
 * Ray and prism queries over point positions (findings on a model). Pure: no three.js. Positions
 * are xyz triples in chunk coordinates; `matrix` maps them to the local frame.
 */
type V3 = readonly [number, number, number];

export interface RayChunk {
  positions: ArrayLike<number>;
  /** Column-major 4x4 from the chunk's coordinates to the local frame; absent: identity. */
  matrix?: ArrayLike<number>;
  /** Smallest search radius around the ray in metres (about the chunk's point spacing). */
  floor?: number;
  /** Rejects points (section planes, hidden classes); gets chunk coordinates and the index. */
  keep?: (x: number, y: number, z: number, index: number) => boolean;
  /**
   * A sphere holding every point, in the local frame: a chunk the cone cannot reach is skipped
   * without scanning its points.
   */
  sphere?: { center: V3; radius: number };
}

export interface RayPointHit {
  chunk: number;
  index: number;
  /** Distance along the ray, metres. */
  t: number;
  point: [number, number, number];
}

export interface RayPointOptions {
  /** Half-angle of the search cone, radians: a point at distance t may be coneRad * t off. */
  coneRad: number;
  maxDist?: number;
  /** Absolute smallest search radius, metres. Default 0.01. */
  floor?: number;
}

/** Plan-view ring (x, z) and a height range (local y). */
export interface Prism {
  ring: readonly (readonly [number, number])[];
  minY: number;
  maxY: number;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A function mapping chunk coordinates to the local frame. */
function transformOf(m: ArrayLike<number> | undefined) {
  const e = (i: number) => (m ?? IDENTITY)[i] ?? IDENTITY[i] ?? 0;
  const [m0, m1, m2, m4, m5, m6, m8, m9, m10, m12, m13, m14] = [
    e(0),
    e(1),
    e(2),
    e(4),
    e(5),
    e(6),
    e(8),
    e(9),
    e(10),
    e(12),
    e(13),
    e(14),
  ];
  return (x: number, y: number, z: number, out: [number, number, number]) => {
    out[0] = m0 * x + m4 * y + m8 * z + m12;
    out[1] = m1 * x + m5 * y + m9 * z + m13;
    out[2] = m2 * x + m6 * y + m10 * z + m14;
  };
}

/** The nearest point along the ray within the cone (or the floor radius), or null. */
export function raycastPoints(
  ray: { origin: V3; dir: V3 },
  chunks: readonly RayChunk[],
  opts: RayPointOptions,
): RayPointHit | null {
  const [ox, oy, oz] = ray.origin;
  const len = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2]) || 1;
  const dx = ray.dir[0] / len;
  const dy = ray.dir[1] / len;
  const dz = ray.dir[2] / len;
  const maxDist = opts.maxDist ?? Infinity;
  const w: [number, number, number] = [0, 0, 0];
  let best: RayPointHit | null = null;
  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    if (!c) continue;
    const toLocal = transformOf(c.matrix);
    const floor = Math.max(opts.floor ?? 0.01, c.floor ?? 0);
    if (c.sphere) {
      // the chunk spans t in [tc - R, tc + R]; no point of it is nearer the ray than d - R
      const sx = c.sphere.center[0] - ox;
      const sy = c.sphere.center[1] - oy;
      const sz = c.sphere.center[2] - oz;
      const R = c.sphere.radius;
      const tc = sx * dx + sy * dy + sz * dz;
      if (tc + R <= 0 || tc - R > maxDist || (best !== null && tc - R >= best.t)) continue;
      const d = Math.sqrt(Math.max(0, sx * sx + sy * sy + sz * sz - tc * tc));
      if (d - R > Math.max(opts.coneRad * (tc + R), floor)) continue;
    }
    const n = Math.floor(c.positions.length / 3);
    for (let i = 0; i < n; i++) {
      const lx = c.positions[i * 3] ?? 0;
      const ly = c.positions[i * 3 + 1] ?? 0;
      const lz = c.positions[i * 3 + 2] ?? 0;
      toLocal(lx, ly, lz, w);
      const vx = w[0] - ox;
      const vy = w[1] - oy;
      const vz = w[2] - oz;
      const t = vx * dx + vy * dy + vz * dz;
      if (t <= 0 || t > maxDist || (best !== null && t >= best.t)) continue;
      const perp2 = vx * vx + vy * vy + vz * vz - t * t;
      const r = Math.max(opts.coneRad * t, floor);
      if (perp2 > r * r) continue;
      if (c.keep && !c.keep(lx, ly, lz, i)) continue;
      best = { chunk: ci, index: i, t, point: [w[0], w[1], w[2]] };
    }
  }
  return best;
}

/** Even-odd test of a plan-view point against a ring. */
export function inRing(x: number, z: number, ring: Prism['ring']): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}

/** Every point inside the prism, as xyz triples in the local frame. */
export function pointsInPrismOf(chunks: readonly RayChunk[], prism: Prism): Float32Array {
  const xs = prism.ring.map((p) => p[0]);
  const zs = prism.ring.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const out: number[] = [];
  const w: [number, number, number] = [0, 0, 0];
  for (const c of chunks) {
    const toLocal = transformOf(c.matrix);
    const n = Math.floor(c.positions.length / 3);
    for (let i = 0; i < n; i++) {
      toLocal(c.positions[i * 3] ?? 0, c.positions[i * 3 + 1] ?? 0, c.positions[i * 3 + 2] ?? 0, w);
      const [x, y, z] = w;
      if (y < prism.minY || y > prism.maxY || x < x0 || x > x1 || z < z0 || z > z1) continue;
      if (inRing(x, z, prism.ring)) out.push(x, y, z);
    }
  }
  return Float32Array.from(out);
}
