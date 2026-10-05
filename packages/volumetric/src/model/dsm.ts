import type { DsmGrid } from './kitdata';

export type RGB = [number, number, number];

/** Bilinear height at (E, N) between cell centres; null outside or next to a no-data cell. */
export function sampleDsm(d: DsmGrid, E: number, N: number): number | null {
  const fx = (E - d.x0) / d.res - 0.5;
  const fy = (d.y1 - N) / d.res - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= d.w - 1 || j >= d.h - 1) return null;
  const k = j * d.w + i;
  if (!d.valid[k] || !d.valid[k + 1] || !d.valid[k + d.w] || !d.valid[k + d.w + 1]) return null;
  const tx = fx - i;
  const ty = fy - j;
  const z = (n: number) => d.z[n] ?? 0;
  const v =
    (z(k) * (1 - tx) + z(k + 1) * tx) * (1 - ty) +
    (z(k + d.w) * (1 - tx) + z(k + d.w + 1) * tx) * ty;
  return v / 100 + d.zoff;
}

export interface SectionProfile {
  lengthM: number;
  /** Distance along the line of each sample, m. */
  s: number[];
  /** Heights of the first and the last survey, null where there is no data. */
  z1: (number | null)[];
  z2: (number | null)[];
  /** Area between the surfaces along the line where the last survey is lower / higher, m². */
  cutM2: number;
  fillM2: number;
}

/**
 * Elevation profile of both surveys along a line (E, N) sampled every 0.4 m, with the area
 * between them outside the deadband: the kit viewer's `siteSection`.
 */
export function sectionProfile(
  first: DsmGrid,
  last: DsmGrid,
  a: readonly [number, number],
  b: readonly [number, number],
  deadband: number,
): SectionProfile {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.ceil(len / 0.4));
  const p: SectionProfile = { lengthM: len, s: [], z1: [], z2: [], cutM2: 0, fillM2: 0 };
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const E = a[0] + (b[0] - a[0]) * t;
    const N = a[1] + (b[1] - a[1]) * t;
    p.s.push(t * len);
    p.z1.push(sampleDsm(first, E, N));
    p.z2.push(sampleDsm(last, E, N));
  }
  const ds = len / n;
  for (let k = 0; k <= n; k++) {
    const z1 = p.z1[k];
    const z2 = p.z2[k];
    if (z1 == null || z2 == null) continue;
    const d = z2 - z1;
    if (d > deadband) p.fillM2 += d * ds;
    else if (d < -deadband) p.cutM2 -= d * ds;
  }
  return p;
}

const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** The kit's change ramp: -3 m cut (dark red) to +3 m fill (dark blue), grey in the deadband. */
export const CHANGE_RAMP = {
  rangeM: 3,
  grey: hex('#8a8a8a'),
  cutNear: hex('#f0997b'),
  cutFar: hex('#99220f'),
  fillNear: hex('#85b7eb'),
  fillFar: hex('#0c447c'),
};

export function changeColour(d: number, deadband: number): RGB {
  const R = CHANGE_RAMP;
  if (Math.abs(d) <= deadband) return [...R.grey];
  const t = Math.min(1, (Math.abs(d) - deadband) / (R.rangeM - deadband));
  return d < 0 ? mix(R.cutNear, R.cutFar, t) : mix(R.fillNear, R.fillFar, t);
}

/** Colour ramps for the elevation surface, low to high. */
export const RAMPS = {
  turbo: [
    '#30123b',
    '#4145ab',
    '#4675ed',
    '#39a2fc',
    '#1bcfd4',
    '#24eca6',
    '#61fc6c',
    '#a4fc3b',
    '#d1e834',
    '#f3c63a',
    '#fe9b2d',
    '#f36315',
    '#d93806',
    '#b11901',
    '#7a0402',
  ],
  spectral: [
    '#5e4fa2',
    '#3288bd',
    '#66c2a5',
    '#abdda4',
    '#e6f598',
    '#ffffbf',
    '#fee08b',
    '#fdae61',
    '#f46d43',
    '#d53e4f',
    '#9e0142',
  ],
  viridis: [
    '#440154',
    '#482878',
    '#3e4989',
    '#31688e',
    '#26828e',
    '#1f9e89',
    '#35b779',
    '#6ece58',
    '#b5de2b',
    '#fde725',
  ],
  terrain: ['#1f5f3a', '#4f8f45', '#9cbf62', '#e3d892', '#c8a26a', '#8f6a46', '#b8a99c', '#ffffff'],
  inferno: [
    '#000004',
    '#1b0c41',
    '#4a0c6b',
    '#781c6d',
    '#a52c60',
    '#cf4446',
    '#ed6925',
    '#fb9b06',
    '#f7d13d',
    '#fcffa4',
  ],
  grey: ['#202020', '#ffffff'],
} as const satisfies Record<string, readonly string[]>;

export type RampId = keyof typeof RAMPS;
export const RAMP_IDS = Object.keys(RAMPS) as RampId[];

export function isRampId(v: unknown): v is RampId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RAMPS, v);
}

/** How the elevation surface is coloured. */
export interface ReliefStyle {
  ramp: RampId;
  /** Heights at the two ends of the ramp, m. */
  lo: number;
  hi: number;
  /** Shade the colours with a multi-directional hillshade of the DSM. */
  hillshade: boolean;
}

const rampCache = new Map<RampId, RGB[]>();
function rampStops(ramp: RampId): RGB[] {
  let r = rampCache.get(ramp);
  if (!r) {
    r = RAMPS[ramp].map(hex);
    rampCache.set(ramp, r);
  }
  return r;
}

/** Colour of a height between `lo` and `hi` metres on a ramp (clamped at both ends). */
export function rampColour(z: number, lo: number, hi: number, ramp: RampId = 'turbo'): RGB {
  const stops = rampStops(ramp);
  const t = Math.max(0, Math.min(1, (z - lo) / (hi - lo || 1))) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const a = stops[i] ?? stops[0];
  const b = stops[i + 1] ?? a;
  if (!a || !b) return [0, 0, 0];
  return mix(a, b, t - i);
}

/** CSS gradient of a ramp, left (low) to right (high). */
export function rampCss(ramp: RampId): string {
  return `linear-gradient(90deg, ${RAMPS[ramp].join(', ')})`;
}

/** Colour relief between `lo` and `hi` metres on the Terrain ramp (green, brown, white). */
export function reliefColour(z: number, lo: number, hi: number): RGB {
  return rampColour(z, lo, hi, 'terrain');
}

/** Light directions of the multi-directional hillshade (azimuth, degrees) and their weights. */
const SHADE_DIRS: readonly (readonly [number, number])[] = [
  [225, 0.15],
  [270, 0.3],
  [315, 0.4],
  [360, 0.15],
];
const SUN_ALT = Math.PI / 4;

/**
 * Multi-directional hillshade of a DSM, 0 (dark) to about 1 (lit) per cell: the sun 45 degrees
 * high from four azimuths (north-west strongest), so slopes facing every way keep their relief.
 * Neighbours without data take the cell's own height. NaN where the cell has no data.
 */
export function hillshade(d: DsmGrid, zFactor = 1.5): Float32Array {
  const out = new Float32Array(d.w * d.h);
  const cosA = Math.cos(SUN_ALT);
  const sinA = Math.sin(SUN_ALT);
  const dirs = SHADE_DIRS.map(([az, w]) => {
    const a = (az * Math.PI) / 180;
    return { lx: Math.sin(a) * cosA, ly: Math.cos(a) * cosA, w };
  });
  const at = (k: number, fallback: number) => (d.valid[k] ? (d.z[k] ?? 0) / 100 : fallback);
  for (let y = 0; y < d.h; y++)
    for (let x = 0; x < d.w; x++) {
      const k = y * d.w + x;
      if (!d.valid[k]) {
        out[k] = NaN;
        continue;
      }
      const c = (d.z[k] ?? 0) / 100;
      const e = at(x + 1 < d.w ? k + 1 : k, c);
      const w = at(x > 0 ? k - 1 : k, c);
      const n = at(y > 0 ? k - d.w : k, c);
      const s = at(y + 1 < d.h ? k + d.w : k, c);
      // slopes towards east and north (row 0 is the north edge)
      const dzdx = ((e - w) / (2 * d.res)) * zFactor;
      const dzdy = ((n - s) / (2 * d.res)) * zFactor;
      const len = Math.hypot(dzdx, dzdy, 1);
      let v = 0;
      for (const L of dirs) v += Math.max(0, (-dzdx * L.lx - dzdy * L.ly + sinA) / len) * L.w;
      out[k] = v;
    }
  return out;
}

/** Light a colour by a hillshade value: flat ground (about 0.71) keeps its colour. */
function shadeColour(c: RGB, s: number): RGB {
  const m = Math.min(1.3, 0.29 + s);
  return [Math.min(255, c[0] * m), Math.min(255, c[1] * m), Math.min(255, c[2] * m)];
}

/** 1st and 99th percentile and the full range of the valid heights of some DSMs, m. */
export function heightStats(
  ds: readonly DsmGrid[],
  stride = 7,
): { auto: [number, number]; extent: [number, number] } {
  const hs: number[] = [];
  for (const g of ds)
    for (let i = 0; i < g.z.length; i += stride)
      if (g.valid[i]) hs.push((g.z[i] ?? 0) / 100 + g.zoff);
  hs.sort((a, b) => a - b);
  const q = (f: number) => hs[Math.min(hs.length - 1, Math.floor(f * (hs.length - 1)))] ?? 0;
  return { auto: [q(0.01), q(0.99)], extent: [hs[0] ?? 0, hs.at(-1) ?? 0] };
}

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row 0 at the north edge. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Height change from the first to the last survey per DSM cell, as RGBA. */
export function changeRaster(first: DsmGrid, last: DsmGrid, deadband: number): Raster {
  if (first.w !== last.w || first.h !== last.h) throw new Error('The two DSMs differ in size');
  const data = new Uint8ClampedArray(first.w * first.h * 4);
  for (let i = 0; i < first.w * first.h; i++) {
    if (!first.valid[i] || !last.valid[i]) continue;
    const d = ((last.z[i] ?? 0) - (first.z[i] ?? 0)) / 100 + (last.zoff - first.zoff);
    const c = changeColour(d, deadband);
    data.set([c[0], c[1], c[2], 255], i * 4);
  }
  return { width: first.w, height: first.h, data };
}

/**
 * Colour relief of one survey's DSM, as RGBA: the ramp between `lo` and `hi` metres, lit by the
 * hillshade when asked. Cells without data stay transparent (alpha 0): the photo shows there.
 */
export function reliefRaster(
  d: DsmGrid,
  lo: number,
  hi: number,
  style: Partial<Pick<ReliefStyle, 'ramp' | 'hillshade'>> = {},
): Raster {
  const ramp = style.ramp ?? 'terrain';
  const hs = style.hillshade ? hillshade(d) : null;
  const data = new Uint8ClampedArray(d.w * d.h * 4);
  for (let i = 0; i < d.w * d.h; i++) {
    if (!d.valid[i]) continue;
    let c = rampColour((d.z[i] ?? 0) / 100 + d.zoff, lo, hi, ramp);
    const s = hs?.[i];
    if (s !== undefined && !Number.isNaN(s)) c = shadeColour(c, s);
    data.set([c[0], c[1], c[2], 255], i * 4);
  }
  return { width: d.w, height: d.h, data };
}
