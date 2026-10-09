/**
 * Triangulated surfaces (data-conventions sections 26 and 28), the TypeScript twin of
 * `aio_pipelines/survey/tin.py`: barycentric sampling (the lowest-numbered triangle holding a point
 * gives its height), rasterising at cell centres, the hull extension of base TINs, `aio.tin/1`
 * files, and the exact TIN to TIN comparison (the polygon cut into triangles, each clipped by the
 * triangles of both sides and the difference integrated over its parts above and below zero or
 * the deadband).
 */
import type { Window, XY } from './geometry';
import { checkSignal } from './tiles';

/** A point this close outside a triangle (barycentric) is in it. */
export const BARY_EPS = 1e-9;
/** Margin of a triangle's row spans, in cells. */
export const SPAN_EPS = 1e-6;

/** A TIN in a comparison's local frame (metres from its origin), heights with any offset added. */
export class Tin {
  readonly m: number;
  readonly tx0: Float64Array;
  readonly tx1: Float64Array;
  readonly ty0: Float64Array;
  readonly ty1: Float64Array;
  private idx: TriIndex | null = null;

  constructor(
    readonly x: Float64Array,
    readonly y: Float64Array,
    readonly z: Float64Array,
    readonly tris: Uint32Array,
  ) {
    const m = tris.length / 3;
    this.m = m;
    this.tx0 = new Float64Array(m);
    this.tx1 = new Float64Array(m);
    this.ty0 = new Float64Array(m);
    this.ty1 = new Float64Array(m);
    for (let t = 0; t < m; t++) {
      const a = tris[3 * t] ?? 0;
      const b = tris[3 * t + 1] ?? 0;
      const c = tris[3 * t + 2] ?? 0;
      const xa = x[a] ?? 0;
      const xb = x[b] ?? 0;
      const xc = x[c] ?? 0;
      const ya = y[a] ?? 0;
      const yb = y[b] ?? 0;
      const yc = y[c] ?? 0;
      this.tx0[t] = Math.min(Math.min(xa, xb), xc);
      this.tx1[t] = Math.max(Math.max(xa, xb), xc);
      this.ty0[t] = Math.min(Math.min(ya, yb), yc);
      this.ty1[t] = Math.max(Math.max(ya, yb), yc);
    }
  }

  get index(): TriIndex {
    this.idx ??= new TriIndex(this);
    return this.idx;
  }

  /** ax, ay, az, bx, by, bz, cx, cy, cz of triangle `t`. */
  corners(t: number, out: Float64Array): Float64Array {
    for (let k = 0; k < 3; k++) {
      const v = this.tris[3 * t + k] ?? 0;
      out[3 * k] = this.x[v] ?? 0;
      out[3 * k + 1] = this.y[v] ?? 0;
      out[3 * k + 2] = this.z[v] ?? 0;
    }
    return out;
  }
}

/** Triangles by bucket, to find the ones near a point or a box. */
export class TriIndex {
  readonly x0: number;
  readonly y0: number;
  readonly nb: number;
  readonly bw: number;
  readonly bh: number;
  private readonly buckets: number[][];

  constructor(tin: Tin) {
    const m = tin.m;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let t = 0; t < m; t++) {
      x0 = Math.min(x0, tin.tx0[t] ?? 0);
      y0 = Math.min(y0, tin.ty0[t] ?? 0);
      x1 = Math.max(x1, tin.tx1[t] ?? 0);
      y1 = Math.max(y1, tin.ty1[t] ?? 0);
    }
    if (m === 0) {
      x0 = 0;
      y0 = 0;
      x1 = 1;
      y1 = 1;
    }
    const nb = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(Math.max(m, 1) / 2))));
    this.x0 = x0;
    this.y0 = y0;
    this.nb = nb;
    this.bw = Math.max((x1 - x0) / nb, 1e-9);
    this.bh = Math.max((y1 - y0) / nb, 1e-9);
    this.buckets = Array.from({ length: nb * nb }, () => []);
    for (let t = 0; t < m; t++) {
      const ia = this.col(tin.tx0[t] ?? 0);
      const ib = this.col(tin.tx1[t] ?? 0);
      const ja = this.row(tin.ty0[t] ?? 0);
      const jb = this.row(tin.ty1[t] ?? 0);
      for (let j = ja; j <= jb; j++)
        for (let i = ia; i <= ib; i++) this.buckets[j * nb + i]?.push(t);
    }
  }

  private col(x: number): number {
    return Math.min(Math.max(Math.floor((x - this.x0) / this.bw), 0), this.nb - 1);
  }
  private row(y: number): number {
    return Math.min(Math.max(Math.floor((y - this.y0) / this.bh), 0), this.nb - 1);
  }

  /** Triangles whose buckets meet the box, ascending, each once. */
  box(x0: number, y0: number, x1: number, y1: number): number[] {
    const ia = this.col(x0);
    const ib = this.col(x1);
    const ja = this.row(y0);
    const jb = this.row(y1);
    if (ia === ib && ja === jb) return this.buckets[ja * this.nb + ia] ?? [];
    const set = new Set<number>();
    for (let j = ja; j <= jb; j++)
      for (let i = ia; i <= ib; i++)
        for (const t of this.buckets[j * this.nb + i] ?? []) set.add(t);
    return [...set].sort((a, b) => a - b);
  }
}

/** Height of triangle `c9` at (px, py), barycentric (the Python core's formula). */
export function triZ(c9: Float64Array, px: number, py: number): number {
  const ax = c9[0] ?? 0;
  const ay = c9[1] ?? 0;
  const bx = c9[3] ?? 0;
  const by = c9[4] ?? 0;
  const cx = c9[6] ?? 0;
  const cy = c9[7] ?? 0;
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  const l3 = 1 - l1 - l2;
  return l1 * (c9[2] ?? 0) + l2 * (c9[5] ?? 0) + l3 * (c9[8] ?? 0);
}

/** Heights at points; NaN outside. The lowest-numbered triangle holding a point wins. */
export function samplePoints(tin: Tin, xs: Float64Array, ys: Float64Array): Float64Array {
  const out = new Float64Array(xs.length).fill(NaN);
  if (tin.m === 0) return out;
  const idx = tin.index;
  const c9 = new Float64Array(9);
  for (let k = 0; k < xs.length; k++) {
    const px = xs[k] ?? 0;
    const py = ys[k] ?? 0;
    for (const t of idx.box(px, py, px, py)) {
      if (
        px < (tin.tx0[t] ?? 0) ||
        px > (tin.tx1[t] ?? 0) ||
        py < (tin.ty0[t] ?? 0) ||
        py > (tin.ty1[t] ?? 0)
      )
        continue;
      tin.corners(t, c9);
      const ax = c9[0] ?? 0;
      const ay = c9[1] ?? 0;
      const bx = c9[3] ?? 0;
      const by = c9[4] ?? 0;
      const cx = c9[6] ?? 0;
      const cy = c9[7] ?? 0;
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (d === 0) continue;
      const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
      const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 >= -BARY_EPS && l2 >= -BARY_EPS && l3 >= -BARY_EPS) {
        out[k] = l1 * (c9[2] ?? 0) + l2 * (c9[5] ?? 0) + l3 * (c9[8] ?? 0);
        break;
      }
    }
  }
  return out;
}

/** Heights at the centres of a window's cells; NaN outside. Lowest-numbered triangle wins. */
export function rasterize(tin: Tin, win: Window, signal?: AbortSignal): Float64Array {
  const { cell: c, i0, j0, nx, ny } = win;
  const out = new Float64Array(nx * ny).fill(NaN);
  const wx0 = i0 * c;
  const wx1 = (i0 + nx) * c;
  const wy0 = j0 * c;
  const wy1 = (j0 + ny) * c;
  const c9 = new Float64Array(9);
  let done = 0;
  for (let t = 0; t < tin.m; t++) {
    if (
      (tin.tx1[t] ?? 0) < wx0 ||
      (tin.tx0[t] ?? 0) > wx1 ||
      (tin.ty1[t] ?? 0) < wy0 ||
      (tin.ty0[t] ?? 0) > wy1
    )
      continue;
    if (done++ % 1024 === 0) checkSignal(signal);
    tin.corners(t, c9);
    const ax = c9[0] ?? 0;
    const ay = c9[1] ?? 0;
    const az = c9[2] ?? 0;
    const bx = c9[3] ?? 0;
    const by = c9[4] ?? 0;
    const bz = c9[5] ?? 0;
    const cx = c9[6] ?? 0;
    const cy = c9[7] ?? 0;
    const cz = c9[8] ?? 0;
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (d === 0) continue;
    const r0 = Math.max(Math.ceil(Math.min(ay, by, cy) / c - 0.5 - SPAN_EPS), j0);
    const r1 = Math.min(Math.floor(Math.max(ay, by, cy) / c - 0.5 + SPAN_EPS), j0 + ny - 1);
    for (let r = r0; r <= r1; r++) {
      const yc = (r + 0.5) * c;
      let xl = Infinity;
      let xr = -Infinity;
      // the row's crossings of the three edges (a to b, b to c, c to a)
      for (let e = 0; e < 3; e++) {
        const px = e === 0 ? ax : e === 1 ? bx : cx;
        const py = e === 0 ? ay : e === 1 ? by : cy;
        const qx = e === 0 ? bx : e === 1 ? cx : ax;
        const qy = e === 0 ? by : e === 1 ? cy : ay;
        if (py === qy) {
          if (yc === py) {
            xl = Math.min(xl, Math.min(px, qx));
            xr = Math.max(xr, Math.max(px, qx));
          }
          continue;
        }
        if (yc >= Math.min(py, qy) && yc <= Math.max(py, qy)) {
          const xe = px + ((yc - py) * (qx - px)) / (qy - py);
          xl = Math.min(xl, xe);
          xr = Math.max(xr, xe);
        }
      }
      if (xl > xr) {
        xl = Math.min(ax, bx, cx);
        xr = Math.max(ax, bx, cx);
      }
      const ia = Math.max(Math.ceil(xl / c - 0.5 - SPAN_EPS), i0);
      const ib = Math.min(Math.floor(xr / c - 0.5 + SPAN_EPS), i0 + nx - 1);
      const row = (r - j0) * nx - i0;
      for (let i = ia; i <= ib; i++) {
        const px = (i + 0.5) * c;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (yc - cy)) / d;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (yc - cy)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -BARY_EPS && l2 >= -BARY_EPS && l3 >= -BARY_EPS) {
          const k = row + i;
          if (Number.isNaN(out[k] ?? 0)) out[k] = l1 * az + l2 * bz + l3 * cz;
        }
      }
    }
  }
  return out;
}

/**
 * Heights beyond a base TIN's hull: the height of the nearest point of the hull. Cells at the
 * polygon's edge whose centre is just outside the base take it; ties go to the hull edge met first
 * (by triangle, then edge order), as in the Python core.
 */
export class HullExtension {
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly az: number[] = [];
  private readonly bx: number[] = [];
  private readonly by: number[] = [];
  private readonly bz: number[] = [];
  private readonly n: number;
  private x0 = 0;
  private y0 = 0;
  private nb = 1;
  private bs = 1;
  private readonly cells = new Map<string, number[]>();

  constructor(tin: Tin) {
    const seen = new Map<string, number>();
    const order: [number, number][] = [];
    for (let t = 0; t < tin.m; t++) {
      const v = [tin.tris[3 * t] ?? 0, tin.tris[3 * t + 1] ?? 0, tin.tris[3 * t + 2] ?? 0];
      for (let k = 0; k < 3; k++) {
        const p = v[k] ?? 0;
        const q = v[(k + 1) % 3] ?? 0;
        const key = p < q ? `${p},${q}` : `${q},${p}`;
        const c = seen.get(key);
        if (c === undefined) {
          seen.set(key, 1);
          order.push([p, q]);
        } else seen.set(key, c + 1);
      }
    }
    for (const [p, q] of order) {
      if (seen.get(p < q ? `${p},${q}` : `${q},${p}`) !== 1) continue;
      this.ax.push(tin.x[p] ?? 0);
      this.ay.push(tin.y[p] ?? 0);
      this.az.push(tin.z[p] ?? 0);
      this.bx.push(tin.x[q] ?? 0);
      this.by.push(tin.y[q] ?? 0);
      this.bz.push(tin.z[q] ?? 0);
    }
    this.n = this.ax.length;
    if (this.n === 0) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < this.n; k++) {
      x0 = Math.min(x0, this.ax[k] ?? 0, this.bx[k] ?? 0);
      y0 = Math.min(y0, this.ay[k] ?? 0, this.by[k] ?? 0);
      x1 = Math.max(x1, this.ax[k] ?? 0, this.bx[k] ?? 0);
      y1 = Math.max(y1, this.ay[k] ?? 0, this.by[k] ?? 0);
    }
    const nb = Math.max(1, Math.ceil(Math.sqrt(this.n)));
    this.bs = Math.max((x1 - x0) / nb, (y1 - y0) / nb, 1e-9);
    this.x0 = x0;
    this.y0 = y0;
    this.nb = nb;
    for (let k = 0; k < this.n; k++) {
      const ax = this.ax[k] ?? 0;
      const bx = this.bx[k] ?? 0;
      const ay = this.ay[k] ?? 0;
      const by = this.by[k] ?? 0;
      const i0 = Math.floor((Math.min(ax, bx) - x0) / this.bs);
      const i1 = Math.floor((Math.max(ax, bx) - x0) / this.bs);
      const j0 = Math.floor((Math.min(ay, by) - y0) / this.bs);
      const j1 = Math.floor((Math.max(ay, by) - y0) / this.bs);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const key = `${i},${j}`;
          const list = this.cells.get(key);
          if (list) list.push(k);
          else this.cells.set(key, [k]);
        }
    }
  }

  z(px: number, py: number): number {
    if (this.n === 0) return NaN;
    const bi = Math.floor((px - this.x0) / this.bs);
    const bj = Math.floor((py - this.y0) / this.bs);
    let bestD = Infinity;
    let bestK = -1;
    let bestZ = NaN;
    const seen = new Set<number>();
    const limit =
      Math.max(Math.abs(bi), Math.abs(bj), Math.abs(bi - this.nb), Math.abs(bj - this.nb)) +
      this.nb +
      1;
    for (let r = 0; r <= limit; r++) {
      for (let j = bj - r; j <= bj + r; j++) {
        for (let i = bi - r; i <= bi + r; i++) {
          if (Math.max(Math.abs(i - bi), Math.abs(j - bj)) !== r) continue;
          for (const k of this.cells.get(`${i},${j}`) ?? []) {
            if (seen.has(k)) continue;
            seen.add(k);
            const ax = this.ax[k] ?? 0;
            const ay = this.ay[k] ?? 0;
            const dx = (this.bx[k] ?? 0) - ax;
            const dy = (this.by[k] ?? 0) - ay;
            const l2 = dx * dx + dy * dy;
            let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
            t = Math.min(Math.max(t, 0), 1);
            const qx = ax + t * dx;
            const qy = ay + t * dy;
            const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
            if (d2 < bestD || (d2 === bestD && k < bestK)) {
              bestD = d2;
              bestK = k;
              const az = this.az[k] ?? 0;
              bestZ = az + t * ((this.bz[k] ?? 0) - az);
            }
          }
        }
      }
      if (bestK >= 0 && Math.sqrt(bestD) < r * this.bs) break;
    }
    return bestZ;
  }
}

// ---------------------------------------------------------------------------------- aio.tin/1

/** A parsed `aio.tin/1` file: absolute vertices (E, N, Z; no offset) and triangles. */
export interface TinFile {
  header: Record<string, unknown>;
  vertices: Float64Array;
  triangles: Uint32Array;
}

export function readTin(data: ArrayBuffer | Uint8Array, name = 'design surface'): TinFile {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const bad = `The ${name} is not an aio.tin/1 file`;
  if (bytes.length < 4) throw new Error(`${bad}.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hlen = view.getUint32(0, true);
  if (hlen > bytes.length - 4 || hlen > 1_000_000) throw new Error(`${bad}.`);
  let head: Record<string, unknown>;
  try {
    head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hlen))) as Record<
      string,
      unknown
    >;
  } catch (e) {
    throw new Error(`${bad}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (head.schema !== 'aio.tin/1') throw new Error(`${bad}.`);
  const int = (k: string) => {
    const v = head[k];
    return typeof v === 'number' ? v : -1;
  };
  const nv = int('vertexCount');
  const nt = int('triangleCount');
  const va = int('verticesAt');
  const ta = int('trianglesAt');
  if (nv < 0 || nt < 0 || nt > 2_000_000 || va < 0 || ta < 0)
    throw new Error(`${bad}: its counts are wrong.`);
  if (va + nv * 24 > bytes.length || ta + nt * 12 > bytes.length)
    throw new Error(`${bad}: it is shorter than its header says.`);
  const vertices = new Float64Array(nv * 3);
  for (let k = 0; k < nv * 3; k++) vertices[k] = view.getFloat64(va + 8 * k, true);
  const triangles = new Uint32Array(nt * 3);
  for (let k = 0; k < nt * 3; k++) {
    const v = view.getUint32(ta + 4 * k, true);
    if (v >= nv) throw new Error(`${bad}: a triangle names a vertex it does not have.`);
    triangles[k] = v;
  }
  return { header: head, vertices, triangles };
}

/** A TIN file in a local frame at (originE, originN), the design offset added. */
export function tinAt(f: TinFile, originE: number, originN: number, offset = 0): Tin {
  const n = f.vertices.length / 3;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    x[k] = (f.vertices[3 * k] ?? 0) - originE;
    y[k] = (f.vertices[3 * k + 1] ?? 0) - originN;
    z[k] = (f.vertices[3 * k + 2] ?? 0) + offset;
  }
  return new Tin(x, y, z, f.triangles);
}

// ---------------------------------------------------------------------------------- polygons

type P = [number, number];
type Tri = [P, P, P];

const cross = (o: XY, a: XY, b: XY) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Counter-clockwise triangles covering a simple counter-clockwise ring. */
export function earClip(ring: readonly XY[]): Tri[] {
  const pts: P[] = ring.map((p) => [p[0], p[1]]);
  const out: Tri[] = [];
  const same = (a: XY, b: XY) => a[0] === b[0] && a[1] === b[1];
  let guard = 0;
  while (pts.length > 3 && guard < 10 * ring.length + 10) {
    guard++;
    const n = pts.length;
    let found = false;
    for (let k = 0; k < n; k++) {
      const a = pts[(k - 1 + n) % n];
      const b = pts[k];
      const c = pts[(k + 1) % n];
      if (!a || !b || !c) continue;
      const cr = cross(a, b, c);
      if (cr === 0) {
        pts.splice(k, 1);
        found = true;
        break;
      }
      if (cr < 0) continue;
      let ok = true;
      for (const p of pts) {
        if (same(p, a) || same(p, b) || same(p, c)) continue;
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) {
          ok = false;
          break;
        }
      }
      if (ok) {
        out.push([a, b, c]);
        pts.splice(k, 1);
        found = true;
        break;
      }
    }
    if (!found) {
      let best = 0;
      let bv = -Infinity;
      for (let k = 0; k < n; k++) {
        const a = pts[(k - 1 + n) % n];
        const b = pts[k];
        const c = pts[(k + 1) % n];
        if (!a || !b || !c) continue;
        const v = cross(a, b, c);
        if (v > bv) {
          bv = v;
          best = k;
        }
      }
      const a = pts[(best - 1 + n) % n];
      const b = pts[best];
      const c = pts[(best + 1) % n];
      if (a && b && c) out.push([a, b, c]);
      pts.splice(best, 1);
    }
  }
  const [a, b, c] = pts;
  if (pts.length === 3 && a && b && c && cross(a, b, c) > 0) out.push([a, b, c]);
  return out;
}

function clipHalf(poly: P[], f: (p: P) => number): P[] {
  const out: P[] = [];
  const n = poly.length;
  if (n === 0) return out;
  const vals = poly.map(f);
  for (let k = 0; k < n; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % n];
    const fp = vals[k] ?? 0;
    const fq = vals[(k + 1) % n] ?? 0;
    if (!p || !q) continue;
    if (fp >= 0) out.push(p);
    if (fp >= 0 !== fq >= 0) {
      const t = fp / (fp - fq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}

/** A convex polygon clipped by a triangle (any orientation). */
export function clipTri(poly: P[], a: P, b: P, c: P): P[] {
  if (cross(a, b, c) < 0) [b, c] = [c, b];
  let out = poly;
  for (const [p, q] of [
    [a, b],
    [b, c],
    [c, a],
  ] as const) {
    out = clipHalf(out, (r) => cross(p, q, r));
    if (out.length < 3) return [];
  }
  return out;
}

/** Area and the integral of a linear function (vertex values) over a convex polygon. */
function integral(poly: P[], vals: number[]): [number, number] {
  let area = 0;
  let total = 0;
  const p0 = poly[0];
  if (!p0) return [0, 0];
  const [x0, y0] = p0;
  for (let k = 1; k < poly.length - 1; k++) {
    const p = poly[k];
    const q = poly[k + 1];
    if (!p || !q) continue;
    const a = ((p[0] - x0) * (q[1] - y0) - (q[0] - x0) * (p[1] - y0)) / 2;
    area += a;
    total += (a * ((vals[0] ?? 0) + (vals[k] ?? 0) + (vals[k + 1] ?? 0))) / 3;
  }
  return [area, total];
}

function clipLin(
  poly: P[],
  vals: number[],
  sign: number,
  deadband: number,
): [P[], number[]] | null {
  const g = vals.map((v) => sign * v - deadband);
  const op: P[] = [];
  const ov: number[] = [];
  const n = poly.length;
  for (let k = 0; k < n; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % n];
    if (!p || !q) continue;
    const gp = g[k] ?? 0;
    const gq = g[(k + 1) % n] ?? 0;
    if (gp >= 0) {
      op.push(p);
      ov.push(vals[k] ?? 0);
    }
    if (gp >= 0 !== gq >= 0) {
      const t = gp / (gp - gq);
      op.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      const vk = vals[k] ?? 0;
      ov.push(vk + t * ((vals[(k + 1) % n] ?? 0) - vk));
    }
  }
  return op.length < 3 ? null : [op, ov];
}

/** A side given as a function of (x, y) everywhere (a level or a plane). */
export interface Planar {
  kind: 'planar';
  fn: (x: number, y: number) => number;
  /** A flat level (the same as `fn`, for speed). */
  level?: number;
  /** `p0 + p1 (x - ox) + p2 (y - oy)` (the same as `fn`, for speed). */
  plane?: { p: [number, number, number]; ox: number; oy: number };
}

export type ExactSide = Tin | Planar;

function* pieces(poly: P[], side: ExactSide): Generator<[P[], (x: number, y: number) => number]> {
  if (!(side instanceof Tin)) {
    yield [poly, side.fn];
    return;
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  for (const t of side.index.box(x0, y0, x1, y1)) {
    if (
      (side.tx0[t] ?? 0) > x1 ||
      (side.tx1[t] ?? 0) < x0 ||
      (side.ty0[t] ?? 0) > y1 ||
      (side.ty1[t] ?? 0) < y0
    )
      continue;
    const c9 = side.corners(t, new Float64Array(9));
    const ax = c9[0] ?? 0;
    const ay = c9[1] ?? 0;
    const bx = c9[3] ?? 0;
    const by = c9[4] ?? 0;
    const cx = c9[6] ?? 0;
    const cy = c9[7] ?? 0;
    if ((by - cy) * (ax - cx) + (cx - bx) * (ay - cy) === 0) continue;
    const part = clipTri(poly, [ax, ay], [bx, by], [cx, cy]);
    if (part.length >= 3) yield [part, (px, py) => triZ(c9, px, py)];
  }
}

export interface ExactTotals {
  fill: number;
  cut: number;
  areaFill: number;
  areaCut: number;
  areaUnchanged: number;
  covered: number;
}

/** Cut and fill of `to - from` over the polygon's triangles, exactly (no grid). */
export function exactCompare(
  ptris: Tri[],
  from: ExactSide,
  to: ExactSide,
  deadband: number,
  signal?: AbortSignal,
): ExactTotals {
  const out: ExactTotals = {
    fill: 0,
    cut: 0,
    areaFill: 0,
    areaCut: 0,
    areaUnchanged: 0,
    covered: 0,
  };
  ptris.forEach(([a, b, c], k) => {
    if (k % 16 === 0) checkSignal(signal);
    for (const [q, fFrom] of pieces([a, b, c], from)) {
      for (const [r, fTo] of pieces(q, to)) {
        const dz = r.map((p) => fTo(p[0], p[1]) - fFrom(p[0], p[1]));
        const [area] = integral(r, dz);
        if (area <= 0) continue;
        out.covered += area;
        if (dz.every((v) => v === 0)) {
          out.areaUnchanged += area;
          continue;
        }
        const fp = clipLin(r, dz, 1, deadband);
        const cp = clipLin(r, dz, -1, deadband);
        const [fa, ft] = fp ? integral(fp[0], fp[1]) : [0, 0];
        const [ca, ct] = cp ? integral(cp[0], cp[1]) : [0, 0];
        out.fill += Math.max(ft, 0);
        out.cut += Math.max(-ct, 0);
        out.areaFill += Math.max(fa, 0);
        out.areaCut += Math.max(ca, 0);
        out.areaUnchanged += Math.max(area - fa - ca, 0);
      }
    }
  });
  return out;
}

/** Lowest and highest height of a TIN over the polygon's triangles. */
export function tinExtremes(ptris: Tri[], side: Tin): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b, c] of ptris)
    for (const [part, fn] of pieces([a, b, c], side))
      for (const p of part) {
        const z = fn(p[0], p[1]);
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
  return lo === Infinity ? null : [lo, hi];
}
