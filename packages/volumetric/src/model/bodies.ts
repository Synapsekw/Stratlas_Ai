/**
 * Volume bodies: a regular grid of cells with the pile surface on top and the base (or the
 * other survey) below, the source of the Propeller-style volume body, the base plate and the
 * cut and fill body in 3D. Ported from the kit viewer's `src*` samplers.
 */
import type { VolumeBaseId } from '@aio/schema';
import { spans, type EditGeometry } from './edit';
import type { CoarseGrids, DsmGrid, PileGrid } from './kitdata';
import { gridBase } from './volume';

export interface BodyCells {
  nx: number;
  ny: number;
  /** Cell size, m. */
  cell: number;
  /** Easting of column 0 and northing of row 0 cell centres; rows run south. */
  e0: number;
  n0: number;
  /** 1 where the cell belongs to the body. */
  ins: Uint8Array;
  top: Float32Array;
  bot: Float32Array;
  /** Change bodies: last minus first survey per cell (negative = cut). */
  d?: Float32Array;
  tmax: number;
  bmin: number;
}

function cells(nx: number, ny: number, cell: number, e0: number, n0: number): BodyCells {
  const n = nx * ny;
  return {
    nx,
    ny,
    cell,
    e0,
    n0,
    ins: new Uint8Array(n),
    top: new Float32Array(n),
    bot: new Float32Array(n),
    tmax: -Infinity,
    bmin: Infinity,
  };
}

function put(b: BodyCells, v: number, top: number, bot: number) {
  b.ins[v] = 1;
  b.top[v] = top;
  b.bot[v] = bot;
  if (top > b.tmax) b.tmax = top;
  if (bot < b.bmin) b.bmin = bot;
}

const done = (b: BodyCells) => (b.tmax === -Infinity ? null : b);

/** One pile on one date over its 10 cm grid, every `step` cells. */
export function fineBody(
  p: PileGrid,
  epoch: string,
  base: VolumeBaseId,
  step: number,
): BodyCells | null {
  const o = p.ep[epoch];
  if (!o?.m) return null;
  const nx = Math.floor((p.w - 1) / step) + 1;
  const ny = Math.floor((p.h - 1) / step) + 1;
  const b = cells(nx, ny, p.res * step, p.x0 + 0.5 * p.res, p.y1 - 0.5 * p.res);
  const baseAt = gridBase(o, base, p);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * step;
      const y = j * step;
      const k = y * p.w + x;
      if (!o.m[k]) continue;
      put(b, j * nx + i, (o.z[k] ?? 0) / 100 + p.zoff, baseAt(x, y, k));
    }
  }
  return done(b);
}

/** Surface to surface change inside the pile zone on its 10 cm grid. */
export function changeBodyFine(
  p: PileGrid,
  first: string,
  last: string,
  deadband: number,
  step: number,
): BodyCells | null {
  const a = p.ep[first]?.z;
  const c = p.ep[last]?.z;
  if (!a || !c) return null;
  const nx = Math.floor((p.w - 1) / step) + 1;
  const ny = Math.floor((p.h - 1) / step) + 1;
  const b = cells(nx, ny, p.res * step, p.x0 + 0.5 * p.res, p.y1 - 0.5 * p.res);
  const d = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * step * p.w + i * step;
      if (!p.zone[k]) continue;
      const z1 = (a[k] ?? 0) / 100 + p.zoff;
      const z2 = (c[k] ?? 0) / 100 + p.zoff;
      if (Math.abs(z2 - z1) <= deadband) continue;
      const v = j * nx + i;
      put(b, v, Math.max(z1, z2), Math.min(z1, z2));
      d[v] = z2 - z1;
    }
  }
  b.d = d;
  return done(b);
}

/** One pile on one date from the kit's 0.4 m masks over the site DSM. */
export function coarseBody(
  v: CoarseGrids,
  dsm: DsmGrid,
  pile: string,
  epoch: string,
  base: VolumeBaseId,
): BodyCells | null {
  const p = v.piles[pile];
  const o = p?.ep[epoch];
  if (!p || !o) return null;
  const R = v.res;
  const b = cells(p.w, p.h, R, v.x0 + (p.bx0 + 0.5) * R, v.y1 - (p.by0 + 0.5) * R);
  const [c0, c1, c2] = o.plane.c;
  for (let j = 0; j < p.h; j++) {
    for (let i = 0; i < p.w; i++) {
      const k = j * p.w + i;
      const g = (p.by0 + j) * dsm.w + p.bx0 + i;
      if (!o.m[k] || !dsm.valid[g]) continue;
      const E = b.e0 + i * R;
      const N = b.n0 - j * R;
      const bot =
        base === 'low'
          ? o.low
          : base === 'avg'
            ? o.avg
            : base === 'plane'
              ? c0 + c1 * (E - o.plane.x0) + c2 * (o.plane.y1 - N)
              : (o.tin[k] ?? 0) / 100 + dsm.zoff;
      put(b, k, (dsm.z[g] ?? 0) / 100 + dsm.zoff, bot);
    }
  }
  return done(b);
}

/** Surface to surface change inside a pile zone from the 0.4 m site DSMs. */
export function changeBodyCoarse(
  v: CoarseGrids,
  first: DsmGrid,
  last: DsmGrid,
  pile: string,
  deadband: number,
): BodyCells | null {
  const p = v.piles[pile];
  if (!p) return null;
  const R = v.res;
  const b = cells(p.w, p.h, R, v.x0 + (p.bx0 + 0.5) * R, v.y1 - (p.by0 + 0.5) * R);
  const d = new Float32Array(p.w * p.h);
  for (let j = 0; j < p.h; j++) {
    for (let i = 0; i < p.w; i++) {
      const k = j * p.w + i;
      const g = (p.by0 + j) * first.w + p.bx0 + i;
      if (!p.zone[k] || !first.valid[g] || !last.valid[g]) continue;
      const z1 = (first.z[g] ?? 0) / 100 + first.zoff;
      const z2 = (last.z[g] ?? 0) / 100 + last.zoff;
      if (Math.abs(z2 - z1) <= deadband) continue;
      put(b, k, Math.max(z1, z2), Math.min(z1, z2));
      d[k] = z2 - z1;
    }
  }
  b.d = d;
  return done(b);
}

/** An edited toe line filled on a regular grid of `step` metres. */
export function editBody(g: EditGeometry, base: VolumeBaseId, step: number): BodyCells {
  const [x0, y0, x1, y1] = g.bbox;
  const nx = Math.ceil((x1 - x0) / step) + 1;
  const ny = Math.ceil((y1 - y0) / step) + 1;
  const b = cells(nx, ny, step, x0 + 0.5 * step, y1 - 0.5 * step);
  for (let j = 0; j < ny; j++) {
    const N = y1 - (j + 0.5) * step;
    const xs = spans(g.ring, N);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ia = Math.max(0, Math.ceil(((xs[k] ?? 0) - x0) / step - 0.5));
      const ib = Math.min(nx - 1, Math.floor(((xs[k + 1] ?? 0) - x0) / step - 0.5));
      for (let i = ia; i <= ib; i++) {
        const E = x0 + (i + 0.5) * step;
        const z = g.surf(E, N);
        if (z != null) put(b, j * nx + i, z, g.baseAt(base, E, N));
      }
    }
  }
  return b;
}
