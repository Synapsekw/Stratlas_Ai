import type { ThermalRaster } from './raster';

/** The 1st and 99th percentile of the finite values: a few hot or cold pixels do not stretch it. */
export function autoRange(r: ThermalRaster): [number, number] {
  const finite = new Float32Array(r.data.length);
  let n = 0;
  for (const v of r.data) if (Number.isFinite(v)) finite[n++] = v;
  if (n === 0) return [0, 1];
  const sorted = finite.subarray(0, n).sort();
  const at = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))] ?? 0;
  const lo = at(0.01);
  const hi = at(0.99);
  return hi > lo ? [lo, hi] : [lo - 0.5, lo + 0.5];
}
