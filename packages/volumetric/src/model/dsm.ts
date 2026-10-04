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

const RELIEF = ['#1f6fbf', '#3fb56a', '#f0e19a', '#a8835f', '#ffffff'].map(hex);

/** The kit's colour relief between `lo` and `hi` metres. */
export function reliefColour(z: number, lo: number, hi: number): RGB {
  const t = Math.max(0, Math.min(1, (z - lo) / (hi - lo || 1))) * (RELIEF.length - 1);
  const i = Math.min(RELIEF.length - 2, Math.floor(t));
  const a = RELIEF[i] ?? RELIEF[0];
  const b = RELIEF[i + 1] ?? a;
  if (!a || !b) return [0, 0, 0];
  return mix(a, b, t - i);
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

/** Colour relief of one survey's DSM, as RGBA. */
export function reliefRaster(d: DsmGrid, lo: number, hi: number): Raster {
  const data = new Uint8ClampedArray(d.w * d.h * 4);
  for (let i = 0; i < d.w * d.h; i++) {
    if (!d.valid[i]) continue;
    const c = reliefColour((d.z[i] ?? 0) / 100 + d.zoff, lo, hi);
    data.set([c[0], c[1], c[2], 255], i * 4);
  }
  return { width: d.w, height: d.h, data };
}
