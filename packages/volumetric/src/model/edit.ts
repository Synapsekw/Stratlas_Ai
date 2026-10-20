/**
 * Ring helpers for the kit's toe lines in 3D: densify, row crossings and area. The kit's boundary
 * editor and its volume sums retired with the kit volumes UI (volumetric parity W3); a pile's
 * outline is edited on its volume measurement, which the survey engine computes.
 * Coordinates are easting and northing in the project CRS.
 */

export type EN = [number, number];

/** Surface height at (E, N), or null where there is no data. */
export type Surface = (E: number, N: number) => number | null;

/** Points every `step` metres along each edge of a closed ring (the kit's `dens`). */
export function densify(ring: readonly EN[], step: number): EN[] {
  const out: EN[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (!a || !b) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let s = 0; s < n; s++)
      out.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  return out;
}

/** Sorted eastings where the row at northing `N` crosses the ring. */
export function spans(ring: readonly EN[], N: number): number[] {
  const xs: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (!a || !b) continue;
    if (a[1] > N !== b[1] > N) xs.push(a[0] + ((N - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  return xs.sort((p, q) => p - q);
}

export function ringArea(ring: readonly EN[]): number {
  let s = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    if (a && b) s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}
