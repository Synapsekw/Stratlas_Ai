/**
 * Elevation colour range: a sample of point heights per decoded chunk (worker side) and a robust
 * range over the samples (main side). Heights are local Y, metres, the frame the shader colours.
 */

/** Heights kept per decoded chunk. */
export const HEIGHT_SAMPLES = 4096;

/** Default percentiles of the elevation ramp: 1st to 99th, so stray points do not flatten it. */
export const RANGE_PERCENTILES = [0.01, 0.99] as const;

/**
 * Up to `max` heights spread evenly over the `count` points, `yAt(i)` giving point i's local Y.
 * Non-finite heights are skipped.
 */
export function sampleHeights(
  count: number,
  yAt: (i: number) => number,
  max = HEIGHT_SAMPLES,
): Float32Array {
  const n = Math.min(count, max);
  const out = new Float32Array(n);
  if (n === 0) return out;
  const step = count / n;
  let k = 0;
  for (let j = 0; j < n; j++) {
    const y = yAt(Math.floor(j * step));
    if (Number.isFinite(y)) out[k++] = y;
  }
  return k === n ? out : out.slice(0, k);
}

export interface HeightSample {
  heights: readonly number[] | Float32Array;
  /** Points each sampled height stands for (chunk points / samples); default 1. */
  weight?: number;
}

export interface HeightStats {
  /** The ramp's range: the percentiles of the heights. */
  range: [number, number];
  /** Lowest and highest sampled height. */
  extent: [number, number];
}

/**
 * The robust height range of weighted samples: the `lo` and `hi` weighted percentiles (defaults
 * 1st and 99th) and the full extent. When the percentiles meet (a flat cloud) the extent is used;
 * null without any finite height.
 */
export function robustHeightRange(
  samples: readonly HeightSample[],
  lo: number = RANGE_PERCENTILES[0],
  hi: number = RANGE_PERCENTILES[1],
): HeightStats | null {
  const ys: number[] = [];
  const ws: number[] = [];
  for (const s of samples) {
    const w = s.weight ?? 1;
    if (!(w > 0) || !Number.isFinite(w)) continue;
    for (const y of s.heights) {
      if (!Number.isFinite(y)) continue;
      ys.push(y);
      ws.push(w);
    }
  }
  if (ys.length === 0) return null;
  const order = ys.map((_, i) => i).sort((a, b) => (ys[a] ?? 0) - (ys[b] ?? 0));
  const sorted = order.map((i) => ys[i] ?? 0);
  const total = ws.reduce((a, b) => a + b, 0);
  const at = (f: number): number => {
    const goal = f * total;
    let acc = 0;
    for (let j = 0; j < order.length; j++) {
      acc += ws[order[j] ?? 0] ?? 0;
      if (acc >= goal) return sorted[j] ?? 0;
    }
    return sorted[sorted.length - 1] ?? 0;
  };
  const extent: [number, number] = [sorted[0] ?? 0, sorted[sorted.length - 1] ?? 0];
  const a = at(Math.min(lo, hi));
  const b = at(Math.max(lo, hi));
  return { range: b - a > 1e-3 ? [a, b] : extent, extent };
}
