/** Pure size rules of the resizable split: limits, collapse snap and keyboard steps. */

/** One arrow key press, in px. */
export const SPLIT_STEP = 16;
/** One Shift + arrow key press, in px. */
export const SPLIT_STEP_BIG = 64;
/** How far below its minimum a dragged pane has to go before it snaps to collapsed, in px. */
export const SNAP_MARGIN = 48;

export interface SplitLimits {
  min: number; // sized pane, px
  max: number | `${number}%`; // sized pane
  otherMin: number; // the other pane, px
  /**
   * The share of the container (0 to 1) the sized pane gives way to when the container is too
   * small for both minimums, so the other pane keeps room; absent: the sized pane keeps `min`.
   */
  minShare?: number;
}

/** The sized pane's maximum in px for a container of `container` px. */
export function maxPx(max: SplitLimits['max'], container: number): number {
  return typeof max === 'number' ? max : (container * Number.parseFloat(max)) / 100;
}

/** The sized pane's minimum in px for a container of `container` px: `min`, or its share. */
export function minPx(l: SplitLimits, container: number): number {
  return l.minShare === undefined ? l.min : Math.min(l.min, l.minShare * container);
}

/**
 * The sized pane's size within its limits: at most its max and what leaves the other pane its
 * minimum, at least its own minimum. When both cannot hold, the sized pane (chrome) keeps its
 * minimum and the other pane gives way; with a `minShare`, the sized pane gives way first, down
 * to its share of the container.
 */
export function clampSplit(size: number, container: number, l: SplitLimits): number {
  const upper = Math.min(maxPx(l.max, container), container - l.otherMin);
  return Math.max(minPx(l, container), Math.min(size, upper));
}

/** Whether a dragged size is far enough below the minimum to snap to collapsed. */
export function snapsToCollapse(size: number, l: SplitLimits): boolean {
  return size < l.min - SNAP_MARGIN;
}

/**
 * What a key does to the sized pane: a size change in px, `'min'`, `'max'`, `'toggle'` (collapse)
 * or `null`. Arrows move the edge: the left and right arrows follow the screen, so they swap in
 * right to left layouts, where the start pane is on the right.
 */
export function keyStep(
  key: string,
  shift: boolean,
  rtl: boolean,
  sized: 'start' | 'end',
): number | 'min' | 'max' | 'toggle' | null {
  if (key === 'Home') return 'min';
  if (key === 'End') return 'max';
  if (key === 'Enter') return 'toggle';
  const step = shift ? SPLIT_STEP_BIG : SPLIT_STEP;
  // +1: the edge moves towards the end of the line (start pane grows)
  let towardsEnd: number;
  if (key === 'ArrowRight') towardsEnd = rtl ? -1 : 1;
  else if (key === 'ArrowLeft') towardsEnd = rtl ? 1 : -1;
  else if (key === 'ArrowDown') towardsEnd = 1;
  else if (key === 'ArrowUp') towardsEnd = -1;
  else return null;
  return step * towardsEnd * (sized === 'start' ? 1 : -1);
}
