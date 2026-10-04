import { inflateSync } from 'node:zlib';
import { z } from 'zod';

/**
 * Volumetric Survey Kit offline builds keep their data in scripts that load from file://:
 * `window.NAME=<json>;` or `window.NAME=window.NAME||{};window.NAME["key"]=<json>;`.
 */
export function parseVsDataJs(text: string, name: string): { key: string | null; value: unknown } {
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

/** Int16 grid stored as row-wise deltas (zlib + base64), as the kit's `package.py` writes it. */
export function decodeDeltaI16(b64: string, w: number, h: number): Int16Array {
  const raw = inflateSync(Buffer.from(b64, 'base64'));
  if (raw.length < w * h * 2)
    throw new Error(`Grid holds ${raw.length} bytes, expected ${w * h * 2}`);
  const d = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + w * h * 2));
  const out = new Int16Array(w * h);
  for (let y = 0; y < h; y++) {
    let a = 0;
    const r = y * w;
    for (let x = 0; x < w; x++) {
      a += d[r + x] ?? 0;
      out[r + x] = a; // wraps like the viewer's Int16Array store
    }
  }
  return out;
}

/** Bit mask packed most significant bit first (numpy `packbits`), zlib + base64. */
export function decodeBits(b64: string, n: number): Uint8Array {
  const u = inflateSync(Buffer.from(b64, 'base64'));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ((u[i >> 3] ?? 0) >> (7 - (i & 7))) & 1;
  return out;
}

export type VolumeBase = 'tin' | 'plane' | 'avg' | 'low';

/** The four base surfaces in the kit's order (default first) with the kit's labels. */
export const VOLUME_BASES: readonly { id: VolumeBase; label: string }[] = [
  { id: 'tin', label: 'Triangulated toe' },
  { id: 'plane', label: 'Best-fit toe plane' },
  { id: 'avg', label: 'Average toe height' },
  { id: 'low', label: 'Lowest toe point' },
];

/** One survey date of a pile grid: surface (cm above zoff) and, when the pile exists, its bases. */
export interface VsPileEpoch {
  z: Int16Array;
  m?: Uint8Array;
  tin?: Int16Array;
  low?: number;
  avg?: number;
  /** Plane `c0 + c1 * x_m + c2 * y_m` with x right, y down from the grid's top-left corner. */
  plane?: readonly [number, number, number];
}

/** A decoded `data/piles/Pxx.js` grid (10 cm cells, row 0 at the top). */
export interface VsPileGrids {
  w: number;
  h: number;
  res: number;
  zoff: number;
  zone: Uint8Array;
  ep: Record<string, VsPileEpoch>;
}

export interface PileVolume {
  fill: number;
  cut: number;
  net: number;
  areaM2: number;
  topM: number;
  /** Top minus the lowest base point. */
  heightM: number;
}

/** Volume of one pile at one date against one base: the kit viewer's `volume()`. */
export function pileVolume(g: VsPileGrids, epoch: string, base: VolumeBase): PileVolume | null {
  const o = g.ep[epoch];
  if (!o?.m) return null;
  const { m, z } = o;
  const baseAt = baseFn(o, base, g);
  let fill = 0;
  let cut = 0;
  let top = -Infinity;
  let bmin = Infinity;
  let n = 0;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x;
      if (!m[i]) continue;
      const zz = (z[i] ?? 0) / 100 + g.zoff;
      const b = baseAt(x, y, i);
      const d = zz - b;
      if (d > 0) fill += d;
      else cut -= d;
      if (zz > top) top = zz;
      if (b < bmin) bmin = b;
      n++;
    }
  }
  const a = g.res * g.res;
  return {
    fill: fill * a,
    cut: cut * a,
    net: (fill - cut) * a,
    areaM2: n * a,
    topM: top,
    heightM: top - bmin,
  };
}

function baseFn(
  o: VsPileEpoch,
  base: VolumeBase,
  g: VsPileGrids,
): (x: number, y: number, i: number) => number {
  const need = <T>(v: T | undefined): T => {
    if (v === undefined) throw new Error(`Pile grid has no ${base} base`);
    return v;
  };
  switch (base) {
    case 'low': {
      const v = need(o.low);
      return () => v;
    }
    case 'avg': {
      const v = need(o.avg);
      return () => v;
    }
    case 'plane': {
      const [c0, c1, c2] = need(o.plane);
      return (x, y) => c0 + c1 * (x + 0.5) * g.res + c2 * (y + 0.5) * g.res;
    }
    case 'tin': {
      const t = need(o.tin);
      return (_x, _y, i) => (t[i] ?? 0) / 100 + g.zoff;
    }
  }
}

/** Surface to surface change inside the pile zone; differences within the deadband are ignored. */
export function pileChange(
  g: VsPileGrids,
  from: string,
  to: string,
  deadband: number,
): { fill: number; cut: number; net: number } {
  const a = g.ep[from]?.z;
  const b = g.ep[to]?.z;
  if (!a || !b) throw new Error(`Pile grid lacks ${from} or ${to}`);
  let fill = 0;
  let cut = 0;
  for (let i = 0; i < g.zone.length; i++) {
    if (!g.zone[i]) continue;
    const d = ((b[i] ?? 0) - (a[i] ?? 0)) / 100;
    if (d > deadband) fill += d;
    else if (d < -deadband) cut -= d;
  }
  const area = g.res * g.res;
  return { fill: fill * area, cut: cut * area, net: (fill - cut) * area };
}

/* ------------------------------------------------------------------ source schemas */

const EN = z.tuple([z.number(), z.number()]);
const Fcn = z.object({ fill: z.number(), cut: z.number(), net: z.number() });

export const VsSite = z.object({
  epochs: z.record(
    z.string(),
    z.object({ id: z.string(), label: z.string(), date: z.string() }).loose(),
  ),
  piles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      material: z.string().nullable().optional(),
      status: z.string().optional(),
      zone_ring: z.array(EN),
      change: Fcn.optional(),
      epochs: z.record(
        z.string(),
        z.object({
          area_m2: z.number(),
          top_m: z.number(),
          height_m: z.number(),
          bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          ring: z.array(EN),
          ground_toe_frac: z.number().optional(),
          survey_err_m3: z.number().optional(),
          vol: z.object({ low: Fcn, avg: Fcn, plane: Fcn, tin: Fcn }),
        }),
      ),
    }),
  ),
  site_change: z.object({ fill: z.number(), cut: z.number(), net: z.number() }).loose(),
  pile_change: Fcn,
  totals: z.record(z.string(), z.record(z.string(), z.number())),
  grid: z
    .object({
      x0: z.number(),
      y0: z.number(),
      x1: z.number(),
      y1: z.number(),
      tile: z.number(),
      zmax: z.number(),
      ortho_res: z.number(),
    })
    .loose(),
  volume: z.object({
    deadband_m: z.number(),
    default_base: z.string(),
    density_t_m3: z.number(),
    swell: z.number().optional(),
  }),
  zoff: z.number(),
  meta: z
    .object({
      title: z.string(),
      customer: z.string(),
      site: z.string(),
      crs: z.string(),
      epoch_order: z.array(z.string()),
    })
    .loose(),
  aoi: z.array(EN).optional(),
  excluded: z.array(z.object({ reason: z.string(), ring: z.array(EN) })).optional(),
});
export type VsSite = z.infer<typeof VsSite>;

const VsPileRaw = z.object({
  id: z.string(),
  res: z.number(),
  w: z.number().int(),
  h: z.number().int(),
  x0: z.number(),
  y1: z.number(),
  zoff: z.number(),
  zone: z.string(),
  ep: z.record(
    z.string(),
    z.object({
      z: z.string(),
      m: z.string().optional(),
      tin: z.string().optional(),
      low: z.number().optional(),
      avg: z.number().optional(),
      plane: z.tuple([z.number(), z.number(), z.number()]).optional(),
    }),
  ),
});

/** Decode a `data/piles/Pxx.js` script into grids, plus its top-left corner (E, N). */
export function decodePileScript(
  text: string,
): VsPileGrids & { id: string; x0: number; y1: number } {
  const r = VsPileRaw.parse(parseVsDataJs(text, 'VS_PILE').value);
  const n = r.w * r.h;
  const ep: Record<string, VsPileEpoch> = {};
  for (const [e, v] of Object.entries(r.ep)) {
    const o: VsPileEpoch = { z: decodeDeltaI16(v.z, r.w, r.h) };
    if (v.m) o.m = decodeBits(v.m, n);
    if (v.tin) o.tin = decodeDeltaI16(v.tin, r.w, r.h);
    if (v.low !== undefined) o.low = v.low;
    if (v.avg !== undefined) o.avg = v.avg;
    if (v.plane) o.plane = v.plane;
    ep[e] = o;
  }
  return {
    id: r.id,
    w: r.w,
    h: r.h,
    res: r.res,
    zoff: r.zoff,
    x0: r.x0,
    y1: r.y1,
    zone: decodeBits(r.zone, n),
    ep,
  };
}
