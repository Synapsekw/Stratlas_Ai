/**
 * Accessibility helpers for the e2e suite (M7 D6):
 *
 * - `expectAccessible(win, name)`: an axe-core audit of the whole window (WCAG 2.1 A and AA plus
 *   axe best practices) that fails with a readable list of violations. `AXE_ALLOW` is the short
 *   list of things that are not applicable, each with its reason.
 * - `expectFocusMeaningful(win, step)`: after a keyboard step, focus sits on a visible element
 *   in the page, never lost into <body> (a removed control, a closed popover).
 *
 * axe runs in legacy mode: Electron cannot open the extra page axe uses to merge frame results,
 * and the app has no cross-origin frames to merge (the original review iframe is excluded).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

/**
 * Not applicable, never "too hard to fix". Selectors are left out of the audit, rules are off.
 * Keep it short; every entry says why.
 */
export const AXE_ALLOW: { exclude?: string; rule?: string; why: string }[] = [
  {
    exclude: 'iframe.review-frame',
    why: 'The original review is a delivered third-party HTML viewer shown read-only, not app UI.',
  },
];

export interface AuditOptions {
  /** Audit only inside this selector (a dialog), e.g. to check a popover on its own. */
  include?: string;
}

/**
 * Let colour and layout transitions finish (a theme or contrast switch fades over a few frames;
 * on a software GPU frames are slow) so axe reads the colours that stay, not one in between.
 * Endless animations (a spinner, a live dot) are left running.
 */
async function settleTransitions(win: Page): Promise<void> {
  await win.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter(
        (a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity,
      );
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    // and one frame, so a transition that ended this frame is painted and styled
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/** Violations as one line each, with up to three offending nodes. */
export async function audit(win: Page, o: AuditOptions = {}): Promise<string[]> {
  await settleTransitions(win);
  let axe = new AxeBuilder({ page: win }).setLegacyMode(true).withTags(AXE_TAGS);
  if (o.include) axe = axe.include(o.include);
  for (const a of AXE_ALLOW) if (a.exclude) axe = axe.exclude(a.exclude);
  const off = AXE_ALLOW.flatMap((a) => (a.rule ? [a.rule] : []));
  if (off.length) axe = axe.disableRules(off);
  const result = await axe.analyze();
  return result.violations.map((v) => {
    const nodes = v.nodes
      .slice(0, 3)
      .map((n) => {
        const why = n.failureSummary?.split('\n').slice(1, 2).join(' ').trim() ?? '';
        return `${n.target.join(' ')}${why ? ` (${why})` : ''}`;
      })
      .join('; ');
    return `${v.id} [${v.impact ?? 'n/a'}] x${String(v.nodes.length)}: ${v.help}. ${nodes}`;
  });
}

/** Fail with every violation listed when the window (or `include`) is not accessible. */
export async function expectAccessible(win: Page, name: string, o: AuditOptions = {}) {
  const violations = await audit(win, o);
  // QUADRION_A11Y_REPORT=1 lists every screen's violations instead of stopping at the first
  if (process.env.QUADRION_A11Y_REPORT) {
    for (const v of violations) console.warn(`[a11y] ${name}: ${v}`);
    return;
  }
  expect(violations, `axe violations on ${name}`).toEqual([]);
}

export interface FocusInfo {
  tag: string;
  role: string | null;
  name: string;
  lost: boolean;
  visible: boolean;
}

/** What has focus now. */
export function focusInfo(win: Page): Promise<FocusInfo> {
  return win.evaluate(() => {
    const a = document.activeElement;
    const lost = a === null || a === document.body || a === document.documentElement;
    const el = a instanceof HTMLElement ? a : null;
    const r = el?.getBoundingClientRect();
    return {
      tag: a?.tagName.toLowerCase() ?? '',
      role: el?.getAttribute('role') ?? null,
      name: (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim().slice(0, 60),
      lost,
      // the sr-only screen heading counts: it is the deliberate fallback
      visible: !!el && el.isConnected && !!r && (r.width > 0 || el.matches('h1')),
    };
  });
}

/** After `step`, focus is on a visible element of the page, not on <body> or nowhere. */
export async function expectFocusMeaningful(win: Page, step: string): Promise<FocusInfo> {
  await expect
    .poll(
      async () => {
        const f = await focusInfo(win);
        return !f.lost && f.visible;
      },
      { message: `focus is lost after: ${step}`, timeout: 3000 },
    )
    .toBe(true);
  return focusInfo(win);
}
