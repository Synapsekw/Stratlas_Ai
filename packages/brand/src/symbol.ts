/**
 * The Quadrion AI symbol as path data, drawn from the Quarter mark's geometry (quarter.ts). Callers
 * choose the colours (the quarters take the foreground, the tail the accent), so one shape serves
 * dark and light themes and any size. The wordmark is in marks.ts.
 */

import { quarterPieces, quarterSmallPieces } from './quarter';

/** Symbol: three quarters of a ring and the tail, the lit fourth piece. It reads as a Q. */
export const SYMBOL = {
  viewBox: '4 4 52 52',
  /** North-west, north-east and south-west quarters, then the tail. */
  pieces: quarterPieces(),
  /** The small-size cut for 32 px and less: the ring closed into one piece, then the tail. */
  smallViewBox: '4 4 53 53',
  small: quarterSmallPieces(),
} as const;
