/**
 * Which side of its date a chart's readout card goes (the time chart and the date strip): the
 * half-way rule (past the plot's middle it flips to the left), unless that side would cover the
 * newest point, the one people come to read, or leave the chart while the other side would not.
 */

/** The readout card's width for placement (`.pc-readout` is at least 150 px; figures widen it). */
export const READOUT_W = 180;
/** A point's mark and its ring: the card keeps this far off the newest point. */
const MARK_R = 6;

export interface ReadoutPlace {
  /** The date's x, the card's anchor. */
  x: number;
  /** The newest point's x. */
  lastX: number;
  /** The plot's start and width, and the chart's width. */
  left: number;
  plotW: number;
  w: number;
  /** Between the anchor and the card. */
  gap: number;
  cardW: number;
}

/** True: the card sits left of its date (its end edge `gap` before it); false: right of it. */
export function readoutFlips(p: ReadoutPlace): boolean {
  const spanOf = (flip: boolean): [number, number] =>
    flip ? [p.x - p.gap - p.cardW, p.x - p.gap] : [p.x + p.gap, p.x + p.gap + p.cardW];
  const covers = (flip: boolean) => {
    const [a, b] = spanOf(flip);
    return p.lastX + MARK_R > a && p.lastX - MARK_R < b;
  };
  const fits = (flip: boolean) => {
    const [a, b] = spanOf(flip);
    return a >= 0 && b <= p.w;
  };
  const preferred = p.x > p.left + p.plotW / 2;
  const good = (flip: boolean) => !covers(flip) && fits(flip);
  if (good(preferred)) return preferred;
  if (good(!preferred)) return !preferred;
  // neither side is clean: never over the newest point first, then the half-way rule
  if (!covers(preferred)) return preferred;
  if (!covers(!preferred)) return !preferred;
  return preferred;
}
