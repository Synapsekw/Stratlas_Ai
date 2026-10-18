export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Something on screen the card should not cover, and how much covering it costs per pixel. */
export interface AvoidArea {
  rect: Rect;
  weight: number;
}

/** What covering each part of the selected unit costs: its box, then its name, angle, sizes. */
export const AVOID_WEIGHT = { box: 100, name: 50, angle: 10, dim: 1 } as const;

export interface PlaceOptions {
  /** Stage controls the card never covers (the Labels control at the bottom left). */
  reserved?: readonly Rect[];
  /**
   * The parts of the selected unit, weighted: when no spot clears `box`, the spot with the least
   * weighted cover wins. Without them, the spot that covers least of `box`.
   */
  areas?: readonly AvoidArea[];
  gap?: number;
}

const INSET = 8;
const GRID = 8;
/** The card is never capped shorter than this, CSS pixels. */
export const CARD_MIN_H = 200;

/** Where the card goes, and the height it is capped to when it sits in a band (`placeCard`). */
export interface CardPlace {
  x: number;
  y: number;
  docked: boolean;
  maxH?: number;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/** The area two rects share, 0 when they are apart. */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where the floating card goes; `card` is its full height. A spot from `placeFull` unless that
 * still covers the protected parts of the unit (the `areas` weighing at least the name: its box
 * and name): then the card is capped to the larger free band above or below them (less the gap,
 * 8 px from the stage's edge, and clear of the `reserved` controls in its columns), at least
 * `CARD_MIN_H`, and sits in that band, horizontally centred on them and clamped. A dragged
 * position always wins, at the full height.
 */
export function placeCard(
  box: Rect | null,
  stage: Rect,
  card: { w: number; h: number },
  dragged: { x: number; y: number } | null,
  opts: PlaceOptions = {},
): CardPlace {
  const full = placeFull(box, stage, card, dragged, opts);
  const { reserved = [], areas = [], gap = 16 } = opts;
  const guard = areas.filter((a) => a.weight >= AVOID_WEIGHT.name).map((a) => a.rect);
  if (dragged || !box || guard.length === 0) return full;
  const at = { x: full.x, y: full.y, w: card.w, h: card.h };
  if (guard.every((r) => overlapArea(at, r) === 0)) return full;

  const p = guard.reduce(union);
  const minX = stage.x;
  const maxX = stage.x + stage.w - card.w;
  const x = clamp(p.x + p.w / 2 - card.w / 2, minX, maxX);
  // the reserved controls in the card's columns
  const inColumns = reserved.filter((r) => r.x < x + card.w && x < r.x + r.w);
  const belowTop = p.y + p.h + gap;
  let belowBottom = stage.y + stage.h - INSET;
  for (const r of inColumns) {
    if (r.y + r.h > belowTop) belowBottom = Math.min(belowBottom, r.y - INSET);
  }
  const aboveBottom = p.y - gap;
  let aboveTop = stage.y + INSET;
  for (const r of inColumns) {
    if (r.y < aboveBottom) aboveTop = Math.max(aboveTop, r.y + r.h + INSET);
  }
  const roomBelow = belowBottom - belowTop;
  const roomAbove = aboveBottom - aboveTop;
  const below = roomBelow >= roomAbove;
  const maxH = Math.max(CARD_MIN_H, Math.min(card.h, below ? roomBelow : roomAbove));
  const y = clamp(below ? belowTop : aboveBottom - maxH, stage.y, stage.y + stage.h - maxH);
  return { x, y, docked: false, maxH };
}

const union = (a: Rect, b: Rect): Rect => {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return {
    x: x0,
    y: y0,
    w: Math.max(a.x + a.w, b.x + b.w) - x0,
    h: Math.max(a.y + a.h, b.y + b.h) - y0,
  };
};

/**
 * Where the card goes at its full height. A dragged position (clamped inside the stage) wins.
 * Otherwise the first spot that clears the box: right of it, then left (vertically centred
 * and clamped), then above, then below (horizontally centred and clamped), then the stage's
 * four corners (top-right, top-left, bottom-right, bottom-left, 8 px in). If no spot clears
 * the box, the one with the least weighted cover of `areas` (the box costs most, then the name,
 * the angle and the sizes), weighing every stage spot on an 8 px grid as well; without areas,
 * the spot that covers least of the box. A tie goes to the earlier spot. Corners and grid spots
 * report `docked` (no leader line). Without a box on stage the card docks top-right.
 *
 * A spot that would cover a `reserved` control rises to stand 8 px above it, or is dropped if it
 * then leaves the stage's top.
 */
function placeFull(
  box: Rect | null,
  stage: Rect,
  card: { w: number; h: number },
  dragged: { x: number; y: number } | null,
  { reserved = [], areas = [], gap = 16 }: PlaceOptions,
): CardPlace {
  const minX = stage.x;
  const maxX = stage.x + stage.w - card.w;
  const minY = stage.y;
  const maxY = stage.y + stage.h - card.h;
  if (dragged) {
    return { x: clamp(dragged.x, minX, maxX), y: clamp(dragged.y, minY, maxY), docked: false };
  }
  const topRight = { x: maxX - INSET, y: minY + INSET, docked: true };
  const onStage =
    box !== null &&
    box.x < stage.x + stage.w &&
    box.x + box.w > stage.x &&
    box.y < stage.y + stage.h &&
    box.y + box.h > stage.y;
  if (!box || !onStage) return topRight;

  const spots: { x: number; y: number; docked: boolean }[] = [];
  const y = clamp(box.y + box.h / 2 - card.h / 2, minY, maxY);
  const right = box.x + box.w + gap;
  if (right + card.w <= stage.x + stage.w) spots.push({ x: right, y, docked: false });
  const left = box.x - gap - card.w;
  if (left >= stage.x) spots.push({ x: left, y, docked: false });
  const x = clamp(box.x + box.w / 2 - card.w / 2, minX, maxX);
  const above = box.y - gap - card.h;
  if (above >= stage.y) spots.push({ x, y: above, docked: false });
  const below = box.y + box.h + gap;
  if (below + card.h <= stage.y + stage.h) spots.push({ x, y: below, docked: false });
  spots.push(
    topRight,
    { x: minX + INSET, y: minY + INSET, docked: true },
    { x: maxX - INSET, y: maxY - INSET, docked: true },
    { x: minX + INSET, y: maxY - INSET, docked: true },
  );

  const rect = (p: { x: number; y: number }): Rect => ({ x: p.x, y: p.y, w: card.w, h: card.h });
  const clear = (p: { x: number; y: number }) =>
    reserved.every((r) => overlapArea(rect(p), r) === 0);
  // a spot over a reserved control rises above it
  const kept = spots.flatMap((p) => {
    if (clear(p)) return [p];
    const over = reserved.filter((r) => overlapArea(rect(p), r) > 0);
    const lifted = { ...p, y: Math.min(...over.map((r) => r.y)) - INSET - card.h };
    return lifted.y >= minY && clear(lifted) ? [lifted] : [];
  });

  const clearOfBox = kept.find((p) => overlapArea(rect(p), box) === 0);
  if (clearOfBox) return clearOfBox;
  // nothing clears: with weighted areas, every spot on an 8 px grid is weighed too, after the
  // corners (they win a tie), so the card can rest where it covers only the cheap parts
  if (areas.length > 0) {
    for (let gy = minY; gy <= maxY; gy += GRID) {
      for (let gx = minX; gx <= maxX; gx += GRID) {
        const p = { x: gx, y: gy, docked: true };
        if (clear(p)) kept.push(p);
      }
    }
  }
  const cost = (p: { x: number; y: number }): number =>
    areas.length > 0
      ? areas.reduce((sum, a) => sum + a.weight * overlapArea(rect(p), a.rect), 0)
      : overlapArea(rect(p), box);
  let best = topRight;
  let least = Infinity;
  for (const p of kept) {
    const c = cost(p);
    if (c < least) {
      least = c;
      best = p;
    }
  }
  return best;
}

/**
 * The leader from the box to the card. Beside the box: from its right- or left-middle to the
 * card's near side edge. Above or below it: from its top- or bottom-middle to the card's near
 * bottom or top edge. The card end slides along that edge, 12 px in from the card's corners,
 * to keep the line as straight as it can.
 */
export function leaderLine(
  box: Rect,
  card: { x: number; y: number },
  size: { w: number; h: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const right = card.x >= box.x + box.w;
  const beside = right || card.x + size.w <= box.x;
  const above = card.y + size.h <= box.y;
  if (!beside && (above || card.y >= box.y + box.h)) {
    const x1 = box.x + box.w / 2;
    const inset = Math.min(12, size.w / 2);
    return {
      x1,
      y1: above ? box.y : box.y + box.h,
      x2: Math.min(Math.max(x1, card.x + inset), card.x + size.w - inset),
      y2: above ? card.y + size.h : card.y,
    };
  }
  const y1 = box.y + box.h / 2;
  const inset = Math.min(12, size.h / 2);
  return {
    x1: right ? box.x + box.w : box.x,
    y1,
    x2: right ? card.x : card.x + size.w,
    y2: Math.min(Math.max(y1, card.y + inset), card.y + size.h - inset),
  };
}
