/**
 * The geometry of the Globe's site chips and of the card at a pin, in CSS pixels: how a name is
 * cut, where a chip's dot, name and badge sit, and where the card goes so it stays in the view.
 * No DOM and no CesiumJS: the view draws and places with these numbers.
 */

export const CHIP = {
  height: 24,
  /** Clear room around a chip in its sprite: its outline, and a gap between neighbours. */
  pad: 3,
  /** From the chip's left edge to the centre of its dot (the site itself). */
  dotX: 12,
  dotRadius: 4,
  /** From the dot's centre to the start of the name. */
  nameGap: 11,
  /** Room after the name when no badge follows it. */
  endPad: 11,
  badgeGap: 7,
  badgeHeight: 16,
  badgePadX: 5,
  /** Room after the badge. */
  badgeEnd: 4,
  /** The widest a name is drawn before it is cut. */
  maxName: 168,
} as const;

/** The width of a text as the chip's font draws it. */
export type Measure = (text: string) => number;

const ELLIPSIS = '…';

/** A name no wider than `maxWidth`: itself, or its longest start that fits with an ellipsis. */
export function fitLabel(text: string, maxWidth: number, measure: Measure): string {
  if (measure(text) <= maxWidth) return text;
  // by code point: a cut never lands inside a pair of surrogates
  const chars = Array.from(text);
  const cut = (n: number) => `${chars.slice(0, n).join('').trimEnd()}${ELLIPSIS}`;
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(cut(mid)) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ELLIPSIS : cut(lo);
}

/** The words of a chip's badge: its open issues, none without any, "99+" past 99. */
export function issueBadge(open: number): string | null {
  if (open <= 0) return null;
  return open > 99 ? '99+' : String(open);
}

export interface ChipMetrics {
  width: number;
  height: number;
  /** Where the name starts, from the chip's left edge. */
  nameX: number;
  /** The badge's left edge and width; null without one. */
  badge: { x: number; width: number } | null;
}

/** A chip's size and parts for a name of `nameWidth` and a badge whose text is `badgeTextWidth`. */
export function chipMetrics(nameWidth: number, badgeTextWidth: number | null): ChipMetrics {
  const nameX = CHIP.dotX + CHIP.nameGap;
  const nameEnd = nameX + nameWidth;
  if (badgeTextWidth === null)
    return { width: Math.ceil(nameEnd + CHIP.endPad), height: CHIP.height, nameX, badge: null };
  const badge = {
    x: nameEnd + CHIP.badgeGap,
    width: Math.max(CHIP.badgeHeight, badgeTextWidth + 2 * CHIP.badgePadX),
  };
  return {
    width: Math.ceil(badge.x + badge.width + CHIP.badgeEnd),
    height: CHIP.height,
    nameX,
    badge,
  };
}

export interface ViewSize {
  width: number;
  height: number;
}

/** The room the screen's own controls take at each edge of the Globe. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CardPlace {
  left: number;
  top: number;
  side: 'below' | 'above';
}

/** From a pin's centre to the near edge of its card. */
export const CARD_GAP = 18;

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), Math.max(min, max));

/**
 * Where the card of the pin at `pin` goes: under it with its left edge at the chip's, above it
 * when there is no room below, and always inside the view less its insets (it slides along an
 * edge rather than leave).
 */
export function placeCard(
  pin: { x: number; y: number },
  card: ViewSize,
  view: ViewSize,
  insets: Insets,
): CardPlace {
  const left = clamp(pin.x - CHIP.dotX, insets.left, view.width - insets.right - card.width);
  const floor = view.height - insets.bottom;
  const below = pin.y + CARD_GAP;
  const above = pin.y - CARD_GAP - card.height;
  const fitsBelow = below + card.height <= floor;
  const fitsAbove = above >= insets.top;
  // neither way: the side with more room
  const side: CardPlace['side'] =
    fitsBelow || (!fitsAbove && floor - below >= pin.y - CARD_GAP - insets.top) ? 'below' : 'above';
  const top = clamp(side === 'below' ? below : above, insets.top, floor - card.height);
  return { left: Math.round(left), top: Math.round(top), side };
}
