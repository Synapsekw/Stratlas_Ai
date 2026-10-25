/**
 * Keeps the 3D view's measurement labels apart (volumetric report, bug 5): piles that sit close
 * together put their labels on top of each other. In priority order (the label under the pointer,
 * then the selected ones, then the larger volume) each label keeps its place when it is free, is
 * nudged up by its own height plus a gap when that spot is free, or is hidden until the pointer
 * rests on it.
 */

/** A label's box on screen, at the place its anchor puts it. */
export interface LabelBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  /** Bigger first among equals: a pile's volume on the date in focus (0 for other labels). */
  weight: number;
}

/** Where a label goes: moved up by `dy` pixels (zero or negative), or hidden. */
export interface LabelPlacement {
  dy: number;
  hidden: boolean;
}

/** The gap between a nudged label and the one it moved out of the way of, in pixels. */
export const LABEL_GAP = 4;

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const contains = (b: Rect, p: { x: number; y: number }) =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/**
 * Each label's placement, by id. `hover` is the pointer in the same coordinates as the boxes: a
 * label under it goes first, so a hidden one shows while the pointer rests on its place.
 */
export function declutter(
  boxes: readonly LabelBox[],
  hover: { x: number; y: number } | null = null,
): Map<string, LabelPlacement> {
  const rank = (b: LabelBox) => (hover && contains(b, hover) ? 2 : 0) + (b.selected ? 1 : 0);
  const order = boxes
    .map((b, i) => ({ b, i }))
    .sort((p, q) => rank(q.b) - rank(p.b) || q.b.weight - p.b.weight || p.i - q.i);
  const placed: Rect[] = [];
  const out = new Map<string, LabelPlacement>();
  for (const { b } of order) {
    const free = (dy: number) => {
      const r = { x: b.x, y: b.y + dy, w: b.w, h: b.h };
      return placed.some((p) => overlaps(p, r)) ? null : r;
    };
    const nudge = -(b.h + LABEL_GAP);
    const at = free(0) ? 0 : free(nudge) ? nudge : null;
    if (at === null) {
      out.set(b.id, { dy: 0, hidden: true });
      continue;
    }
    placed.push({ x: b.x, y: b.y + at, w: b.w, h: b.h });
    out.set(b.id, { dy: at, hidden: false });
  }
  return out;
}
