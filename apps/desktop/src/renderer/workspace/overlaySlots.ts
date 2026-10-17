/**
 * The stage's overlay layout (D30): four corner slots around the top-centre island. An overlay
 * takes a free corner and never stacks on another; one whose corners are all taken is hidden.
 * Corners are named by the reading direction: `tl` is the top of the start edge (the top right
 * in a right-to-left UI), as the slots are placed with logical insets.
 */

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br'];

export interface SlotRequest {
  id: string;
  /** The corners it may take, best first; none: it is hidden. */
  want: readonly Corner[];
}

/**
 * Each overlay, in the order given (the first is served first), takes the first corner it wants
 * that no overlay before it took; the rest are `hidden`.
 */
export function assignSlots(items: readonly SlotRequest[]): Map<string, Corner | 'hidden'> {
  const taken = new Set<Corner>();
  const out = new Map<string, Corner | 'hidden'>();
  for (const item of items) {
    const corner = item.want.find((c) => !taken.has(c));
    if (corner) taken.add(corner);
    out.set(item.id, corner ?? 'hidden');
  }
  return out;
}

/** A box reaches into a stage quarter when it goes this far past the middle line. */
export const REACH = 24;

/**
 * The corners a box takes: each stage quarter it reaches into (a wide window on a narrow stage
 * takes both bottom corners), the quarter of its centre first. The box is in physical pixels from
 * the stage's top left; `rtl` names the corners by a right-to-left reading.
 */
export function cornersOf(
  box: { left: number; top: number; width: number; height: number },
  stage: { width: number; height: number },
  rtl = false,
): Corner[] {
  const midX = stage.width / 2;
  const midY = stage.height / 2;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const sides = (lo: number, hi: number, mid: number, c: number): boolean[] => {
    const first = c < mid;
    const other = first ? hi > mid + REACH : lo < mid - REACH;
    return other ? [first, !first] : [first];
  };
  const out: Corner[] = [];
  for (const top of sides(box.top, box.top + box.height, midY, cy))
    for (const left of sides(box.left, box.left + box.width, midX, cx)) {
      const start = rtl ? !left : left;
      out.push(top ? (start ? 'tl' : 'tr') : start ? 'bl' : 'br');
    }
  return out;
}
