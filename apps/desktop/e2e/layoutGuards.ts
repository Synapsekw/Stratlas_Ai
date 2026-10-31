/**
 * Layout guards (UI revision W1d): what goes wrong only when the window is small. Each check
 * reads boxes, never pixels (WARP renders differ), and returns a list of what is wrong, empty
 * when all is well, so a failure names the element.
 */
import type { Page } from '@playwright/test';
import { expect } from './fixtures';

/**
 * Every shown element matched by `selectors` whose text is cut: wider inside than its box
 * (`scrollWidth > clientWidth + 1`). Each entry names the selector and the element's text.
 */
export function clippedText(page: Page, selectors: readonly string[]): Promise<string[]> {
  return page.evaluate((sels) => {
    const out: string[] = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (el.getClientRects().length === 0) continue;
        if (getComputedStyle(el).visibility === 'hidden') continue;
        if (el.scrollWidth > el.clientWidth + 1) {
          const text = (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 60);
          out.push(`${sel}: "${text}" (${String(el.scrollWidth)} > ${String(el.clientWidth)})`);
        }
      }
    }
    return out;
  }, selectors);
}

/** Expect no text under `selectors` to be cut (clippedText), retried while the layout settles. */
export async function expectNoClippedText(
  page: Page,
  selectors: readonly string[],
  what = 'cut text',
): Promise<void> {
  await expect.poll(() => clippedText(page, selectors), { message: what }).toEqual([]);
}

/**
 * Where the island leaves the stage, or is cut at rest: the capsule and what hangs beside it
 * (the bubble, a comparison's controls) must lie inside the stage, and each button of the resting
 * line inside the capsule, the line itself not wider than its room. Empty when all is well.
 */
export function islandProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const stage = document.querySelector('.ws > .stage')?.getBoundingClientRect();
    const capsule = document.querySelector('.island')?.getBoundingClientRect();
    if (!stage) return ['no stage'];
    if (!capsule) return ['no island'];
    const inside = (r: DOMRect, box: DOMRect) =>
      r.left >= box.left - 0.5 &&
      r.right <= box.right + 0.5 &&
      r.top >= box.top - 0.5 &&
      r.bottom <= box.bottom + 0.5;
    if (!inside(capsule, stage)) out.push('the island leaves the stage');
    for (const part of document.querySelectorAll('.isl-aside > *')) {
      const r = part.getBoundingClientRect();
      if (r.width === 0) continue;
      const name = part.getAttribute('aria-label') ?? part.className;
      if (!inside(r, stage)) out.push(`${name} beside the island leaves the stage`);
      if (r.left < capsule.right - 0.5 && capsule.left < r.right - 0.5)
        out.push(`${name} beside the island covers it`);
    }
    if (document.querySelector('.island-wrap')?.getAttribute('data-state') === 'rest') {
      for (const b of document.querySelectorAll('.isl-layer > .isl-line button')) {
        if (b.getClientRects().length === 0) continue;
        const r = b.getBoundingClientRect();
        const name = b.getAttribute('aria-label') ?? b.textContent.trim();
        if (r.width === 0 || r.left < capsule.left - 0.5 || r.right > capsule.right + 0.5)
          out.push(`the resting island cuts ${name}`);
      }
      const line = document.querySelector<HTMLElement>('.isl-layer > .isl-line');
      if (line && line.scrollWidth > line.clientWidth + 1) out.push('the resting line is cut');
    }
    return out;
  });
}

/**
 * Pairs of shown elements under `selectors` that overlap (one inside the other aside), named by
 * their selectors. Empty when everything keeps apart.
 */
export function overlaps(page: Page, selectors: readonly string[]): Promise<string[]> {
  return page.evaluate((sels) => {
    const found: [string, Element, DOMRect][] = [];
    for (const sel of sels)
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || getComputedStyle(el).visibility === 'hidden') continue;
        found.push([sel, el, r]);
      }
    const out: string[] = [];
    for (const [i, [sa, a, ra]] of found.entries())
      for (const [sb, b, rb] of found.slice(i + 1)) {
        if (a === b || a.contains(b) || b.contains(a)) continue;
        if (
          ra.left < rb.right - 0.5 &&
          rb.left < ra.right - 0.5 &&
          ra.top < rb.bottom - 0.5 &&
          rb.top < ra.bottom - 0.5
        )
          out.push(`${sa} and ${sb} overlap`);
      }
    return out;
  }, selectors);
}

/** Shown elements under `selectors` whose content runs out of their box downward. */
export function spillsDown(page: Page, selectors: readonly string[]): Promise<string[]> {
  return page.evaluate((sels) => {
    const out: string[] = [];
    for (const sel of sels)
      for (const el of document.querySelectorAll<HTMLElement>(sel))
        if (el.getClientRects().length > 0 && el.scrollHeight > el.clientHeight + 1)
          out.push(`${sel}: "${el.textContent.trim().slice(0, 40)}" runs out of its box`);
    return out;
  }, selectors);
}
