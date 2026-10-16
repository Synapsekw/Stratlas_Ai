import type { WalkCalibration } from '@aio/schema';
import type { WalkFit } from './fit';

/** A residual above this is worth a look, metres. */
export const WALK_CHECK_M = 0.5;
/** A residual above this makes the placement poor, metres. */
export const WALK_POOR_M = 2;

/** How well the walk is placed (design "The fit", rule 9). */
export function walkQuality(fit: WalkFit): WalkCalibration['quality'] {
  if (fit.error || fit.pins.filter((p) => p.active).length < 2) return 'unplaced';
  const residuals = fit.pins.flatMap((p) => (p.residualM === null ? [] : [p.residualM]));
  if (residuals.some((r) => r > WALK_POOR_M)) return 'poor';
  if (
    residuals.some((r) => r > WALK_CHECK_M) ||
    fit.gaps.length > 0 ||
    fit.pins.some((p) => !p.active) ||
    !!fit.warning ||
    fit.pinsOnly
  )
    return 'check';
  return 'good';
}

/**
 * The line on the walk's badge: the refusal, else the first break without a fit
 * ("Path broken 3:12 to 3:20: add a pin after the gap"), else null. `fmt` formats seconds.
 */
export function walkBadgeText(fit: WalkFit, fmt: (s: number) => string): string | null {
  if (fit.error) return fit.error;
  const gap = fit.gaps[0];
  if (gap) return `Path broken ${fmt(gap.fromT)} to ${fmt(gap.toT)}: add a pin after the gap`;
  return fit.warning ?? null;
}
