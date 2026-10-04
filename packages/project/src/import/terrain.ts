import type { Vec3 } from '@aio/schema';

/**
 * A north-up height grid in a projected CRS: cell (i, j) has its centre at
 * `E = x0 + (i + 0.5) * res`, `N = y1 - (j + 0.5) * res`. NaN is no data.
 */
export interface HeightGrid {
  w: number;
  h: number;
  res: number;
  x0: number;
  y1: number;
  z: Float32Array;
}

/** Read a 2D little-endian float32 `.npy` array (C order). */
export function readNpyF32(buf: Uint8Array): { h: number; w: number; data: Float32Array } {
  if (buf[0] !== 0x93 || String.fromCharCode(...buf.subarray(1, 6)) !== 'NUMPY')
    throw new Error('Not a .npy file');
  const major = buf[6] ?? 1;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hl = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const hs = major === 1 ? 10 : 12;
  const header = new TextDecoder('latin1').decode(buf.subarray(hs, hs + hl));
  if (!/'descr':\s*'<f4'/.test(header)) throw new Error(`.npy dtype is not <f4: ${header}`);
  if (/'fortran_order':\s*True/.test(header)) throw new Error('.npy in Fortran order');
  const m = /'shape':\s*\((\d+),\s*(\d+)\)/.exec(header);
  if (!m) throw new Error(`.npy is not 2D: ${header}`);
  const h = Number(m[1]);
  const w = Number(m[2]);
  const start = buf.byteOffset + hs + hl;
  const data = new Float32Array(buf.buffer.slice(start, start + w * h * 4));
  if (data.length !== w * h) throw new Error('.npy is shorter than its shape');
  return { h, w, data };
}

/** Mean of each f x f block; blocks with fewer than `minFrac` valid samples become no data. */
export function blockMean(g: HeightGrid, f: number, minFrac = 0.5): HeightGrid {
  const w = Math.floor(g.w / f);
  const h = Math.floor(g.h / f);
  const z = new Float32Array(w * h);
  const need = Math.max(1, Math.ceil(minFrac * f * f));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0;
      let n = 0;
      for (let y = 0; y < f; y++) {
        const row = (j * f + y) * g.w + i * f;
        for (let x = 0; x < f; x++) {
          const v = g.z[row + x] ?? NaN;
          if (v === v) {
            s += v;
            n++;
          }
        }
      }
      z[j * w + i] = n >= need ? s / n : NaN;
    }
  }
  return { w, h, res: g.res * f, x0: g.x0, y1: g.y1, z };
}

/** Bilinear height between cell centres; null outside the grid or next to no data. */
export function sampleHeight(g: HeightGrid, e: number, n: number): number | null {
  const fx = (e - g.x0) / g.res - 0.5;
  const fy = (g.y1 - n) / g.res - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= g.w - 1 || j >= g.h - 1) return null;
  const k = j * g.w + i;
  const a = g.z[k] ?? NaN;
  const b = g.z[k + 1] ?? NaN;
  const c = g.z[k + g.w] ?? NaN;
  const d = g.z[k + g.w + 1] ?? NaN;
  if (!(a === a && b === b && c === c && d === d)) return null;
  const tx = fx - i;
  const ty = fy - j;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

type Ring = readonly (readonly [number, number])[];

/** Even-odd point in polygon (ring closed implicitly). */
export function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] ?? [0, 0];
    const [xj, yj] = ring[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(x: number, y: number, ring: Ring): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j] ?? [0, 0];
    const [bx, by] = ring[i] ?? [0, 0];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

export interface TerrainRegion {
  name: string;
  /** Outline in E, N. */
  ring: Ring;
}

export interface TerrainPart {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface TerrainOptions {
  /** Project origin (E, N, H): local `x = E - E0`, `y = H - H0`, `z = -(N - N0)`. */
  origin: Vec3;
  regions: readonly TerrainRegion[];
  /** Cells within this distance (m) of a region outline belong to the region. */
  regionBuffer: number;
  /** Ground window the texture spans (u right from x0, v down from y1). */
  uvWindow: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Terrain from a height lattice: 2 x 2 lattice cells form one coarse cell. Coarse cells owned by a
 * region (centre inside the outline or within `regionBuffer` of it) are meshed at the lattice
 * spacing into that region's part; all others at twice the spacing into the ground part. Edge
 * midpoints of fine cells next to a coarse cell are moved onto the coarse edge, so the two
 * resolutions meet without cracks. Only cells with data at all four corners are meshed.
 */
export function buildTerrain(
  g: HeightGrid,
  opts: TerrainOptions,
): { ground: TerrainPart; regions: TerrainPart[] } {
  const cw = Math.floor((g.w - 1) / 2);
  const ch = Math.floor((g.h - 1) / 2);
  const E = (i: number) => g.x0 + (i + 0.5) * g.res;
  const N = (j: number) => g.y1 - (j + 0.5) * g.res;

  // owner of each coarse cell: region index or -1
  const owner = new Int16Array(cw * ch).fill(-1);
  const boxes = opts.regions.map((r) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of r.ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const b = opts.regionBuffer;
    return { x0: x0 - b, y0: y0 - b, x1: x1 + b, y1: y1 + b };
  });
  for (let cj = 0; cj < ch; cj++) {
    for (let ci = 0; ci < cw; ci++) {
      const x = E(2 * ci + 1);
      const y = N(2 * cj + 1);
      let best = -1;
      let bestD = Infinity;
      opts.regions.forEach((r, k) => {
        const b = boxes[k];
        if (best >= 0 && bestD === 0) return;
        if (!b || x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return;
        const d = pointInRing(x, y, r.ring) ? 0 : distToRing(x, y, r.ring);
        if (d <= opts.regionBuffer && d < bestD) {
          best = k;
          bestD = d;
        }
      });
      owner[cj * cw + ci] = best;
    }
  }
  const ownerAt = (ci: number, cj: number) =>
    ci < 0 || cj < 0 || ci >= cw || cj >= ch ? -1 : (owner[cj * cw + ci] ?? -1);

  // lattice heights with edge midpoints snapped where a fine cell meets a coarse cell
  const zAt = (i: number, j: number) => g.z[j * g.w + i] ?? NaN;
  const height = (i: number, j: number): number => {
    const oddI = i % 2 === 1;
    const oddJ = j % 2 === 1;
    if (oddI && !oddJ) {
      // on a horizontal coarse edge between coarse rows j/2 - 1 and j/2
      const ci = (i - 1) / 2;
      if (ownerAt(ci, j / 2 - 1) < 0 || ownerAt(ci, j / 2) < 0)
        return (zAt(i - 1, j) + zAt(i + 1, j)) / 2;
    } else if (!oddI && oddJ) {
      const cj = (j - 1) / 2;
      if (ownerAt(i / 2 - 1, cj) < 0 || ownerAt(i / 2, cj) < 0)
        return (zAt(i, j - 1) + zAt(i, j + 1)) / 2;
    }
    return zAt(i, j);
  };
  const valid = (i: number, j: number) => zAt(i, j) === zAt(i, j);

  const [e0, n0, h0] = opts.origin;
  const uw = opts.uvWindow;
  const builders = [...opts.regions.map((r) => new PartBuilder(r.name)), new PartBuilder('ground')];
  const vertex = (b: PartBuilder, i: number, j: number): number =>
    b.vertex(j * g.w + i, () => {
      const e = E(i);
      const n = N(j);
      // normal from central differences of the unsnapped lattice
      const dzdx = slope(zAt, i, j, 1, 0, g) / g.res;
      const dzdn = -slope(zAt, i, j, 0, 1, g) / g.res; // row index grows southwards
      const nx = -dzdx;
      const nz = dzdn; // local z points south: dH/dz = -dH/dN
      const len = Math.hypot(nx, 1, nz);
      return {
        p: [e - e0, height(i, j) - h0, -(n - n0)],
        n: [nx / len, 1 / len, nz / len],
        uv: [(e - uw.x0) / (uw.x1 - uw.x0), (uw.y1 - n) / (uw.y1 - uw.y0)],
      };
    });
  const quad = (b: PartBuilder, i: number, j: number, s: number) => {
    if (!(valid(i, j) && valid(i + s, j) && valid(i, j + s) && valid(i + s, j + s))) return;
    const a = vertex(b, i, j);
    const r = vertex(b, i + s, j);
    const c = vertex(b, i, j + s);
    const d = vertex(b, i + s, j + s);
    // counter-clockwise seen from above (+Y): x east, z south
    b.tri(a, c, r);
    b.tri(r, c, d);
  };
  for (let cj = 0; cj < ch; cj++) {
    for (let ci = 0; ci < cw; ci++) {
      const o = owner[cj * cw + ci] ?? -1;
      const i = 2 * ci;
      const j = 2 * cj;
      if (o < 0) {
        const b = builders[builders.length - 1];
        if (b) quad(b, i, j, 2);
      } else {
        const b = builders[o];
        if (!b) continue;
        quad(b, i, j, 1);
        quad(b, i + 1, j, 1);
        quad(b, i, j + 1, 1);
        quad(b, i + 1, j + 1, 1);
      }
    }
  }
  const parts = builders.map((b) => b.build());
  const ground = parts.pop();
  if (!ground) throw new Error('unreachable');
  return { ground, regions: parts.filter((p) => p.indices.length > 0) };
}

function slope(
  zAt: (i: number, j: number) => number,
  i: number,
  j: number,
  di: number,
  dj: number,
  g: HeightGrid,
): number {
  const ok = (a: number, b: number) =>
    a >= 0 && b >= 0 && a < g.w && b < g.h && zAt(a, b) === zAt(a, b);
  const p = ok(i + di, j + dj);
  const m = ok(i - di, j - dj);
  if (p && m) return (zAt(i + di, j + dj) - zAt(i - di, j - dj)) / 2;
  if (p) return zAt(i + di, j + dj) - zAt(i, j);
  if (m) return zAt(i, j) - zAt(i - di, j - dj);
  return 0;
}

class PartBuilder {
  private readonly map = new Map<number, number>();
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly idx: number[] = [];

  constructor(readonly name: string) {}

  vertex(key: number, make: () => { p: number[]; n: number[]; uv: number[] }): number {
    let v = this.map.get(key);
    if (v === undefined) {
      const m = make();
      v = this.pos.length / 3;
      this.pos.push(...m.p);
      this.nor.push(...m.n);
      this.uv.push(...m.uv);
      this.map.set(key, v);
    }
    return v;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  build(): TerrainPart {
    return {
      name: this.name,
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nor),
      uvs: Float32Array.from(this.uv),
      indices: Uint32Array.from(this.idx),
    };
  }
}
