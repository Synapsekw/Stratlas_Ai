/**
 * Bases (data-conventions section 26), the TypeScript twin of `aio_pipelines/survey/bases.py`.
 * A base is sampled on the surface side of its item: along the polygon's edges densified at the
 * step, or over the covered cells; samples without data are left out. A level needs one valid
 * sample, a plane or a TIN three, else the item is refused with the reason.
 */
import type { BaseSpec } from '@aio/schema';
import type { XY } from './geometry';
import { delaunay } from './delaunay';
import { Tin, type Planar } from './tin';

/** Perimeter sample step on the exact path (no grid), unless the item gives `cellM`. */
export const TIN_STEP_M = 0.1;

/** An item that cannot be computed; the message is the result's reason. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refused';
  }
}

/** Metres with three decimals, rounded half away from zero (the same in both executors). */
export function f3(x: number): string {
  const n = Math.floor(Math.abs(x) * 1000 + 0.5);
  const sign = x < 0 && n > 0 ? '-' : '';
  return `${sign}${Math.floor(n / 1000)}.${String(n % 1000).padStart(3, '0')}`;
}

/**
 * Least-squares plane `z = p0 + p1 (x - ox) + p2 (y - oy)`: normal equations solved by
 * Gauss-Jordan with partial pivoting, the stockpile kit's arithmetic step by step.
 */
export function fitPlane(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  zs: ArrayLike<number>,
  ox: number,
  oy: number,
): [number, number, number] {
  const a = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const r = [0, 0, 0];
  for (let k = 0; k < zs.length; k++) {
    const v = [1, (xs[k] ?? 0) - ox, (ys[k] ?? 0) - oy];
    const z = zs[k] ?? 0;
    for (let i = 0; i < 3; i++) {
      const row = a[i];
      if (!row) continue;
      r[i] = (r[i] ?? 0) + (v[i] ?? 0) * z;
      for (let j = 0; j < 3; j++) row[j] = (row[j] ?? 0) + (v[i] ?? 0) * (v[j] ?? 0);
    }
  }
  const M = a.map((row, i) => [...row, r[i] ?? 0]);
  const at = (i: number, j: number) => M[i]?.[j] ?? 0;
  for (let i = 0; i < 3; i++) {
    let pv = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(at(k, i)) > Math.abs(at(pv, i))) pv = k;
    const mi = M[i];
    const mp = M[pv];
    if (mi && mp) {
      M[i] = mp;
      M[pv] = mi;
    }
    if (Math.abs(at(i, i)) < 1e-9) continue;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = at(k, i) / at(i, i);
      const rk = M[k];
      const ri = M[i];
      if (!rk || !ri) continue;
      for (let q = i; q < 4; q++) rk[q] = (rk[q] ?? 0) - f * (ri[q] ?? 0);
    }
  }
  const pc = [0, 1, 2].map((i) => (Math.abs(at(i, i)) < 1e-9 ? 0 : at(i, 3) / at(i, i)));
  return [pc[0] ?? 0, pc[1] ?? 0, pc[2] ?? 0];
}

export const planeFn =
  ([p0, p1, p2]: [number, number, number], ox: number, oy: number) =>
  (x: number, y: number) =>
    p0 + p1 * (x - ox) + p2 * (y - oy);

const level = (z: number): Planar => ({ kind: 'planar', fn: () => z, level: z });

export interface Samples {
  xs: Float64Array;
  ys: Float64Array;
  zs: Float64Array;
}

export interface BaseInputs {
  ring: readonly XY[];
  perimeter: () => Promise<Samples>;
  interior: () => Promise<[number, number] | null>;
  atPoints: (xs: Float64Array, ys: Float64Array) => Promise<Float64Array>;
  toLocal: (e: number, n: number) => [number, number];
}

function seqSum(v: ArrayLike<number>): number {
  let s = 0;
  for (const x of Array.from(v)) s += x;
  return s;
}

function minMax(v: Float64Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const z of v) {
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  return [lo, hi];
}

/** A base as a side of the comparison and its label (`Refused` when it cannot be built). */
export async function buildBase(spec: BaseSpec, inp: BaseInputs): Promise<[Planar | Tin, string]> {
  switch (spec.kind) {
    case 'reference': {
      if (spec.mode === 'level') {
        const z = spec.levelM ?? 0;
        return [level(z), `Level ${f3(z)} m`];
      }
      if (spec.mode === 'perimeter-max' || spec.mode === 'perimeter-min') {
        const s = await inp.perimeter();
        if (s.zs.length === 0) throw new Refused("The polygon's edge has no survey under it.");
        const [lo, hi] = minMax(s.zs);
        const z = spec.mode === 'perimeter-max' ? hi : lo;
        const word = spec.mode === 'perimeter-max' ? 'Highest' : 'Lowest';
        return [level(z), `${word} point on the perimeter (${f3(z)} m)`];
      }
      const ext = await inp.interior();
      if (!ext) throw new Refused('The polygon has no survey under it.');
      const z = spec.mode === 'interior-max' ? ext[1] : ext[0];
      const word = spec.mode === 'interior-max' ? 'Highest' : 'Lowest';
      return [level(z), `${word} point inside (${f3(z)} m)`];
    }
    case 'perimeter-mean': {
      const s = await inp.perimeter();
      if (s.zs.length === 0) throw new Refused("The polygon's edge has no survey under it.");
      const z = seqSum(s.zs) / s.zs.length;
      return [level(z), `Mean perimeter level (${f3(z)} m)`];
    }
    case 'fit-plane': {
      const s = await inp.perimeter();
      if (s.zs.length < 3)
        throw new Refused("The polygon's edge has too little survey under it for a plane.");
      let ox = Infinity;
      let oy = Infinity;
      for (const [x, y] of inp.ring) {
        ox = Math.min(ox, x);
        oy = Math.min(oy, y);
      }
      const p = fitPlane(s.xs, s.ys, s.zs, ox, oy);
      return [
        { kind: 'planar', fn: planeFn(p, ox, oy), plane: { p, ox, oy } },
        'Best-fit plane through the perimeter',
      ];
    }
    case 'smart': {
      const s = await inp.perimeter();
      if (s.zs.length < 3)
        throw new Refused("The polygon's edge has too little survey under it for a smart base.");
      const tris = delaunay(s.xs, s.ys);
      if (tris.length === 0) throw new Refused("The polygon's edge samples lie on a line.");
      return [new Tin(s.xs, s.ys, s.zs, tris), 'Smart base (triangulated perimeter)'];
    }
    case 'custom': {
      const n = spec.vertices.length;
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      const zs = new Float64Array(n);
      const need: number[] = [];
      spec.vertices.forEach((v, k) => {
        const [x, y] = inp.toLocal(v.e, v.n);
        xs[k] = x;
        ys[k] = y;
        if (v.z !== undefined) zs[k] = v.z;
        else need.push(k);
      });
      if (need.length) {
        const under = await inp.atPoints(
          Float64Array.from(need.map((k) => xs[k] ?? 0)),
          Float64Array.from(need.map((k) => ys[k] ?? 0)),
        );
        need.forEach((k, m) => {
          const z = under[m] ?? NaN;
          if (!Number.isFinite(z))
            throw new Refused(`Custom base vertex ${k + 1} has no survey under it.`);
          zs[k] = z + (spec.vertices[k]?.offsetM ?? 0);
        });
      }
      const tris = delaunay(xs, ys);
      if (tris.length === 0) throw new Refused('The custom base vertices lie on a line.');
      return [new Tin(xs, ys, zs, tris), `Custom base (${n} vertices)`];
    }
  }
}
