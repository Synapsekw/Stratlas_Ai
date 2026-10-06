/**
 * Swipe and blend of two survey dates over one view (M8 C2, REV-3): the later date's pane lies
 * over the earlier one and shows only right of a draggable divider (swipe), or with an opacity
 * (blend). Pure geometry here; the stage applies it with CSS (`clip-path`, `opacity`).
 */

/** How two dates of a map or an ortho are shown: side by side, swiped or blended. */
export type CompareView = 'side' | 'swipe' | 'blend';

export const COMPARE_VIEWS: readonly CompareView[] = ['side', 'swipe', 'blend'];

/** The divider keeps this far from the edges (fraction of the width), so it can be grabbed. */
export const SWIPE_MARGIN = 0.02;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A divider position (fraction of the width, 0 left to 1 right), kept inside the margins. */
export function clampSwipe(at: number): number {
  if (!Number.isFinite(at)) return 0.5;
  return clamp(at, SWIPE_MARGIN, 1 - SWIPE_MARGIN);
}

/** The divider position under a pointer at `clientX` over a box starting at `left`. */
export function swipeAt(clientX: number, box: { left: number; width: number }): number {
  if (!(box.width > 0)) return 0.5;
  return clampSwipe((clientX - box.left) / box.width);
}

/**
 * The upper (later) pane's clip for a divider at `at`: the pixels it hides on the left, and the
 * CSS `clip-path` that shows the rest. Whole pixels, so the edge never blurs.
 */
export function swipeClip(at: number, width: number): { hiddenPx: number; clipPath: string } {
  const hiddenPx = Math.round(clampSwipe(at) * Math.max(0, width));
  return { hiddenPx, clipPath: `inset(0px 0px 0px ${String(hiddenPx)}px)` };
}

/** The upper pane's opacity for a blend value (0 shows the earlier date, 1 the later). */
export function blendOpacity(blend: number): number {
  if (!Number.isFinite(blend)) return 0.5;
  return Math.round(clamp(blend, 0, 1) * 100) / 100;
}

/** A keyboard step of the divider or the blend: arrows 2%, with Shift 10%, Home and End. */
export function stepValue(
  value: number,
  key: string,
  shift: boolean,
  lo = 0,
  hi = 1,
): number | null {
  const step = shift ? 0.1 : 0.02;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(value - step, lo, hi);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(value + step, lo, hi);
    case 'Home':
      return lo;
    case 'End':
      return hi;
    default:
      return null;
  }
}
