/**
 * A section brought forward (a tool started, an ask from the island or the palette) is scrolled
 * into the tab's one scroll box, as a tab of its own was in view the moment it came forward. Only
 * the scroll box moves, never the panel or the page; a section already in view (its header in the
 * box's upper half, or all of it showing) stays where it is.
 */

/** The vertical edges of a box on screen. */
export interface Span {
  top: number;
  bottom: number;
}

/** Room below the section's header that shows it opened, not just its title. */
const BODY_ROOM = 80;

/**
 * The scroll box's new `scrollTop` that brings a section's top to the box's top, or null when the
 * section is in view already: its header inside the box and some of its body showing under it.
 */
export function revealScrollTop(box: Span, section: Span, scrollTop: number): number | null {
  const height = box.bottom - box.top;
  const headerIn = section.top >= box.top - 1 && section.top <= box.bottom - BODY_ROOM;
  const fits = section.bottom <= box.bottom + 1;
  if (headerIn && (fits || section.top <= box.top + height / 2)) return null;
  return Math.max(0, Math.round(scrollTop + section.top - box.top));
}

/** Scroll the section's scroll box (`.wb-panel-scroll`) so the section shows. */
export function revealSection(el: HTMLElement | null): void {
  const box = el?.closest<HTMLElement>('.wb-panel-scroll');
  if (!el || !box) return;
  const next = revealScrollTop(
    box.getBoundingClientRect(),
    el.getBoundingClientRect(),
    box.scrollTop,
  );
  if (next !== null) box.scrollTop = next;
}
