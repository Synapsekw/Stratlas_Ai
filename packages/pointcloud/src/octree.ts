/**
 * Octree level of detail under a global point budget (COPC hierarchies, and flat chunk sets as a
 * one-level tree). Pure: no three.js, no I/O.
 */

type V3 = readonly [number, number, number];
interface Box {
  min: V3;
  max: V3;
}

/** A plane as [nx, ny, nz, d]; a point p is inside when n . p + d >= 0. */
export type Plane4 = readonly [number, number, number, number];

export interface LodNode {
  /** Unique across every cloud in the scene. */
  key: string;
  points: number;
  /** Local frame (metres, Y up). */
  bounds: Box;
  /** Always wanted (overview chunks, octree roots). */
  root: boolean;
  /** Loaded, or being loaded. */
  loaded: boolean;
  /**
   * Point spacing of this node in metres. With it, the node's children are only considered while
   * the spacing projects to more than `minPx` pixels (screen-space error).
   */
  spacing?: number;
  /** Keys of the child nodes (octree). Nodes no one lists as a child hang under the roots. */
  children?: readonly string[];
  /** The node's hierarchy page is not loaded yet: its point count and children are unknown. */
  page?: boolean;
}

export interface NodeSelectOptions {
  /** Global point budget across every cloud. */
  budget: number;
  /** Pixels per metre at distance 1 (drawing buffer height / (2 tan(fov / 2))). */
  pxPerM: number;
  /** Refine a node while its spacing projects to more than this many pixels. Default 1. */
  minPx?: number;
  /** Nodes whose half-diagonal / distance is below this are not worth loading. Default 0.02. */
  minScreenRatio?: number;
  /** Loaded nodes stay while the total stays within budget * hysteresis. Default 1.1. */
  hysteresis?: number;
  /** View frustum; nodes entirely outside are not loaded. */
  frustum?: readonly Plane4[];
}

export interface NodeSelection {
  /** Wanted and not loaded, highest priority first (a parent always before its children). */
  load: string[];
  /** Loaded and no longer wanted. */
  unload: string[];
  /** Placeholder nodes whose hierarchy page should be fetched. */
  pages: string[];
}

export function parseKey(key: string): [number, number, number, number] {
  const p = key.split('-').map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0];
}

export function childKeys(key: string): string[] {
  const [d, x, y, z] = parseKey(key);
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(`${d + 1}-${2 * x + (i & 1)}-${2 * y + ((i >> 1) & 1)}-${2 * z + ((i >> 2) & 1)}`);
  }
  return out;
}

export function parentKey(key: string): string | null {
  const [d, x, y, z] = parseKey(key);
  if (d === 0) return null;
  return `${d - 1}-${x >> 1}-${y >> 1}-${z >> 1}`;
}

/**
 * Bounds of node `key` of a COPC cube (CRS: x east, y north, z up) in the project local frame,
 * where E = origin[0] + x, N = origin[1] - z, H = origin[2] + y.
 */
export function nodeBounds(
  key: string,
  cube: Box,
  origin: V3,
): { min: [number, number, number]; max: [number, number, number] } {
  const [d, x, y, z] = parseKey(key);
  const s = (cube.max[0] - cube.min[0]) / 2 ** d;
  const e0 = cube.min[0] + x * s;
  const n0 = cube.min[1] + y * s;
  const h0 = cube.min[2] + z * s;
  return {
    min: [e0 - origin[0], h0 - origin[2], origin[1] - (n0 + s)],
    max: [e0 + s - origin[0], h0 + s - origin[2], origin[1] - n0],
  };
}

export interface FrustumSpec {
  eye: V3;
  target: V3;
  fovDeg: number;
  aspect: number;
  near: number;
  far: number;
}

const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): [number, number, number] => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The six planes of a perspective camera looking from `eye` to `target` (Y up). For tests and tools. */
export function frustumPlanes(f: FrustumSpec): Plane4[] {
  const fwd = norm(sub(f.target, f.eye));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const ty = Math.tan((f.fovDeg * Math.PI) / 360);
  const tx = ty * f.aspect;
  const plane = (n: [number, number, number], p: V3): Plane4 => {
    const u = norm(n);
    return [u[0], u[1], u[2], -dot(u, p)];
  };
  const comb = (a: V3, sa: number, b: V3, sb: number): [number, number, number] => [
    a[0] * sa + b[0] * sb,
    a[1] * sa + b[1] * sb,
    a[2] * sa + b[2] * sb,
  ];
  const at = (d: number): V3 => [
    f.eye[0] + fwd[0] * d,
    f.eye[1] + fwd[1] * d,
    f.eye[2] + fwd[2] * d,
  ];
  return [
    plane(fwd, at(f.near)),
    plane([-fwd[0], -fwd[1], -fwd[2]], at(f.far)),
    plane(comb(fwd, tx, right, 1), f.eye), // left: normal points right-ish
    plane(comb(fwd, tx, right, -1), f.eye), // right
    plane(comb(fwd, ty, up, 1), f.eye), // bottom
    plane(comb(fwd, ty, up, -1), f.eye), // top
  ];
}

/** False when the box lies entirely outside one of the planes. */
export function boxInFrustum(b: Box, planes: readonly Plane4[]): boolean {
  for (const [nx, ny, nz, d] of planes) {
    const px = nx >= 0 ? b.max[0] : b.min[0];
    const py = ny >= 0 ? b.max[1] : b.min[1];
    const pz = nz >= 0 ? b.max[2] : b.min[2];
    if (nx * px + ny * py + nz * pz + d < 0) return false;
  }
  return true;
}

function boxDist(b: Box, p: V3): number {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const lo = b.min[a] ?? 0;
    const hi = b.max[a] ?? 0;
    const v = p[a] ?? 0;
    const d = v < lo ? lo - v : v > hi ? v - hi : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

function halfDiagonal(b: Box): number {
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  return Math.max(0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-3);
}

/** Angular size: half-diagonal over distance (distance floored at 5 % of the radius). */
export function nodePriority(b: Box, eye: V3): number {
  const r = halfDiagonal(b);
  return r / Math.max(boxDist(b, eye), r * 0.05);
}

/** A small binary max-heap on priority. */
class Heap<T> {
  private readonly a: { p: number; v: T }[] = [];
  get size() {
    return this.a.length;
  }
  push(p: number, v: T) {
    const a = this.a;
    a.push({ p, v });
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      const ai = a[i];
      const aj = a[j];
      if (!ai || !aj || aj.p >= ai.p) break;
      a[i] = aj;
      a[j] = ai;
      i = j;
    }
  }
  pop(): { p: number; v: T } | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if ((a[l]?.p ?? -Infinity) > (a[m]?.p ?? -Infinity)) m = l;
        if ((a[r]?.p ?? -Infinity) > (a[m]?.p ?? -Infinity)) m = r;
        if (m === i) break;
        const am = a[m];
        const ai = a[i];
        if (!am || !ai) break;
        a[m] = ai;
        a[i] = am;
        i = m;
      }
    }
    return top;
  }
}

/** Lookups over a node list; depends only on the keys and children, so it can be kept between calls. */
export interface LodIndex {
  byKey: ReadonlyMap<string, LodNode>;
  /** Child key to parent key. */
  parentOf: ReadonlyMap<string, string>;
}

/**
 * The lookups `selectNodes` needs. Build once per change of the node set (not of its loaded flags
 * or the camera) and pass it to every selection: rebuilding it is most of a selection's cost.
 */
export function indexNodes(nodes: readonly LodNode[]): LodIndex {
  const byKey = new Map<string, LodNode>();
  const parentOf = new Map<string, string>();
  for (const n of nodes) {
    byKey.set(n.key, n);
    for (const c of n.children ?? []) parentOf.set(c, n.key);
  }
  return { byKey, parentOf };
}

/**
 * Screen-space-error traversal under a global budget, across every cloud in the scene:
 *
 * 1. Roots are always wanted.
 * 2. A max-heap on angular size holds the frontier: the children of selected octree nodes whose
 *    spacing still projects to more than `minPx`, and every flat (unparented) chunk.
 * 3. The highest-priority frontier node is selected while it is in the frustum, not tiny, and fits
 *    the budget; then its children join the frontier.
 * 4. Loaded nodes outside the selection stay (no churn) while their parent stays and the total is
 *    within budget * hysteresis; the rest unload.
 */
export function selectNodes(
  nodes: readonly LodNode[],
  eye: V3,
  opts: NodeSelectOptions,
  index: LodIndex = indexNodes(nodes),
): NodeSelection {
  const minPx = opts.minPx ?? 1;
  const minRatio = opts.minScreenRatio ?? 0.02;
  const hyst = opts.hysteresis ?? 1.1;
  const { byKey, parentOf } = index;

  const wanted = new Set<string>();
  const order: string[] = [];
  const pages: string[] = [];
  const heap = new Heap<LodNode>();
  let total = 0;

  const refines = (n: LodNode) => {
    if (!n.children?.length) return false;
    if (n.spacing === undefined) return true;
    const d = Math.max(boxDist(n.bounds, eye), 1e-3);
    return (n.spacing * opts.pxPerM) / d > minPx;
  };
  const pushChildren = (n: LodNode) => {
    if (!refines(n)) return;
    for (const k of n.children ?? []) {
      const c = byKey.get(k);
      if (c) heap.push(nodePriority(c.bounds, eye), c);
    }
  };

  for (const n of nodes) {
    if (n.root) {
      wanted.add(n.key);
      order.push(n.key);
      total += n.points;
    }
  }
  for (const n of nodes) {
    if (n.root) pushChildren(n);
    else if (!parentOf.has(n.key)) heap.push(nodePriority(n.bounds, eye), n);
  }

  for (let top = heap.pop(); top; top = heap.pop()) {
    const n = top.v;
    if (top.p < minRatio) continue;
    if (opts.frustum && !boxInFrustum(n.bounds, opts.frustum)) continue;
    if (n.page) {
      pages.push(n.key);
      continue;
    }
    if (total + n.points > opts.budget) continue;
    wanted.add(n.key);
    order.push(n.key);
    total += n.points;
    pushChildren(n);
  }

  const load = order.filter((k) => !byKey.get(k)?.loaded);
  const unload: string[] = [];
  const kept = new Set<string>();
  const stale = nodes
    .filter((n) => n.loaded && !wanted.has(n.key))
    .map((n) => ({ n, p: nodePriority(n.bounds, eye) }))
    .sort((a, b) => b.p - a.p);
  for (const { n, p } of stale) {
    const parent = parentOf.get(n.key);
    const parentStays = !parent || wanted.has(parent) || kept.has(parent);
    if (parentStays && p >= minRatio * 0.5 && total + n.points <= opts.budget * hyst) {
      kept.add(n.key);
      total += n.points;
    } else unload.push(n.key);
  }
  return { load, unload, pages };
}
