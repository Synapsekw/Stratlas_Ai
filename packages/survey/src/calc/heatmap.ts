import type { HeatmapStop, HeatmapStyle } from '@aio/schema';

/**
 * Difference heat maps (M11 G4, data-conventions section 26): the colour of a `dz = To - From`
 * value from the site's stops, smooth or stepped, optionally inverted, and the deadband the stops
 * imply. The deadband always shapes the heat map (values inside it are left clear); it changes the
 * volumes only when an item opts in with **Use deadband in calculations**.
 */

/** The default stops, metres: -1, -0.1, 0.1, 1 (cut red, fill blue). */
export const DEFAULT_STOPS: readonly HeatmapStop[] = [
  { value: -1, color: '#b2182b' },
  { value: -0.1, color: '#f4a582' },
  { value: 0.1, color: '#92c5de' },
  { value: 1, color: '#2166ac' },
];

/** Stops sorted ascending by value (a copy). */
export const sortStops = (stops: readonly HeatmapStop[]): HeatmapStop[] =>
  [...stops].sort((a, b) => a.value - b.value);

/** Why a set of stops cannot be used, or null when it can. */
export function stopsProblem(stops: readonly HeatmapStop[]): string | null {
  if (stops.length < 2) return 'A heat map needs two stops or more.';
  if (stops.length > 16) return 'A heat map takes at most 16 stops.';
  const s = sortStops(stops);
  for (let i = 0; i < s.length; i++) {
    const v = s[i]?.value ?? NaN;
    if (!Number.isFinite(v)) return 'Every stop needs a number.';
    if (i > 0 && v === s[i - 1]?.value) return 'Two stops have the same value.';
    if (!/^#[0-9a-fA-F]{6}$/.test(s[i]?.color ?? '')) return 'Every stop needs a colour.';
  }
  return null;
}

/**
 * The deadband the stops imply, metres: the band between the innermost negative and positive stops
 * is "unchanged". A stop at zero means no band. It is the smaller of the two magnitudes (so no value a stop colours is ever
 * dropped), or 0 when the stops do not straddle zero.
 */
export function deadbandFromStops(stops: readonly HeatmapStop[]): number {
  let neg = -Infinity;
  let pos = Infinity;
  for (const s of stops) {
    if (s.value === 0) return 0;
    if (s.value < 0 && s.value > neg) neg = s.value;
    if (s.value > 0 && s.value < pos) pos = s.value;
  }
  if (neg === -Infinity || pos === Infinity) return 0;
  return Math.min(-neg, pos);
}

/** An RGBA colour, 0 to 255 each. */
export type Rgba = [number, number, number, number];

function hex(c: string): [number, number, number] {
  const n = Number.parseInt(c.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A compiled ramp: `colorOf(dz)` is null inside the deadband or for no data. */
export interface HeatRamp {
  deadbandM: number;
  colorOf(dz: number): Rgba | null;
  /** The stops in drawing order with their (possibly inverted) colours, for a legend. */
  legend: HeatmapStop[];
}

/** Compile a heat map style into a colour function. `alpha` is 0 to 255 (default 220). */
export function heatRamp(style: Pick<HeatmapStyle, 'stops' | 'stepped' | 'inverted'>, alpha = 220) {
  const s = sortStops(style.stops);
  const colours = s.map((x) => x.color);
  if (style.inverted) colours.reverse();
  const legend = s.map((x, i) => ({ value: x.value, color: colours[i] ?? x.color }));
  const rgb = legend.map((x) => hex(x.color));
  const values = legend.map((x) => x.value);
  const db = deadbandFromStops(s);
  const n = values.length;
  const first = values[0] ?? 0;
  const last = values[n - 1] ?? 0;
  const colorOf = (dz: number): Rgba | null => {
    if (!Number.isFinite(dz)) return null;
    if (Math.abs(dz) < db) return null;
    if (dz <= first) return [...(rgb[0] ?? [0, 0, 0]), alpha];
    if (dz >= last) return [...(rgb[n - 1] ?? [0, 0, 0]), alpha];
    let k = 0;
    while (k < n - 2 && dz > (values[k + 1] ?? 0)) k++;
    // dz is in [values[k], values[k + 1]]
    const a = values[k] ?? 0;
    const b = values[k + 1] ?? 0;
    const ca = rgb[k] ?? [0, 0, 0];
    const cb = rgb[k + 1] ?? [0, 0, 0];
    if (style.stepped) {
      // the band takes the colour of the stop nearer zero on its side of zero
      const c = dz >= 0 ? (dz >= b ? cb : ca) : dz <= a ? ca : cb;
      return [...c, alpha];
    }
    const t = b === a ? 0 : (dz - a) / (b - a);
    return [
      Math.round(ca[0] + (cb[0] - ca[0]) * t),
      Math.round(ca[1] + (cb[1] - ca[1]) * t),
      Math.round(ca[2] + (cb[2] - ca[2]) * t),
      alpha,
    ];
  };
  const ramp: HeatRamp = { deadbandM: db, colorOf, legend };
  return ramp;
}

/**
 * Colour a difference grid (row 0 the southernmost, as the engine's bands) into RGBA bytes with
 * row 0 at the top (north up, as an image). NaN (no data, outside the polygon) is clear.
 */
export function colourGrid(
  dz: ArrayLike<number>,
  nx: number,
  ny: number,
  ramp: HeatRamp,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(nx * ny * 4);
  for (let r = 0; r < ny; r++) {
    const src = r * nx;
    const dst = (ny - 1 - r) * nx * 4;
    for (let i = 0; i < nx; i++) {
      const c = ramp.colorOf(dz[src + i] ?? NaN);
      if (!c) continue;
      const o = dst + i * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = c[3];
    }
  }
  return out;
}

/**
 * Contours of a difference grid (row 0 south) at `interval`, by marching squares: segments in
 * grid cell units (x east from column 0, y north from row 0, at the cell centres), keyed by level.
 * Cheap and only for display; the job writes the exact contours of a whole-site comparison.
 */
export function contourSegments(
  dz: ArrayLike<number>,
  nx: number,
  ny: number,
  interval: number,
  maxLevels = 40,
): { level: number; segments: [number, number, number, number][] }[] {
  if (!(interval > 0)) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < nx * ny; k++) {
    const v = dz[k] ?? NaN;
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo === Infinity) return [];
  const k0 = Math.ceil(lo / interval);
  const k1 = Math.floor(hi / interval);
  if (k1 - k0 + 1 > maxLevels) return [];
  const out: { level: number; segments: [number, number, number, number][] }[] = [];
  const at = (i: number, j: number) => dz[j * nx + i] ?? NaN;
  for (let k = k0; k <= k1; k++) {
    const level = Math.round(k * interval * 1e6) / 1e6;
    if (level === 0) continue;
    const segs: [number, number, number, number][] = [];
    for (let j = 0; j + 1 < ny; j++)
      for (let i = 0; i + 1 < nx; i++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const d = at(i, j + 1);
        if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)))
          continue;
        const pts: [number, number][] = [];
        const edge = (v0: number, v1: number, x0: number, y0: number, x1: number, y1: number) => {
          if (v0 < level !== v1 < level) {
            const t = (level - v0) / (v1 - v0);
            pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
          }
        };
        edge(a, b, i, j, i + 1, j);
        edge(b, c, i + 1, j, i + 1, j + 1);
        edge(c, d, i + 1, j + 1, i, j + 1);
        edge(d, a, i, j + 1, i, j);
        for (let q = 0; q + 1 < pts.length; q += 2) {
          const p = pts[q];
          const r = pts[q + 1];
          if (p && r) segs.push([p[0], p[1], r[0], r[1]]);
        }
      }
    if (segs.length) out.push({ level, segments: segs });
  }
  return out;
}

/** A round contour step giving about ten levels over `span` (1, 2 or 5 times a power of ten). */
export function niceInterval(span: number): number {
  if (!(span > 0)) return 0.1;
  const raw = span / 10;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const f of [1, 2, 5, 10]) if (raw <= f * p) return f * p;
  return 10 * p;
}
