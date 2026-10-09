/**
 * Draft regions of a whole-site difference (M11 G4: Propeller's "AI Volume Breakdown" without a
 * model, the M8 `change.surface` regions on the survey engine). Cells whose change is at least
 * `minDepthM` form 4-connected cut and fill areas; each large enough area becomes a draft polygon
 * (its outer boundary traced along the cell edges, then simplified) with its approximate volume. A
 * draft is only a suggestion: a person accepts it as a measurement, and the measurement's own
 * comparison then gives the exact volumes.
 */

export interface DiffGrid {
  /** dz per cell, row 0 the southernmost, NaN for no data or outside. */
  dz: ArrayLike<number>;
  nx: number;
  ny: number;
  /** West and south edges of cell (0, 0), project CRS metres. */
  x0: number;
  y0: number;
  cellM: number;
}

export interface DraftRegion {
  kind: 'cut' | 'fill';
  /** The outer boundary (E, N), counter-clockwise, not repeating the first point. */
  ring: [number, number][];
  cells: number;
  areaM2: number;
  /** Approximate volume of the area on the difference grid (always positive). */
  volumeM3: number;
  /** The deepest change, metres (negative for cut). */
  peakM: number;
}

export interface RegionOptions {
  /** Smallest |dz| that counts, metres. */
  minDepthM: number;
  /** Smallest area kept, square metres (default 4 cells). */
  minAreaM2?: number;
  /** At most this many regions, largest volume first (default 50). */
  max?: number;
}

/** Cut and fill areas of a difference grid as draft polygons, largest volume first. */
export function draftRegions(g: DiffGrid, opts: RegionOptions): DraftRegion[] {
  const { nx, ny, dz, cellM } = g;
  const minArea = opts.minAreaM2 ?? 4 * cellM * cellM;
  const label = new Int32Array(nx * ny).fill(-1);
  const sign = (k: number): number => {
    const v = dz[k] ?? NaN;
    if (!Number.isFinite(v) || Math.abs(v) < opts.minDepthM || v === 0) return 0;
    return v > 0 ? 1 : -1;
  };
  const out: DraftRegion[] = [];
  const stack: number[] = [];
  let next = 0;
  for (let k0 = 0; k0 < nx * ny; k0++) {
    const s = sign(k0);
    if (s === 0 || label[k0] !== -1) continue;
    const id = next++;
    const cells: number[] = [];
    label[k0] = id;
    stack.push(k0);
    let vol = 0;
    let peak = 0;
    while (stack.length) {
      const k = stack.pop() ?? 0;
      cells.push(k);
      const v = dz[k] ?? 0;
      vol += Math.abs(v);
      if (Math.abs(v) > Math.abs(peak)) peak = v;
      const i = k % nx;
      const j = (k - i) / nx;
      const nb = [
        i > 0 ? k - 1 : -1,
        i + 1 < nx ? k + 1 : -1,
        j > 0 ? k - nx : -1,
        j + 1 < ny ? k + nx : -1,
      ];
      for (const q of nb)
        if (q >= 0 && label[q] === -1 && sign(q) === s) {
          label[q] = id;
          stack.push(q);
        }
    }
    const area = cells.length * cellM * cellM;
    if (area < minArea) continue;
    const ring = outline(cells, label, id, nx, ny);
    if (ring.length < 3) continue;
    out.push({
      kind: s > 0 ? 'fill' : 'cut',
      ring: simplify(ring, 0.5).map(([i, j]) => [g.x0 + i * cellM, g.y0 + j * cellM]),
      cells: cells.length,
      areaM2: area,
      volumeM3: vol * cellM * cellM,
      peakM: peak,
    });
  }
  out.sort((a, b) => b.volumeM3 - a.volumeM3);
  return out.slice(0, opts.max ?? 50);
}

/** The outer boundary of one labelled area along the cell edges, in cell-corner units. */
function outline(
  cells: readonly number[],
  label: Int32Array,
  id: number,
  nx: number,
  ny: number,
): [number, number][] {
  const inside = (i: number, j: number) =>
    i >= 0 && j >= 0 && i < nx && j < ny && label[j * nx + i] === id;
  // directed edges with the area on the left (counter-clockwise), keyed by their start corner
  const W = nx + 1;
  const edges = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    const l = edges.get(a);
    if (l) l.push(b);
    else edges.set(a, [b]);
  };
  for (const k of cells) {
    const i = k % nx;
    const j = (k - i) / nx;
    const c = (x: number, y: number) => y * W + x;
    if (!inside(i, j - 1)) add(c(i, j), c(i + 1, j)); // south edge, going east
    if (!inside(i + 1, j)) add(c(i + 1, j), c(i + 1, j + 1)); // east edge, going north
    if (!inside(i, j + 1)) add(c(i + 1, j + 1), c(i, j + 1)); // north edge, going west
    if (!inside(i - 1, j)) add(c(i, j + 1), c(i, j)); // west edge, going south
  }
  const xy = (v: number): [number, number] => [v % W, Math.floor(v / W)];
  let best: [number, number][] = [];
  let bestArea = 0;
  for (;;) {
    const first = edges.keys().next();
    if (first.done) break;
    const start = first.value;
    const loop: [number, number][] = [];
    let at = start;
    let prev: [number, number] | null = null;
    for (let guard = 0; guard < 4 * cells.length + 8; guard++) {
      const outs = edges.get(at);
      if (!outs || outs.length === 0) break;
      // at a pinch corner take the left turn, which keeps the area tight
      let pick = 0;
      if (outs.length > 1 && prev) {
        const [ax, ay] = xy(at);
        const dx = ax - prev[0];
        const dy = ay - prev[1];
        let bestTurn = -Infinity;
        outs.forEach((o, n) => {
          const [bx, by] = xy(o);
          const turn = dx * (by - ay) - dy * (bx - ax);
          if (turn > bestTurn) {
            bestTurn = turn;
            pick = n;
          }
        });
      }
      const to = outs.splice(pick, 1)[0] ?? at;
      if (outs.length === 0) edges.delete(at);
      const p = xy(at);
      loop.push(p);
      prev = p;
      at = to;
      if (at === start) break;
    }
    let a = 0;
    for (let n = 0; n < loop.length; n++) {
      const p = loop[n] ?? [0, 0];
      const q = loop[(n + 1) % loop.length] ?? [0, 0];
      a += p[0] * q[1] - q[0] * p[1];
    }
    if (a / 2 > bestArea) {
      bestArea = a / 2;
      best = loop;
    }
  }
  return best;
}

/** Drop collinear corners, then Douglas-Peucker on the closed ring (tolerance in cell units). */
export function simplify(ring: [number, number][], tol: number): [number, number][] {
  const n = ring.length;
  if (n <= 3) return ring;
  const keep: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = ring[(k + n - 1) % n] ?? [0, 0];
    const b = ring[k] ?? [0, 0];
    const c = ring[(k + 1) % n] ?? [0, 0];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) keep.push(b);
  }
  if (keep.length <= 4 || tol <= 0) return keep;
  // split the closed ring at its two farthest points and simplify each half
  let far = 0;
  const p0 = keep[0] ?? [0, 0];
  keep.forEach((p, k) => {
    if (Math.hypot(p[0] - p0[0], p[1] - p0[1]) > Math.hypot(...sub(keep[far] ?? p0, p0))) far = k;
  });
  const a = dp(keep.slice(0, far + 1), tol);
  const b = dp([...keep.slice(far), p0], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : keep;
}

const sub = (p: [number, number], q: [number, number]): [number, number] => [
  p[0] - q[0],
  p[1] - q[1],
];

function dp(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const a = pts[0] ?? [0, 0];
  const b = pts[pts.length - 1] ?? [0, 0];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let worst = -1;
  let at = 0;
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k] ?? [0, 0];
    const d =
      len === 0
        ? Math.hypot(p[0] - a[0], p[1] - a[1])
        : Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
    if (d > worst) {
      worst = d;
      at = k;
    }
  }
  if (worst <= tol) return [a, b];
  const left = dp(pts.slice(0, at + 1), tol);
  const right = dp(pts.slice(at), tol);
  return [...left.slice(0, -1), ...right];
}
