/**
 * Readers for the Volumetric Survey Kit's offline data scripts (`window.VS_*` JSON, grids as
 * zlib + base64, written by the kit's `package.py`). Browser and worker safe: zlib goes through
 * `DecompressionStream('deflate')`.
 */

/** `window.NAME=<json>;` or `window.NAME=window.NAME||{};window.NAME["key"]=<json>;`. */
export function parseKitScript(text: string, name: string): { key: string | null; value: unknown } {
  const keyed = `window.${name}["`;
  const at = text.lastIndexOf(keyed);
  if (at >= 0) {
    const keyEnd = text.indexOf('"]', at + keyed.length);
    const eq = keyEnd < 0 ? -1 : text.indexOf('=', keyEnd);
    if (eq < 0) throw new Error(`Malformed kit data script for window.${name}`);
    return { key: text.slice(at + keyed.length, keyEnd), value: jsonBody(text.slice(eq + 1)) };
  }
  const plain = `window.${name}=`;
  const p = text.indexOf(plain);
  if (p < 0) throw new Error(`Not a kit data script for window.${name}`);
  return { key: null, value: jsonBody(text.slice(p + plain.length)) };
}

const jsonBody = (s: string): unknown =>
  JSON.parse(s.trim().replace(/;\s*$/, '').trim()) as unknown;

function base64(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

/** Base64 zlib stream to bytes. */
export async function inflate(b64: string): Promise<Uint8Array> {
  const stream = new Blob([base64(b64)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Int16 grid stored as row-wise deltas; sums wrap like the viewer's Int16Array store. */
export function decodeDeltaI16(raw: Uint8Array, w: number, h: number): Int16Array {
  if (raw.byteLength < w * h * 2)
    throw new Error(`Grid holds ${raw.byteLength} bytes, expected ${w * h * 2}`);
  const d = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + w * h * 2));
  const out = new Int16Array(w * h);
  for (let y = 0; y < h; y++) {
    let a = 0;
    const r = y * w;
    for (let x = 0; x < w; x++) {
      a += d[r + x] ?? 0;
      out[r + x] = a;
    }
  }
  return out;
}

/** Bit mask packed most significant bit first (numpy `packbits`). */
export function decodeBits(raw: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ((raw[i >> 3] ?? 0) >> (7 - (i & 7))) & 1;
  return out;
}

const i16 = async (s: string, w: number, h: number) => decodeDeltaI16(await inflate(s), w, h);
const bits = async (s: string, n: number) => decodeBits(await inflate(s), n);

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Error(`Kit data: ${what} is not an object`);
  return v as Record<string, unknown>;
}
function num(o: Record<string, unknown>, k: string, what: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Error(`Kit data: ${what}.${k} is not a number`);
  return v;
}
function str(o: Record<string, unknown>, k: string, what: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`Kit data: ${what}.${k} is not a string`);
  return v;
}
const optNum = (o: Record<string, unknown>, k: string): number | undefined =>
  typeof o[k] === 'number' ? o[k] : undefined;

/* ------------------------------------------------------------------ 10 cm pile grids */

/** One survey date of a pile grid: surface (cm above zoff) and, when the pile exists, its bases. */
export interface PileEpochGrid {
  z: Int16Array;
  m?: Uint8Array;
  tin?: Int16Array;
  low?: number;
  avg?: number;
  /** Plane `c0 + c1 * x_m + c2 * y_m`, x right and y down from the grid's top-left corner. */
  plane?: readonly [number, number, number];
}

/** A decoded `data/piles/Pxx.js`: 10 cm cells, row 0 at the north edge. */
export interface PileGrid {
  id: string;
  w: number;
  h: number;
  res: number;
  /** Easting of the west edge and northing of the north edge (project CRS). */
  x0: number;
  y1: number;
  zoff: number;
  zone: Uint8Array;
  ep: Record<string, PileEpochGrid>;
}

export async function decodePile(text: string): Promise<PileGrid> {
  const r = obj(parseKitScript(text, 'VS_PILE').value, 'pile');
  const w = num(r, 'w', 'pile');
  const h = num(r, 'h', 'pile');
  const n = w * h;
  const ep: Record<string, PileEpochGrid> = {};
  for (const [e, raw] of Object.entries(obj(r.ep, 'pile.ep'))) {
    const v = obj(raw, `pile.ep.${e}`);
    const o: PileEpochGrid = { z: await i16(str(v, 'z', e), w, h) };
    if (typeof v.m === 'string') o.m = await bits(v.m, n);
    if (typeof v.tin === 'string') o.tin = await i16(v.tin, w, h);
    const low = optNum(v, 'low');
    const avg = optNum(v, 'avg');
    if (low !== undefined) o.low = low;
    if (avg !== undefined) o.avg = avg;
    if (Array.isArray(v.plane) && v.plane.length === 3)
      o.plane = v.plane.map(Number) as unknown as [number, number, number];
    ep[e] = o;
  }
  return {
    id: str(r, 'id', 'pile'),
    w,
    h,
    res: num(r, 'res', 'pile'),
    x0: num(r, 'x0', 'pile'),
    y1: num(r, 'y1', 'pile'),
    zoff: num(r, 'zoff', 'pile'),
    zone: await bits(str(r, 'zone', 'pile'), n),
    ep,
  };
}

/* ------------------------------------------------------------------ 0.4 m site DSM */

/** A decoded `data/dsm_<epoch>.js`: heights in cm above zoff, row 0 at the north edge. */
export interface DsmGrid {
  epoch: string;
  w: number;
  h: number;
  res: number;
  x0: number;
  y1: number;
  zoff: number;
  z: Int16Array;
  valid: Uint8Array;
}

export async function decodeDsm(text: string): Promise<DsmGrid> {
  const { key, value } = parseKitScript(text, 'VS_DSM');
  const r = obj(value, 'dsm');
  const w = num(r, 'w', 'dsm');
  const h = num(r, 'h', 'dsm');
  return {
    epoch: key ?? '',
    w,
    h,
    res: num(r, 'res', 'dsm'),
    x0: num(r, 'x0', 'dsm'),
    y1: num(r, 'y1', 'dsm'),
    zoff: num(r, 'zoff', 'dsm'),
    z: await i16(str(r, 'z', 'dsm'), w, h),
    valid: await bits(str(r, 'valid', 'dsm'), w * h),
  };
}

/* ------------------------------------------------------------------ 0.4 m pile masks */

export interface CoarseEpoch {
  m: Uint8Array;
  tin: Int16Array;
  low: number;
  avg: number;
  /** Plane `c0 + c1 * (E - x0) + c2 * (y1 - N)`. */
  plane: { c: readonly [number, number, number]; x0: number; y1: number };
}

/** One pile in `data/vol.js`: a window of the DSM grid (offset `bx0`, `by0` cells). */
export interface CoarsePile {
  bx0: number;
  by0: number;
  w: number;
  h: number;
  zone: Uint8Array;
  ep: Record<string, CoarseEpoch>;
}

export interface CoarseGrids {
  res: number;
  x0: number;
  y1: number;
  piles: Record<string, CoarsePile>;
}

export async function decodeCoarse(text: string, epochs: readonly string[]): Promise<CoarseGrids> {
  const r = obj(parseKitScript(text, 'VS_VOL').value, 'vol');
  const piles: Record<string, CoarsePile> = {};
  for (const [id, raw] of Object.entries(obj(r.piles, 'vol.piles'))) {
    const p = obj(raw, `vol.${id}`);
    const w = num(p, 'w', id);
    const h = num(p, 'h', id);
    const ep: Record<string, CoarseEpoch> = {};
    for (const e of epochs) {
      if (p[e] === undefined || p[e] === null) continue;
      const v = obj(p[e], `${id}.${e}`);
      const pl = obj(v.plane, `${id}.${e}.plane`);
      const c = pl.c;
      if (!Array.isArray(c) || c.length !== 3) throw new Error(`Kit data: ${id}.${e}.plane.c`);
      ep[e] = {
        m: await bits(str(v, 'm', e), w * h),
        tin: await i16(str(v, 'tin', e), w, h),
        low: num(v, 'low', e),
        avg: num(v, 'avg', e),
        plane: {
          c: c.map(Number) as unknown as [number, number, number],
          x0: num(pl, 'x0', 'plane'),
          y1: num(pl, 'y1', 'plane'),
        },
      };
    }
    piles[id] = {
      bx0: num(p, 'bx0', id),
      by0: num(p, 'by0', id),
      w,
      h,
      zone: await bits(str(p, 'zone', id), w * h),
      ep,
    };
  }
  return { res: num(r, 'res', 'vol'), x0: num(r, 'x0', 'vol'), y1: num(r, 'y1', 'vol'), piles };
}
