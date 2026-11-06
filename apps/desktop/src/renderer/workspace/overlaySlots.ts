/**
 * The stage's overlay slots (UI revision D5), the one source of where an overlay stands. Only five
 * slots exist: the island at the top centre; the map style (with Streets) and the dates on screen
 * at the top right; one hint or one toast at a time at the bottom left
 * (newest wins, the rest wait); the legends at the bottom right, above the compass, the scale bar
 * and the coordinates readout; and, floating, only the popped-out video and a tool's on-stage
 * handles. Job progress has no slot: it is the Jobs chip's (the title bar), so a job card never
 * covers a view.
 *
 * Corners are named by the reading direction: `tl` is the top of the start edge (the top right
 * in a right-to-left UI), as the slots are placed with logical insets. Nothing takes `tl` but
 * the floating video, the open island reaching across it, in a Split the map style at the
 * top of a map pane on the start side, and, until it moves into Layers & display, the Show control
 * while the Volumes tab is open (Stage.tsx places it; it is no slot of its own).
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

/* ------------------------------------------------------------------------- D5 */

export type StageSlot = 'top-centre' | 'top-right' | 'bottom-left' | 'bottom-right' | 'floating';

/** The only slots there are (D5). */
export const STAGE_SLOTS: readonly StageSlot[] = [
  'top-centre',
  'top-right',
  'bottom-left',
  'bottom-right',
  'floating',
];

/** What stands on the stage. */
export type StageOverlay =
  'island' | 'mapStyle' | 'dates' | 'hint' | 'toast' | 'legend' | 'video' | 'handles';

/** The one slot of each overlay. */
export const SLOT_OF: Readonly<Record<StageOverlay, StageSlot>> = {
  island: 'top-centre',
  mapStyle: 'top-right',
  dates: 'top-right',
  hint: 'bottom-left',
  toast: 'bottom-left',
  legend: 'bottom-right',
  video: 'floating',
  handles: 'floating',
};

/** The stage corner of each corner slot; the island and the floating ones place themselves. */
export const CORNER_OF: Readonly<Partial<Record<StageSlot, Corner>>> = {
  'top-right': 'tr',
  'bottom-left': 'bl',
  'bottom-right': 'br',
};

/** The slots that show one overlay at a time; the others stack theirs. */
const ONE_AT_A_TIME: ReadonlySet<StageSlot> = new Set(['bottom-left']);

export interface OverlayRequest {
  id: string;
  overlay: StageOverlay;
  /** When it came (a one-at-a-time slot shows the newest). */
  since?: number;
  /** Another corner for its slot: the top right of one view of a Split. */
  at?: Corner;
}

/** The latest arrival; a tie goes to the later one in the list. */
export function newest(items: readonly { id: string; since: number }[]): string | null {
  let best: { id: string; since: number } | null = null;
  for (const x of items) if (!best || x.since >= best.since) best = x;
  return best?.id ?? null;
}

/**
 * The corner each overlay stands in, or `hidden`: its slot's corner, unless the floating video or
 * the open island takes that corner (`blocked`); in a one-at-a-time slot only the newest shows.
 * The island and the floating overlays are not placed here (`hidden` from the corners' view).
 */
export function placeOverlays(
  items: readonly OverlayRequest[],
  blocked: ReadonlySet<Corner> = new Set(),
): Map<string, Corner | 'hidden'> {
  const cornerOf = (x: OverlayRequest) => x.at ?? CORNER_OF[SLOT_OF[x.overlay]];
  const winners = new Map<StageSlot, string | null>();
  for (const slot of ONE_AT_A_TIME)
    winners.set(
      slot,
      newest(
        items
          .filter((x) => SLOT_OF[x.overlay] === slot && x.at === undefined)
          .map((x) => ({ id: x.id, since: x.since ?? 0 })),
      ),
    );
  const out = new Map<string, Corner | 'hidden'>();
  for (const x of items) {
    const corner = cornerOf(x);
    const slot = SLOT_OF[x.overlay];
    const waits = winners.has(slot) && x.at === undefined && winners.get(slot) !== x.id;
    out.set(x.id, !corner || blocked.has(corner) || waits ? 'hidden' : corner);
  }
  return out;
}
