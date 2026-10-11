/**
 * The Quadrion AI symbol as path data, drawn from the Quarter mark's geometry (quarter.ts). Callers
 * choose the colours (the quarters take the foreground, the tail the accent), so one shape serves
 * dark and light themes and any size. The wordmark is in marks.ts.
 */

import {
  QUARTER,
  QUARTER_SMALL,
  quarterBounds,
  quarterPieces,
  quarterSmallPieces,
  type QuarterCut,
} from './quarter';

/** The square a cut occupies, as an SVG view box. */
const viewBoxOf = (cut: QuarterCut): string => {
  const b = quarterBounds(cut);
  return [b.x, b.y, b.w, b.h].join(' ');
};

/** Symbol: three quarters of a ring and the tail, the lit fourth piece. It reads as a Q. */
export const SYMBOL = {
  viewBox: viewBoxOf(QUARTER),
  /** North-west, north-east and south-west quarters, then the tail. */
  pieces: quarterPieces(),
  /** The small-size cut for 32 px and less: the ring closed into one piece, then the tail. */
  smallViewBox: viewBoxOf(QUARTER_SMALL),
  small: quarterSmallPieces(),
} as const;
