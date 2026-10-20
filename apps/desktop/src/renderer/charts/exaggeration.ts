/**
 * The profile chart's vertical exaggeration, worked out once for the card, the pile section and
 * the report: the whole step (1, 2, 5, 10 or 20) that fills the chart's plot with the series.
 */
import type { ChartSeries } from '@aio/survey';
import { DEFAULT_PLOT } from './ProfileChart';

/** The profile chart's size when none is given (`ProfileChart`'s defaults). */
const DEFAULT_SIZE = { width: 600, height: 220 } as const;

/** The plot inside the axes of a profile chart drawn `width` by `height` CSS pixels. */
export function plotOf(width: number, height: number): { width: number; height: number } {
  return {
    width: width - (DEFAULT_SIZE.width - DEFAULT_PLOT.width),
    height: height - (DEFAULT_SIZE.height - DEFAULT_PLOT.height),
  };
}

/** A vertical exaggeration that fills `plot` (the default plot unless given), in whole steps from 1 to 20. */
export function autoExaggeration(
  series: readonly ChartSeries[],
  plot: { width: number; height: number } = DEFAULT_PLOT,
): number {
  let c1 = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    c1 = Math.max(c1, s.chainage.at(-1) ?? 0);
    for (const z of s.z)
      if (z !== null) {
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
  }
  if (!(hi > lo) || c1 <= 0) return 1;
  const fill = (c1 / (hi - lo)) * (plot.height / plot.width);
  return [20, 10, 5, 2, 1].find((x) => x <= fill) ?? 1;
}
