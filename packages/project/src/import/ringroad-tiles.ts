import type { Vec3 } from '@aio/schema';

/**
 * Ortho maths for the 1st Ring Road review: the source is a Web Mercator XYZ pyramid (256 px
 * WebP tiles in `RRT(...)` script bundles), the package wants a pyramid aligned to the local frame
 * (UTM 38N). A single affine of the Mercator grid is off by up to 0.3 m over the corridor, so every
 * output tile is resampled from the source through its own affine (exact to 0.01 px over 512 px).
 */

/** Source tile size (px). */
export const SRC_TILE = 256;

/** Tiles of one `RRT("z/x/y",{"z/x/y":"<base64 webp>",...});` bundle, keyed `z/x/y`. */
export function parseRrtBundle(text: string): Map<string, Uint8Array> {
  const m = /^\s*RRT\("[^"]*",(\{[\s\S]*\})\);?\s*$/.exec(text);
  if (!m?.[1]) throw new Error('Not a road review tile bundle (RRT(...) missing)');
  const obj = JSON.parse(m[1]) as Record<string, string>;
  const out = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(obj)) out.set(k, Buffer.from(v, 'base64'));
  return out;
}

/** Web Mercator world pixel (256 px tiles) of a lon/lat at zoom `z`. */
export function worldPx(lon: number, lat: number, z: number): [number, number] {
  const n = SRC_TILE * 2 ** z;
  const phi = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * n];
}

export function worldPxToLonLat(x: number, y: number, z: number): [number, number] {
  const n = SRC_TILE * 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

export interface PyramidLevel {
  /** Level index, 0 = coarsest (one tile). */
  z: number;
  tileSize: number;
  cols: number;
  rows: number;
  pattern: string;
  metresPerPx: number;
  /** Source Mercator zoom with the closest pixel size. */
  srcZoom: number;
}

/** A square pyramid aligned to the projected CRS: top-left corner (E, N), side in metres. */
export interface PyramidPlan {
  left: number;
  top: number;
  size: number;
  levels: PyramidLevel[];
}

export interface PyramidOptions {
  /** Pixel size of the finest level (m). */
  finestM: number;
  tileSize: number;
  levels: number;
  /** Source zoom matching the finest level; each coarser level uses one zoom less. */
  finestSrcZoom: number;
  /** Folder of the tiles inside the package. */
  dir?: string;
}

/** Plan a pyramid whose square covers `bounds` (projected metres), centred on them. */
export function planPyramid(
  bounds: { minE: number; minN: number; maxE: number; maxN: number },
  o: PyramidOptions,
): PyramidPlan {
  const fine = 2 ** (o.levels - 1);
  const size = fine * o.tileSize * o.finestM;
  const w = bounds.maxE - bounds.minE;
  const h = bounds.maxN - bounds.minN;
  if (w > size || h > size) {
    throw new Error(
      `Ortho extent ${w.toFixed(0)} x ${h.toFixed(0)} m does not fit a ${size.toFixed(0)} m pyramid`,
    );
  }
  // centred, snapped to whole metres when the slack allows it
  const leftExact = (bounds.minE + bounds.maxE) / 2 - size / 2;
  const topExact = (bounds.minN + bounds.maxN) / 2 + size / 2;
  const l = Math.floor(leftExact);
  const t = Math.ceil(topExact);
  const left = l + size >= bounds.maxE ? l : leftExact;
  const top = t - size <= bounds.minN ? t : topExact;
  const dir = o.dir ?? 'rasters/ortho';
  const levels: PyramidLevel[] = [];
  for (let z = 0; z < o.levels; z++) {
    const cols = 2 ** z;
    levels.push({
      z,
      tileSize: o.tileSize,
      cols,
      rows: cols,
      pattern: `${dir}/${z}/{x}_{y}.webp`,
      metresPerPx: size / cols / o.tileSize,
      srcZoom: o.finestSrcZoom - (o.levels - 1 - z),
    });
  }
  return { left, top, size, levels };
}

/** The pyramid square in the local frame (x east, y up, z south) of `origin`, on the ground. */
export function levelCorners(
  p: PyramidPlan,
  origin: Vec3,
  y = 0,
): { tl: Vec3; tr: Vec3; bl: Vec3 } {
  const x0 = p.left - origin[0];
  const z0 = 0 - (p.top - origin[1]);
  return { tl: [x0, y, z0], tr: [x0 + p.size, y, z0], bl: [x0, y, z0 + p.size] };
}

/**
 * Affine from output tile pixel coordinates (u right, v down, pixel centres at k + 0.5) to source
 * world pixel coordinates (same convention) at `level.srcZoom`: `X = a u + b v + c`,
 * `Y = d u + e v + f`. `err` is the largest miss (px) at the fourth corner and the centre.
 */
export interface Affine2 {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  err: number;
}

export function tileToSource(
  p: PyramidPlan,
  level: PyramidLevel,
  tx: number,
  ty: number,
  toLonLat: (e: number, n: number) => [number, number],
): Affine2 {
  const s = level.tileSize;
  const at = (u: number, v: number): [number, number] => {
    const e = p.left + (tx * s + u) * level.metresPerPx;
    const n = p.top - (ty * s + v) * level.metresPerPx;
    const [lon, lat] = toLonLat(e, n);
    return worldPx(lon, lat, level.srcZoom);
  };
  const o = at(0, 0);
  const r = at(s, 0);
  const d = at(0, s);
  const m: Affine2 = {
    a: (r[0] - o[0]) / s,
    b: (d[0] - o[0]) / s,
    c: o[0],
    d: (r[1] - o[1]) / s,
    e: (d[1] - o[1]) / s,
    f: o[1],
    err: 0,
  };
  for (const [u, v] of [
    [s, s],
    [s / 2, s / 2],
  ] as const) {
    const q = at(u, v);
    const x = m.a * u + m.b * v + m.c;
    const y = m.d * u + m.e * v + m.f;
    m.err = Math.max(m.err, Math.hypot(x - q[0], y - q[1]));
  }
  return m;
}

/** Source tiles (end exclusive) under an output tile of `size` px, with a one pixel margin. */
export function windowTiles(
  m: Affine2,
  size: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [u, v] of [
    [0, 0],
    [size, 0],
    [0, size],
    [size, size],
  ] as const) {
    xs.push(m.a * u + m.b * v + m.c);
    ys.push(m.d * u + m.e * v + m.f);
  }
  return {
    x0: Math.floor((Math.min(...xs) - 1) / SRC_TILE),
    y0: Math.floor((Math.min(...ys) - 1) / SRC_TILE),
    x1: Math.floor((Math.max(...xs) + 1) / SRC_TILE) + 1,
    y1: Math.floor((Math.max(...ys) + 1) / SRC_TILE) + 1,
  };
}

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Resample `src` (RGBA) into a `size` x `size` tile through `m` (output pixel to source pixel),
 * bilinear on premultiplied colour so transparent no-data never darkens the edge. Pixels with no
 * source get `fill` and alpha 0. `covered` counts output pixels with any alpha.
 */
export function resampleBilinear(
  src: RgbaImage,
  m: Affine2,
  size: number,
  fill: readonly [number, number, number],
): { data: Uint8Array; covered: number } {
  const out = new Uint8Array(size * size * 4);
  const { data, width: W, height: H } = src;
  let covered = 0;
  for (let v = 0; v < size; v++) {
    const cv = v + 0.5;
    let o = v * size * 4;
    for (let u = 0; u < size; u++, o += 4) {
      const cu = u + 0.5;
      const x = m.a * cu + m.b * cv + m.c - 0.5;
      const y = m.d * cu + m.e * cv + m.f - 0.5;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < 4; k++) {
        const sx = x0 + (k & 1);
        const sy = y0 + (k >> 1);
        const w = ((k & 1) === 1 ? fx : 1 - fx) * (k >> 1 === 1 ? fy : 1 - fy);
        if (w === 0 || sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const i = (sy * W + sx) * 4;
        const al = (data[i + 3] ?? 0) * w;
        if (al === 0) continue;
        r += (data[i] ?? 0) * al;
        g += (data[i + 1] ?? 0) * al;
        b += (data[i + 2] ?? 0) * al;
        a += al;
      }
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a);
        covered++;
      } else {
        out[o] = fill[0];
        out[o + 1] = fill[1];
        out[o + 2] = fill[2];
        out[o + 3] = 0;
      }
    }
  }
  return { data: out, covered };
}

/**
 * Shift (px) of image `b` against `a` (both `w` x `h` grey) that maximises the normalised cross
 * correlation of `a(x, y)` with `b(x + dx, y + dy)` over the centre (a `max + 1` px margin kept).
 * `dx`, `dy` are whole pixels, `sx`, `sy` refined by a parabola through the neighbours. `score` is
 * the correlation (0 when either image is flat).
 */
export function bestShift(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  max: number,
): { dx: number; dy: number; sx: number; sy: number; score: number } {
  const m = max + 1;
  const ncc = (dx: number, dy: number) => {
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let y = m; y < h - m; y++)
      for (let x = m; x < w - m; x++) {
        const va = a[y * w + x] ?? 0;
        const vb = b[(y + dy) * w + x + dx] ?? 0;
        n++;
        sa += va;
        sb += vb;
        saa += va * va;
        sbb += vb * vb;
        sab += va * vb;
      }
    const va = saa - (sa * sa) / n;
    const vb = sbb - (sb * sb) / n;
    if (n === 0 || va <= 1e-9 || vb <= 1e-9) return 0;
    return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
  };
  let best = { dx: 0, dy: 0, score: 0 };
  for (let dy = -max; dy <= max; dy++)
    for (let dx = -max; dx <= max; dx++) {
      const score = ncc(dx, dy);
      if (score > best.score) best = { dx, dy, score };
    }
  const refine = (lo: number, mid: number, hi: number) => {
    const den = lo - 2 * mid + hi;
    return den < 0 ? Math.max(-0.5, Math.min(0.5, (lo - hi) / (2 * den))) : 0;
  };
  const { dx, dy, score } = best;
  if (score === 0) return { dx, dy, sx: dx, sy: dy, score };
  return {
    dx,
    dy,
    sx: dx + refine(ncc(dx - 1, dy), score, ncc(dx + 1, dy)),
    sy: dy + refine(ncc(dx, dy - 1), score, ncc(dx, dy + 1)),
    score,
  };
}

/** Sort tile coordinates along a Z-order (Morton) curve. */
export function zOrder(tiles: readonly (readonly [number, number])[]): [number, number][] {
  const key = (x: number, y: number) => {
    let k = 0;
    for (let bit = 0; bit < 16; bit++) {
      k += ((x >> bit) & 1) * 2 ** (2 * bit) + ((y >> bit) & 1) * 2 ** (2 * bit + 1);
    }
    return k;
  };
  return tiles
    .map(([x, y]) => [x, y] as [number, number])
    .sort((p, q) => key(p[0], p[1]) - key(q[0], q[1]));
}
