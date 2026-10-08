/**
 * Boundary editor maths, ported from the Volumetric Survey Kit viewer (`editGeom`,
 * `editVolumes`, `simplify`): an edited toe line refits all four bases to every point of the
 * line, then the volume is summed on the 10 cm job grid inside the line.
 * Coordinates are easting and northing in the project CRS.
 */
import type { BaseVolumes, VolumeBaseId } from '@aio/schema';
import { Accumulator, fitPlane, perimeterLevels } from '@aio/survey';
import { BASE_IDS } from './volume';

export type EN = [number, number];

/** Surface height at (E, N), or null where there is no data. */
export type Surface = (E: number, N: number) => number | null;

/** Points every `step` metres along each edge of a closed ring (the kit's `dens`). */
export function densify(ring: readonly EN[], step: number): EN[] {
  const out: EN[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (!a || !b) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let s = 0; s < n; s++)
      out.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  return out;
}

/** Sorted eastings where the row at northing `N` crosses the ring. */
export function spans(ring: readonly EN[], N: number): number[] {
  const xs: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (!a || !b) continue;
    if (a[1] > N !== b[1] > N) xs.push(a[0] + ((N - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  return xs.sort((p, q) => p - q);
}

export function ringArea(ring: readonly EN[]): number {
  let s = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (a && b) s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/**
 * Douglas-Peucker on both halves of a closed ring, then points closer than 1.5 m merged: the
 * editable line the kit offers for a dense automatic toe line.
 */
export function simplifyRing(ring0: readonly EN[], tol: number): EN[] {
  const r = ring0.map((q): EN => [q[0], q[1]]);
  const first = r[0];
  const last = r.at(-1);
  if (r.length > 2 && first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6)
    r.pop();
  if (r.length < 8) return r;
  const r0 = r[0] ?? [0, 0];
  let far = 0;
  let fd = -1;
  r.forEach((q, i) => {
    const d = Math.hypot(q[0] - r0[0], q[1] - r0[1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  });
  const n = r.length;
  const P = (i: number): EN => r[i % n] ?? r0;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const dp = (a: number, b: number) => {
    let mx = 0;
    let mi = -1;
    const [x1, y1] = P(a);
    const [x2, y2] = P(b);
    const L = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const q = P(i);
      const d = Math.abs((x2 - x1) * (y1 - q[1]) - (x1 - q[0]) * (y2 - y1)) / L;
      if (d > mx) {
        mx = d;
        mi = i;
      }
    }
    if (mx > tol && mi > 0) {
      keep[mi % n] = 1;
      dp(a, mi);
      dp(mi, b);
    }
  };
  dp(0, far);
  dp(far, n);
  const out: EN[] = [];
  r.forEach((q, i) => {
    const prev = out.at(-1);
    if (keep[i] && (!prev || Math.hypot(q[0] - prev[0], q[1] - prev[1]) > 1.5)) out.push(q);
  });
  const o0 = out[0];
  const oz = out.at(-1);
  if (out.length > 3 && o0 && oz && Math.hypot(o0[0] - oz[0], o0[1] - oz[1]) < 1.5) out.pop();
  return out.length >= 4 ? out : r;
}

export interface EditGeometry {
  ring: EN[];
  surf: Surface;
  baseAt(base: VolumeBaseId, E: number, N: number): number;
  /** [minE, minN, maxE, maxN] of the ring. */
  bbox: [number, number, number, number];
  low: number;
  avg: number;
}

/**
 * Bases fitted to an edited toe line: lowest and average height of the line sampled every
 * 0.5 m, the least-squares plane through those samples, and a smooth membrane (0.5 m grid,
 * successive over-relaxation) pinned to the ground just outside the line.
 */
export function editGeometry(ring: readonly EN[], surf: Surface): EditGeometry | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [E, N] of ring) {
    x0 = Math.min(x0, E);
    x1 = Math.max(x1, E);
    y0 = Math.min(y0, N);
    y1 = Math.max(y1, N);
  }
  const bs: [number, number, number][] = [];
  for (const [E, N] of densify(ring, 0.5)) {
    const z = surf(E, N);
    if (z != null) bs.push([E, N, z]);
  }
  if (bs.length < 3) return null;
  // the survey engine's bases (data-conventions section 26): perimeter-min (the kit's low),
  // perimeter-mean (avg) and fit-plane (plane), the kit's arithmetic step by step
  const xs = Float64Array.from(bs, (q) => q[0]);
  const ys = Float64Array.from(bs, (q) => q[1]);
  const zs = Float64Array.from(bs, (q) => q[2]);
  const { min: lo, mean: avg } = perimeterLevels(zs);
  const [p0, p1, p2] = fitPlane(xs, ys, zs, x0, y0);
  const plane = (E: number, N: number) => p0 + p1 * (E - x0) + p2 * (N - y0);

  // triangulated toe: membrane pinned to the ground just outside the line
  const R = 0.5;
  const gx0 = x0 - R * 2;
  const gy1 = y1 + R * 2;
  const gw = Math.ceil((x1 - x0) / R) + 5;
  const gh = Math.ceil((y1 - y0) / R) + 5;
  const v = new Float64Array(gw * gh);
  const ins = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const N = gy1 - (j + 0.5) * R;
    const xs = spans(ring, N);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ia = Math.max(0, Math.ceil(((xs[k] ?? 0) - gx0) / R - 0.5));
      const ib = Math.min(gw - 1, Math.floor(((xs[k + 1] ?? 0) - gx0) / R - 0.5));
      for (let i = ia; i <= ib; i++) ins[j * gw + i] = 1;
    }
  }
  const unk: number[] = [];
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const E = gx0 + (i + 0.5) * R;
      const N = gy1 - (j + 0.5) * R;
      if (ins[k]) {
        v[k] = plane(E, N);
        if (i > 0 && j > 0 && i < gw - 1 && j < gh - 1) unk.push(k);
      } else {
        v[k] = surf(E, N) ?? plane(E, N);
      }
    }
  }
  const val = (k: number) => v[k] ?? 0;
  for (let it = 0; it < 260; it++) {
    for (const k of unk) {
      const nv = (val(k - 1) + val(k + 1) + val(k - gw) + val(k + gw)) / 4;
      v[k] = val(k) + 1.85 * (nv - val(k));
    }
  }
  const tin = (E: number, N: number) => {
    const fx = Math.max(0, Math.min(gw - 1.001, (E - gx0) / R - 0.5));
    const fy = Math.max(0, Math.min(gh - 1.001, (gy1 - N) / R - 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const k = j * gw + i;
    return (
      (val(k) * (1 - tx) + val(k + 1) * tx) * (1 - ty) +
      (val(k + gw) * (1 - tx) + val(k + gw + 1) * tx) * ty
    );
  };
  const baseAt = (b: VolumeBaseId, E: number, N: number) =>
    b === 'low' ? lo : b === 'avg' ? avg : b === 'plane' ? plane(E, N) : tin(E, N);
  return {
    ring: ring.map((q): EN => [q[0], q[1]]),
    surf,
    baseAt,
    bbox: [x0, y0, x1, y1],
    low: lo,
    avg,
  };
}

export interface EditResult {
  volumes: BaseVolumes;
  areaM2: number;
  topM: number;
  heightM: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Fill, cut and net against every base inside the edited line, summed on the 10 cm job grid
 * (cell centres from `gridX0`, `gridY1`), rounded like the kit (0.1 m³, 0.01 m).
 */
export function editVolumes(g: EditGeometry, gridX0: number, gridY1: number): EditResult {
  const R = 0.1;
  const A = R * R;
  // the survey engine's sums, a weight of 1 per cell whose centre is inside the line (the kit's grid)
  const acc: Record<VolumeBaseId, Accumulator> = {
    tin: new Accumulator(),
    plane: new Accumulator(),
    avg: new Accumulator(),
    low: new Accumulator(),
  };
  let n = 0;
  let top = -Infinity;
  let bmin = Infinity;
  const [, y0, , y1] = g.bbox;
  const j0 = Math.floor((gridY1 - y1) / R);
  const j1 = Math.ceil((gridY1 - y0) / R);
  for (let j = j0; j <= j1; j++) {
    const N = gridY1 - (j + 0.5) * R;
    const xs = spans(g.ring, N);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ia = Math.ceil(((xs[k] ?? 0) - gridX0) / R - 0.5);
      const ib = Math.floor(((xs[k + 1] ?? 0) - gridX0) / R - 0.5);
      for (let i = ia; i <= ib; i++) {
        const E = gridX0 + (i + 0.5) * R;
        const z = g.surf(E, N);
        if (z == null) continue;
        n++;
        if (z > top) top = z;
        for (const b of BASE_IDS) acc[b].add(1, z - g.baseAt(b, E, N));
        const bt = g.baseAt('tin', E, N);
        if (bt < bmin) bmin = bt;
      }
    }
  }
  const one = (b: VolumeBaseId) => ({
    fill: r1(acc[b].fill * A),
    cut: r1(acc[b].cut * A),
    net: r1((acc[b].fill - acc[b].cut) * A),
  });
  return {
    volumes: { tin: one('tin'), plane: one('plane'), avg: one('avg'), low: one('low') },
    areaM2: r1(n * A),
    topM: r2(top),
    heightM: r2(top - bmin),
  };
}
