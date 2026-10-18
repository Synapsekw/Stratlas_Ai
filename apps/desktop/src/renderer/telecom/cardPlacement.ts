export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const INSET = 8;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/** The area two rects share, 0 when they are apart. */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where the floating card goes. A dragged position (clamped inside the stage) wins.
 * Otherwise the first spot that clears the box: right of it, then left (vertically centred
 * and clamped), then above, then below (horizontally centred and clamped), then the stage's
 * four corners (top-right, top-left, bottom-right, bottom-left, 8 px in). If no spot clears
 * the box, the one that covers least of it. Corners report `docked`. Without a box on stage
 * the card docks top-right.
 */
export function placeCard(
  box: Rect | null,
  stage: Rect,
  card: { w: number; h: number },
  dragged: { x: number; y: number } | null,
  gap = 16,
): { x: number; y: number; docked: boolean } {
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

  let best = topRight;
  let least = Infinity;
  for (const s of spots) {
    const area = overlapArea({ x: s.x, y: s.y, w: card.w, h: card.h }, box);
    if (area === 0) return s;
    if (area < least) {
      least = area;
      best = s;
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
