/**
 * Split view helpers for the e2e specs: where the pane headers (D31) go wrong.
 */
import type { Page } from '@playwright/test';

/** What a pane header must keep clear of: the island and what hangs beside it, the corners, the
 * floating video, the compare tools, the right panel's toggle and the split's divider. */
const HEADER_CLEAR_OF =
  '.island, .isl-aside > *, .compare-view, .stage-slot > *, .vwin:not(.docked), .stage-rp, .split-handle';

/**
 * Where each pane's header strip is wrong (D31): missing, outside its pane, or under one of
 * HEADER_CLEAR_OF. Empty when all is well.
 */
export function headerProblems(win: Page): Promise<string[]> {
  return win.evaluate((clearOf) => {
    const out: string[] = [];
    const rect = (el: Element) => el.getBoundingClientRect();
    const meets = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const others = [...document.querySelectorAll(clearOf)].filter(
      (e) => rect(e).width > 0 && getComputedStyle(e).visibility !== 'hidden',
    );
    for (const side of ['left', 'right']) {
      const head = document.querySelector(`[data-testid="pane-chooser-${side}"]`);
      const pane = head?.closest('[data-side]');
      if (!head || !pane) {
        out.push(`no ${side} header`);
        continue;
      }
      const p = rect(pane);
      for (const part of head.children) {
        const r = rect(part);
        if (r.left < p.left - 0.5 || r.right > p.right + 0.5)
          out.push(`the ${side} header leaves its pane`);
        for (const o of others)
          if (meets(r, rect(o))) out.push(`the ${side} header is under ${o.className}`);
      }
    }
    return out;
  }, HEADER_CLEAR_OF);
}
