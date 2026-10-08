/**
 * Rings, comparison windows and coverage weights (data-conventions section 26), the TypeScript
 * twin of `aio_pipelines/survey/grid.py`. Every discrete decision uses the same formula in the
 * same order as the Python core, so the two executors agree on edge cases.
 *
 * Coverage weights are exact: each polygon edge adds the signed area it encloses to the cells it
 * crosses (an exact area rasteriser), and a running sum along each row gives the share of every
 * cell inside the polygon. The Python core clips the edge cells with shapely; both are exact.
 */

export type XY = readonly [number, number];

/** Rings with more points are not checked for crossings (both executors). */
export const CROSSING_CHECK_MAX = 5000;

/** A ring without repeated consecutive points or a closing repeat. */
export function normalRing(ring: readonly (readonly number[])[]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of ring) {
    const x = p[0] ?? 0;
    const y = p[1] ?? 0;
    const last = out.at(-1);
    if (last?.[0] !== x || last[1] !== y) out.push([x, y]);
  }
  while (out.length > 1) {
    const a = out[0];
    const z = out.at(-1);
    if (a && a[0] === z?.[0] && a[1] === z[1]) out.pop();
    else break;
  }
  return out;
}

export function signedArea(ring: readonly XY[]): number {
  let s = 0;
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % n];
    if (a && b) s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function ringArea(ring: readonly XY[]): number {
  return Math.abs(signedArea(ring));
}

function crossProper(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when two edges that share no point cross (properly). */
export function crossesItself(ring: readonly XY[]): boolean {
  const n = ring.length;
  if (n < 4 || n > CROSSING_CHECK_MAX) return false;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (!a || !b) continue;
    const ax0 = Math.min(a[0], b[0]);
    const ax1 = Math.max(a[0], b[0]);
    const ay0 = Math.min(a[1], b[1]);
    const ay1 = Math.max(a[1], b[1]);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      if (!c || !d) continue;
      if (
        Math.max(c[0], d[0]) < ax0 ||
        Math.min(c[0], d[0]) > ax1 ||
        Math.max(c[1], d[1]) < ay0 ||
        Math.min(c[1], d[1]) > ay1
      )
        continue;
      if (crossProper(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Points every `step` (at most) along each edge of a closed ring, the vertices included. */
export function densify(ring: readonly XY[], step: number): { xs: Float64Array; ys: Float64Array } {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % n];
    if (!a || !b) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.sqrt(dx * dx + dy * dy);
    const m = Math.max(1, Math.ceil(length / step));
    for (let s = 0; s < m; s++) {
      xs.push(a[0] + (dx * s) / m);
      ys.push(a[1] + (dy * s) / m);
    }
  }
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
}

/** Comparison cells `i0 .. i0 + nx`, `j0 .. j0 + ny` of `cell` metres in a local frame. */
export interface Window {
  cell: number;
  i0: number;
  j0: number;
  nx: number;
  ny: number;
}

export function windowOver(ring: readonly XY[], cell: number): Window {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const i0 = Math.floor(x0 / cell);
  const j0 = Math.floor(y0 / cell);
  const i1 = Math.ceil(x1 / cell);
  const j1 = Math.ceil(y1 / cell);
  return { cell, i0, j0, nx: Math.max(1, i1 - i0), ny: Math.max(1, j1 - j0) };
}

/** Rows `b0 ..` of a window, at most `band` of them. */
export function band(win: Window, b0: number, rows: number): Window {
  return {
    cell: win.cell,
    i0: win.i0,
    j0: win.j0 + b0,
    nx: win.nx,
    ny: Math.min(rows, win.ny - b0),
  };
}

/** Area each segment adds to the accumulation buffer (cell units, rows of `stride`). */
function line(
  acc: Float64Array,
  stride: number,
  rows: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) {
    [x0, x1] = [x1, x0];
    [y0, y1] = [y1, y0];
    dir = -1;
  }
  const dxdy = (x1 - x0) / (y1 - y0);
  const r0 = Math.max(0, Math.floor(y0));
  const r1 = Math.min(rows, Math.ceil(y1));
  for (let r = r0; r < r1; r++) {
    const ya = Math.max(r, y0);
    const yb = Math.min(r + 1, y1);
    const dy = yb - ya;
    if (dy <= 0) continue;
    const xa = x0 + (ya - y0) * dxdy;
    const xb = x0 + (yb - y0) * dxdy;
    const d = dy * dir;
    const xl = Math.min(xa, xb);
    const xr = Math.max(xa, xb);
    const il = Math.floor(xl);
    const ir = Math.ceil(xr);
    const at = r * stride;
    if (ir <= il + 1) {
      const xmf = 0.5 * (xa + xb) - il;
      acc[at + il] = (acc[at + il] ?? 0) + (d - d * xmf);
      acc[at + il + 1] = (acc[at + il + 1] ?? 0) + d * xmf;
    } else {
      const s = 1 / (xr - xl);
      const x0f = xl - il;
      const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
      const x1f = xr - ir + 1;
      const am = 0.5 * s * x1f * x1f;
      acc[at + il] = (acc[at + il] ?? 0) + d * a0;
      if (ir === il + 2) {
        acc[at + il + 1] = (acc[at + il + 1] ?? 0) + d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - x0f);
        acc[at + il + 1] = (acc[at + il + 1] ?? 0) + d * (a1 - a0);
        for (let xi = il + 2; xi < ir - 1; xi++) acc[at + xi] = (acc[at + xi] ?? 0) + d * s;
        const a2 = a1 + (ir - il - 3) * s;
        acc[at + ir - 1] = (acc[at + ir - 1] ?? 0) + d * (1 - a2 - am);
      }
      acc[at + ir] = (acc[at + ir] ?? 0) + d * am;
    }
  }
}

const SNAP_COVER = 1e-12;

/** Exact share of each window cell inside the ring (local metres), rows from the south. */
export function coverage(ring: readonly XY[], win: Window): Float64Array {
  const { cell, i0, j0, nx, ny } = win;
  const stride = nx + 3;
  const acc = new Float64Array(ny * stride);
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % n];
    if (!a || !b) continue;
    // cell units, shifted one column right so a vertex on the window's left edge stays inside
    line(
      acc,
      stride,
      ny,
      a[0] / cell - i0 + 1,
      a[1] / cell - j0,
      b[0] / cell - i0 + 1,
      b[1] / cell - j0,
    );
  }
  const out = new Float64Array(ny * nx);
  for (let r = 0; r < ny; r++) {
    let s = acc[r * stride] ?? 0;
    for (let i = 0; i < nx; i++) {
      s += acc[r * stride + i + 1] ?? 0;
      let w = Math.abs(s);
      if (w > 1 - SNAP_COVER) w = 1;
      else if (w < SNAP_COVER) w = 0;
      out[r * nx + i] = w;
    }
  }
  return out;
}
