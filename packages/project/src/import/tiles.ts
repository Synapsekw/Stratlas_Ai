import type { Vec3 } from '@aio/schema';
import { mapPoint, type FrameMap } from './frames';

/** A source raster tile placed by its four ground corners (TL, TR, BR, BL; x, z of a Y-up frame). */
export interface PlacedTile {
  f: string;
  c: readonly (readonly [number, number])[];
}

/** Column and row of a tile file named like `ortho/H_03_01.webp` (column first). */
export function tileIndexOf(f: string): { i: number; j: number } | null {
  const m = /_(\d+)_(\d+)\.[a-z]+$/i.exec(f);
  if (!m) return null;
  return { i: Number(m[1]), j: Number(m[2]) };
}

/** A regular tile grid in the ground plane: tile (i, j) has its top-left corner at `o + i u + j v`. */
export interface TileGrid {
  o: [number, number];
  /** One tile step to the right (image +x). */
  u: [number, number];
  /** One tile step down (image +y). */
  v: [number, number];
  /** Root mean square residual of the top-left corners (m). */
  rms: number;
  /** Highest column and row index present. */
  maxI: number;
  maxJ: number;
}

function solve3(m: number[][], b: number[]): [number, number, number] {
  const a = m.map((r, i) => [...r, b[i] ?? 0]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r]?.[c] ?? 0) > Math.abs(a[p]?.[c] ?? 0)) p = r;
    const tmp = a[c];
    a[c] = a[p] ?? [];
    a[p] = tmp ?? [];
    const piv = a[c]?.[c] ?? 0;
    if (Math.abs(piv) < 1e-12) throw new Error('Tile grid is degenerate');
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = (a[r]?.[c] ?? 0) / piv;
      for (let k = c; k < 4; k++) {
        const row = a[r];
        if (row) row[k] = (row[k] ?? 0) - f * (a[c]?.[k] ?? 0);
      }
    }
  }
  return [0, 1, 2].map((i) => (a[i]?.[3] ?? 0) / (a[i]?.[i] ?? 1)) as [number, number, number];
}

/**
 * Fit the grid from the top-left corners of the tiles (edge tiles may be narrower, so only the
 * top-left corner of each tile is a grid point). Least squares over every tile.
 */
export function fitTileGrid(tiles: readonly PlacedTile[]): TileGrid {
  const pts: { i: number; j: number; x: number; z: number }[] = [];
  for (const t of tiles) {
    const ij = tileIndexOf(t.f);
    const tl = t.c[0];
    if (!ij || !tl) continue;
    pts.push({ ...ij, x: tl[0], z: tl[1] });
  }
  if (pts.length < 3) throw new Error('Need at least three tiles to fit a grid');
  const n = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const bz = [0, 0, 0];
  for (const p of pts) {
    const r = [1, p.i, p.j];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const row = n[a];
        if (row) row[b] = (row[b] ?? 0) + (r[a] ?? 0) * (r[b] ?? 0);
      }
      bx[a] = (bx[a] ?? 0) + (r[a] ?? 0) * p.x;
      bz[a] = (bz[a] ?? 0) + (r[a] ?? 0) * p.z;
    }
  }
  const [ox, ux, vx] = solve3(n, bx);
  const [oz, uz, vz] = solve3(n, bz);
  let ss = 0;
  for (const p of pts) {
    ss += Math.hypot(ox + p.i * ux + p.j * vx - p.x, oz + p.i * uz + p.j * vz - p.z) ** 2;
  }
  return {
    o: [ox, oz],
    u: [ux, uz],
    v: [vx, vz],
    rms: Math.sqrt(ss / pts.length),
    maxI: Math.max(...pts.map((p) => p.i)),
    maxJ: Math.max(...pts.map((p) => p.j)),
  };
}

/** Ground point of grid coordinates (i, j) (fractional tiles). */
export function gridPoint(g: TileGrid, i: number, j: number): [number, number] {
  return [g.o[0] + i * g.u[0] + j * g.v[0], g.o[1] + i * g.u[1] + j * g.v[1]];
}

export interface Corners {
  tl: Vec3;
  tr: Vec3;
  bl: Vec3;
}

/**
 * Corners (in the project local frame) of `cols` x `rows` tiles of grid `g` starting at its origin,
 * at source height `y` (source frame Y up, as the grid's x, z).
 */
export function gridCorners(
  g: TileGrid,
  cols: number,
  rows: number,
  y: number,
  frame: FrameMap,
): Corners {
  const at = (i: number, j: number): Vec3 => {
    const [x, z] = gridPoint(g, i, j);
    return mapPoint(frame, [x, y, z]);
  };
  return { tl: at(0, 0), tr: at(cols, 0), bl: at(0, rows) };
}

/**
 * Tile pixel size of an edge tile: the source cuts edge tiles at the data extent, so a tile whose
 * ground width is a fraction of the grid step holds that fraction of the full pixel width.
 */
export function tileFraction(g: TileGrid, t: PlacedTile): { fu: number; fv: number } {
  const [tl, tr, , bl] = t.c;
  if (!tl || !tr || !bl) return { fu: 1, fv: 1 };
  const lu = Math.hypot(g.u[0], g.u[1]);
  const lv = Math.hypot(g.v[0], g.v[1]);
  return {
    fu: Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) / lu,
    fv: Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) / lv,
  };
}

/** Affine map from image pixels (px right, py down) to ground x, z: `g = a * [px, py, 1]`. */
export interface PixelAffine {
  ax: [number, number, number];
  az: [number, number, number];
  rms: number;
  max: number;
}

/** Least-squares affine from pixel positions to ground points. */
export function fitPixelAffine(
  pairs: readonly { px: number; py: number; x: number; z: number }[],
): PixelAffine {
  const n = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const bz = [0, 0, 0];
  for (const p of pairs) {
    const r = [p.px, p.py, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const row = n[a];
        if (row) row[b] = (row[b] ?? 0) + (r[a] ?? 0) * (r[b] ?? 0);
      }
      bx[a] = (bx[a] ?? 0) + (r[a] ?? 0) * p.x;
      bz[a] = (bz[a] ?? 0) + (r[a] ?? 0) * p.z;
    }
  }
  const ax = solve3(n, bx);
  const az = solve3(n, bz);
  let ss = 0;
  let max = 0;
  for (const p of pairs) {
    const e = Math.hypot(
      ax[0] * p.px + ax[1] * p.py + ax[2] - p.x,
      az[0] * p.px + az[1] * p.py + az[2] - p.z,
    );
    ss += e * e;
    max = Math.max(max, e);
  }
  return { ax, az, rms: Math.sqrt(ss / Math.max(1, pairs.length)), max };
}

export function applyPixelAffine(a: PixelAffine, px: number, py: number): [number, number] {
  return [a.ax[0] * px + a.ax[1] * py + a.ax[2], a.az[0] * px + a.az[1] * py + a.az[2]];
}

/** Inverse of {@link applyPixelAffine}: ground x, z to pixel position. */
export function invertPixelAffine(a: PixelAffine, x: number, z: number): [number, number] {
  const [a11, a12, a13] = a.ax;
  const [a21, a22, a23] = a.az;
  const det = a11 * a22 - a12 * a21;
  const dx = x - a13;
  const dz = z - a23;
  return [(a22 * dx - a12 * dz) / det, (-a21 * dx + a11 * dz) / det];
}
