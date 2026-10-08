/** Cut and fill of one comparison with its signed totals, cubic metres. */
export interface VolumeTotals {
  cut: number;
  fill: number;
  /** fill - cut: positive when material was added. */
  net: number;
  /** fill + cut: the material moved. */
  total: number;
}

/**
 * The totals every comparison shows (data-conventions section 26: `dz = To - From`, fill where
 * `dz > 0`, cut where `dz < 0`). `cut` and `fill` are both magnitudes, so a negative or
 * non-finite value is a caller error, refused rather than folded into the net.
 */
export function signedVolumeTotals(cut: number, fill: number): VolumeTotals {
  for (const [name, v] of [
    ['cut', cut],
    ['fill', fill],
  ] as const) {
    if (!Number.isFinite(v) || v < 0)
      throw new RangeError(`${name} must be a finite volume of zero or more (got ${String(v)}).`);
  }
  return { cut, fill, net: fill - cut, total: fill + cut };
}
