/**
 * Where a stage popover goes. A popover opens below its tool, but it always stays on the stage:
 * never under the timeline below it or the Context panel beside it (the stage clips anything that
 * crosses its edges, and a click there lands on the timeline or the panel, not the popover). It
 * moves left to fit, moves up when it is nested in another popover, and scrolls inside when the
 * stage is too short for it (the smallest window, 1100 x 700, with both side panels open).
 */
import { useLayoutEffect, type RefObject } from 'react';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Align = 'start' | 'end';

export interface PopPlaceInput {
  /** The stage, in window coordinates: the popover stays inside it. */
  area: Box;
  /** The tool the popover opens from. */
  anchor: Box;
  /** The popover's own width and the full height of its content. */
  width: number;
  height: number;
  /** Which edge lines up with the tool (tools at the right end of the bar open toward the left). */
  align: Align;
  /** The highest it may go: under its own tool, or under the toolbar when nested in a popover. */
  minTop: number;
}

export interface PopPlace {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
  /** The content is taller than the room: it scrolls inside the popover. */
  scroll: boolean;
}

/** Kept between a popover and the stage's edges. */
const MARGIN = 8;
/** Between a tool and its popover (the CSS `top: calc(100% + 8px)`). */
const GAP = 8;
/** How far the popover's edge sits past its tool's (the CSS `inset-inline-start: -2px`). */
const OVERHANG = 2;

/** Where a popover goes on the stage (window coordinates). */
export function placePop(i: PopPlaceInput): PopPlace {
  const maxWidth = Math.max(0, i.area.right - i.area.left - 2 * MARGIN);
  const width = Math.min(i.width, maxWidth);
  const natural =
    i.align === 'start' ? i.anchor.left - OVERHANG : i.anchor.right + OVERHANG - width;
  const left = Math.max(i.area.left + MARGIN, Math.min(natural, i.area.right - MARGIN - width));
  const below = i.anchor.bottom + GAP;
  const top = Math.max(i.minTop, Math.min(below, i.area.bottom - MARGIN - i.height));
  const maxHeight = Math.max(0, i.area.bottom - MARGIN - top);
  return { left, top, maxWidth, maxHeight, scroll: i.height > maxHeight };
}

const boxOf = (r: DOMRect): Box => ({
  left: r.left,
  top: r.top,
  right: r.right,
  bottom: r.bottom,
});

/** Place the popover `el`, which opens from `at` and aligns with it at `align`, on `stage`. */
function placeOn(el: HTMLElement, at: HTMLElement, stage: HTMLElement | null, align: Align): void {
  const area = stage
    ? boxOf(stage.getBoundingClientRect())
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const anchorBox = boxOf(at.getBoundingClientRect());
  // a nested popover may move up, as far as the top of the outermost popover
  let root: HTMLElement | null = null;
  for (let up = at.parentElement?.closest<HTMLElement>('.stage-pop'); up;) {
    root = up;
    up = up.parentElement?.closest<HTMLElement>('.stage-pop');
  }
  const minTop = root ? root.getBoundingClientRect().top : anchorBox.bottom + GAP;
  const borders = el.offsetHeight - el.clientHeight;
  const p = placePop({
    area,
    anchor: anchorBox,
    width: el.offsetWidth,
    height: el.scrollHeight + borders,
    align,
    minTop,
  });
  // fixed coordinates count from the popover's containing block (the stage contains its layout,
  // so that is the stage): find its origin, then place
  const s = el.style;
  s.position = 'fixed';
  s.right = 'auto';
  s.bottom = 'auto';
  s.left = '0px';
  s.top = '0px';
  const origin = el.getBoundingClientRect();
  s.left = `${p.left - origin.left}px`;
  s.top = `${p.top - origin.top}px`;
  s.maxWidth = `${p.maxWidth}px`;
  s.maxHeight = `${p.maxHeight}px`;
  s.overflowY = p.scroll ? 'auto' : '';
  s.overflowX = p.scroll ? 'hidden' : '';
}

/**
 * Keeps an open popover (`pop`, opening from `anchor`) on the stage, as `placePop` says. It goes
 * `position: fixed`, so a popover nested in another one is never clipped when the outer one
 * scrolls; it is placed again when the stage or the popover changes size and when anything scrolls.
 */
export function usePopPlacement(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  pop: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const el = pop.current;
    const at = anchor.current;
    if (!open || !el || !at) return;
    const stage = at.closest<HTMLElement>('.stage');
    // the CSS says which edge lines up with the tool: read it once, before the popover moves
    const natural = el.getBoundingClientRect();
    const align = natural.left < at.getBoundingClientRect().left - 2 * OVERHANG ? 'end' : 'start';
    const place = () => {
      placeOn(el, at, stage, align);
    };
    place();
    // placed again on the next frame: placing it now, inside the observer, resizes what it observes
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const sizes = new ResizeObserver(later);
    sizes.observe(el);
    if (stage) sizes.observe(stage);
    window.addEventListener('resize', place);
    // an outer popover scrolled: its tool moved, so this popover follows
    const scrolled = (e: Event) => {
      if (e.target !== el) place();
    };
    window.addEventListener('scroll', scrolled, true);
    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [open, anchor, pop]);
}
