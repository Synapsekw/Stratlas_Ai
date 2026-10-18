export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const INSET = 8;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Where the floating card goes. A dragged position (clamped inside the stage) wins.
 * Otherwise right of the box, then left of it, vertically centred and clamped; if neither
 * side fits, or there is no box on stage, the card docks to the stage's top-right corner.
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
  const dock = { x: stage.x + stage.w - card.w - INSET, y: stage.y + INSET, docked: true };
  const onStage =
    box !== null &&
    box.x < stage.x + stage.w &&
    box.x + box.w > stage.x &&
    box.y < stage.y + stage.h &&
    box.y + box.h > stage.y;
  if (!box || !onStage) return dock;
  const y = clamp(box.y + box.h / 2 - card.h / 2, minY, maxY);
  const right = box.x + box.w + gap;
  if (right + card.w <= stage.x + stage.w) return { x: right, y, docked: false };
  const left = box.x - gap - card.w;
  if (left >= stage.x) return { x: left, y, docked: false };
  return dock;
}
