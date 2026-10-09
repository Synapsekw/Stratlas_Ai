/**
 * Prepared height tiles (`aio.height-tiles/1`, data-conventions section 26) and grid surfaces,
 * the TypeScript twin of `aio_pipelines/survey/grid.py`.
 *
 * A `.bin` tile is a zlib stream (what `DecompressionStream('deflate')` reads) of: `AHT1`, uint32
 * flags, the float64 base height, 65,536 float32 heights relative to the base (row 0 south, column
 * 0 west) and an 8,192-byte nodata mask (bit `k & 7` of byte `k >> 3` set where cell `k` has data),
 * all little-endian. Heights are `base + float32`, so a height keeps 0.06 mm at a 1,000 m range.
 *
 * A grid surface is heights at cell centres ("posts"), sampled bilinearly; a post is needed only
 * when its weight is above zero, and a needed post without data makes the sample nodata (NaN).
 */
import type { Window } from './geometry';

export const TILE = 256;
export const TILE_CELLS = TILE * TILE;
const HEADER = 16;
const MASK_BYTES = TILE_CELLS / 8;
export const TILE_BYTES = HEADER + 4 * TILE_CELLS + MASK_BYTES;
/** Positions this close to a post (in cells) are on it. */
export const SNAP = 1e-9;

/** The search for a cancelled computation. */
export class EngineCancelled extends Error {
  constructor() {
    super('The comparison was cancelled.');
    this.name = 'EngineCancelled';
  }
}

export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineCancelled();
}

/** One decoded tile: heights are `base + rel[k]` where `mask` has the bit. */
export interface Tile {
  base: number;
  rel: Float32Array;
  mask: Uint8Array;
}

/** Inflate a zlib stream (`DecompressionStream('deflate')`, in workers and Node alike). */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Parse an inflated tile. */
export function parseTile(raw: Uint8Array): Tile {
  if (
    raw.length !== TILE_BYTES ||
    raw[0] !== 0x41 ||
    raw[1] !== 0x48 ||
    raw[2] !== 0x54 ||
    raw[3] !== 0x31
  )
    throw new Error('A height tile is not an aio.height-tiles/1 tile.');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const base = view.getFloat64(8, true);
  const rel = new Float32Array(TILE_CELLS);
  for (let k = 0; k < TILE_CELLS; k++) rel[k] = view.getFloat32(HEADER + 4 * k, true);
  const mask = raw.slice(HEADER + 4 * TILE_CELLS);
  return { base, rel, mask };
}

export async function decodeTile(data: Uint8Array): Promise<Tile> {
  return parseTile(await inflate(data));
}

/** A tile from heights (row 0 south; NaN no data), before compression. */
export function buildTile(heights: ArrayLike<number>): Uint8Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < TILE_CELLS; k++) {
    const h = heights[k] ?? NaN;
    if (Number.isFinite(h)) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  const base = lo === Infinity ? 0 : (lo + hi) / 2;
  const raw = new Uint8Array(TILE_BYTES);
  const view = new DataView(raw.buffer);
  raw.set([0x41, 0x48, 0x54, 0x31], 0);
  view.setFloat64(8, base, true);
  for (let k = 0; k < TILE_CELLS; k++) {
    const h = heights[k] ?? NaN;
    if (Number.isFinite(h)) {
      view.setFloat32(HEADER + 4 * k, h - base, true);
      const at = HEADER + 4 * TILE_CELLS + (k >> 3);
      raw[at] = (raw[at] ?? 0) | (1 << (k & 7));
    }
  }
  return raw;
}

export const encodeTile = (heights: ArrayLike<number>): Promise<Uint8Array> =>
  deflate(buildTile(heights));

/**
 * Heights at cell centres: `read` a window of cells (NaN where there is no data). Cell `(i, j)`
 * covers E in `[originE + i cellM, originE + (i + 1) cellM]` and N likewise; `j` grows north.
 */
export interface GridSurface {
  readonly originE: number;
  readonly originN: number;
  readonly cellM: number;
  readonly nx: number;
  readonly ny: number;
  read(i0: number, j0: number, w: number, h: number, signal?: AbortSignal): Promise<Float64Array>;
}

/** A grid surface in memory (fixtures, the stockpile kit's grids). */
export class ArraySurface implements GridSurface {
  constructor(
    readonly originE: number,
    readonly originN: number,
    readonly cellM: number,
    readonly nx: number,
    readonly ny: number,
    /** Row-major, row 0 south; NaN where there is no data. */
    readonly heights: Float64Array,
  ) {}

  readSync(i0: number, j0: number, w: number, h: number): Float64Array {
    const out = new Float64Array(w * h).fill(NaN);
    const a0 = Math.max(i0, 0);
    const a1 = Math.min(i0 + w, this.nx);
    const b0 = Math.max(j0, 0);
    const b1 = Math.min(j0 + h, this.ny);
    for (let j = b0; j < b1; j++) {
      const src = j * this.nx;
      const dst = (j - j0) * w - i0;
      for (let i = a0; i < a1; i++) out[dst + i] = this.heights[src + i] ?? NaN;
    }
    return out;
  }

  read(i0: number, j0: number, w: number, h: number): Promise<Float64Array> {
    return Promise.resolve(this.readSync(i0, j0, w, h));
  }
}

/** The `tiles.json` fields a tile reader needs. */
export interface TilesMeta {
  originE: number;
  originN: number;
  cellM: number;
  cols: number;
  rows: number;
  tiles: readonly string[];
}

/** Heights of a tile (float64 `base + rel`, NaN where there is no data), row 0 south. */
export function tileHeights(t: Tile): Float64Array {
  const out = new Float64Array(TILE_CELLS);
  for (let k = 0; k < TILE_CELLS; k++)
    out[k] = ((t.mask[k >> 3] ?? 0) >> (k & 7)) & 1 ? t.base + (t.rel[k] ?? 0) : NaN;
  return out;
}

/** Small LRU of decoded tiles (heights), shared by the surfaces of one worker. */
export class TileCache {
  private readonly map = new Map<string, Promise<Float64Array | null>>();
  constructor(readonly limit = 256) {}

  get(key: string, load: () => Promise<Float64Array | null>): Promise<Float64Array | null> {
    let p = this.map.get(key);
    if (p) {
      this.map.delete(key);
      this.map.set(key, p);
      return p;
    }
    p = load();
    p.catch(() => this.map.delete(key));
    this.map.set(key, p);
    while (this.map.size > this.limit) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
    return p;
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * A prepared surface read tile by tile through `fetchTile` (the renderer passes a fetch of
 * `aio://project/<id>/survey/surfaces/<surface>/0/<col>_<row>.bin`); only the tiles a window
 * touches are fetched, once, through the cache.
 */
export class TileSurface implements GridSurface {
  readonly originE: number;
  readonly originN: number;
  readonly cellM: number;
  readonly nx: number;
  readonly ny: number;
  private readonly present: Set<string>;

  constructor(
    readonly key: string,
    meta: TilesMeta,
    private readonly fetchTile: (col: number, row: number) => Promise<Uint8Array | null>,
    private readonly cache = new TileCache(),
  ) {
    this.originE = meta.originE;
    this.originN = meta.originN;
    this.cellM = meta.cellM;
    this.nx = meta.cols * TILE;
    this.ny = meta.rows * TILE;
    this.present = new Set(meta.tiles);
  }

  tile(col: number, row: number): Promise<Float64Array | null> {
    if (!this.present.has(`${col}_${row}`)) return Promise.resolve(null);
    return this.cache.get(`${this.key}/${col}_${row}`, async () => {
      const bytes = await this.fetchTile(col, row);
      return bytes ? tileHeights(await decodeTile(bytes)) : null;
    });
  }

  async read(i0: number, j0: number, w: number, h: number, signal?: AbortSignal) {
    const out = new Float64Array(w * h).fill(NaN);
    const a = Math.max(i0, 0);
    const b = Math.max(j0, 0);
    const ae = Math.min(i0 + w, this.nx);
    const be = Math.min(j0 + h, this.ny);
    if (a >= ae || b >= be) return out;
    const c0 = Math.floor(a / TILE);
    const c1 = Math.floor((ae - 1) / TILE);
    const r0 = Math.floor(b / TILE);
    const r1 = Math.floor((be - 1) / TILE);
    const jobs: Promise<void>[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        jobs.push(
          this.tile(c, r).then((t) => {
            checkSignal(signal);
            if (!t) return;
            const xa = Math.max(a, c * TILE);
            const xb = Math.min(ae, (c + 1) * TILE);
            const ya = Math.max(b, r * TILE);
            const yb = Math.min(be, (r + 1) * TILE);
            for (let j = ya; j < yb; j++) {
              const tr = (j - r * TILE) * TILE - c * TILE;
              out.set(t.subarray(tr + xa, tr + xb), (j - j0) * w - i0 + xa);
            }
          }),
        );
      }
    }
    await Promise.all(jobs);
    checkSignal(signal);
    return out;
  }
}

/** Points sampled per window read (the samples are the same however they are grouped). */
const CHUNK = 256;

function snap(u: number): number {
  const r = Math.round(u);
  return Math.abs(u - r) <= SNAP ? r : u;
}

/** Heights at local points (`x + de`, `y + dn` are metres from the surface origin). */
export async function bilinear(
  s: GridSurface,
  xs: Float64Array,
  ys: Float64Array,
  de: number,
  dn: number,
  signal?: AbortSignal,
): Promise<Float64Array> {
  const n = xs.length;
  const out = new Float64Array(n).fill(NaN);
  if (n === 0) return out;
  if (n > CHUNK) {
    // points along a ring: consecutive runs are close together, so read small windows
    for (let k = 0; k < n; k += CHUNK) {
      const part = await bilinear(
        s,
        xs.subarray(k, k + CHUNK),
        ys.subarray(k, k + CHUNK),
        de,
        dn,
        signal,
      );
      out.set(part, k);
    }
    return out;
  }
  const sc = s.cellM;
  const iu = new Int32Array(n);
  const iv = new Int32Array(n);
  const fu = new Float64Array(n);
  const fv = new Float64Array(n);
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const u = snap(((xs[k] ?? 0) + de) / sc - 0.5);
    const v = snap(((ys[k] ?? 0) + dn) / sc - 0.5);
    const fi = Math.floor(u);
    const fj = Math.floor(v);
    iu[k] = fi;
    iv[k] = fj;
    fu[k] = u - fi;
    fv[k] = v - fj;
    if (fi < a0) a0 = fi;
    if (fi > a1) a1 = fi;
    if (fj < b0) b0 = fj;
    if (fj > b1) b1 = fj;
  }
  const w = a1 + 2 - a0;
  const win = await s.read(a0, b0, w, b1 + 2 - b0, signal);
  for (let k = 0; k < n; k++) {
    const at = ((iv[k] ?? 0) - b0) * w + (iu[k] ?? 0) - a0;
    const u = fu[k] ?? 0;
    const v = fv[k] ?? 0;
    const p00 = win[at] ?? NaN;
    const p10 = win[at + 1] ?? NaN;
    const p01 = win[at + w] ?? NaN;
    const p11 = win[at + w + 1] ?? NaN;
    const row0 = u === 0 ? p00 : p00 * (1 - u) + p10 * u;
    const row1 = u === 0 ? p01 : p01 * (1 - u) + p11 * u;
    out[k] = v === 0 ? row0 : row0 * (1 - v) + row1 * v;
  }
  return out;
}

/** Heights at the centres of comparison cells (local x = (i + 0.5) cell). */
export async function sampleCells(
  s: GridSurface,
  de: number,
  dn: number,
  win: Window,
  signal?: AbortSignal,
): Promise<Float64Array> {
  const sc = s.cellM;
  const ou = de / sc;
  const ov = dn / sc;
  if (
    sc === win.cell &&
    Math.abs(ou - Math.round(ou)) <= SNAP &&
    Math.abs(ov - Math.round(ov)) <= SNAP
  )
    return s.read(win.i0 + Math.round(ou), win.j0 + Math.round(ov), win.nx, win.ny, signal);
  const out = new Float64Array(win.nx * win.ny);
  const xs = new Float64Array(win.nx);
  for (let i = 0; i < win.nx; i++) xs[i] = (win.i0 + i + 0.5) * win.cell;
  for (let r = 0; r < win.ny; r++) {
    const y = (win.j0 + r + 0.5) * win.cell;
    const row = await bilinear(s, xs, new Float64Array(win.nx).fill(y), de, dn, signal);
    out.set(row, r * win.nx);
  }
  return out;
}
