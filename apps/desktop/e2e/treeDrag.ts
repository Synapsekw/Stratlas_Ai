/**
 * Dragging a sidebar row onto a drop place (a date folder, a measurement folder, a group header)
 * the way a person does: press, move in small steps, let go over the place. Every spec that drags
 * in the dataset tree goes through here, so a change to the sidebar's height cannot send one of
 * them back to Playwright's one-jump `dragTo`.
 *
 * Why not `dragTo`: in CI's short window (1100 x 720, and 1100 x 700 in the smallest window tests)
 * the sidebar list is only about 200 px high. `dragTo` scrolls the target into view after the
 * press, which slides the pressed row from under the pointer, and its single jump onto a target
 * near the list's edge lets Chromium scroll the list under the held drag before the drop, so the
 * drop lands on whatever slid under the pointer (a row of another folder, or nothing).
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** Scroll the list so `first` and `second` sit in view together, centred as a pair. */
export async function showTogether(first: Locator, second: Locator): Promise<void> {
  const secondEl = await second.elementHandle();
  await first.evaluate((a, b) => {
    let list: HTMLElement | null = a.parentElement;
    while (list && !/(auto|scroll)/.test(getComputedStyle(list).overflowY))
      list = list.parentElement;
    if (!list) return;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const mid = (Math.min(ra.top, rb.top) + Math.max(ra.bottom, rb.bottom)) / 2;
    const box = list.getBoundingClientRect();
    list.scrollTop += mid - (box.top + box.height / 2);
  }, secondEl);
}

/** Whether the element is wholly in view (its scrolling list and the window both). */
async function wholly(l: Locator): Promise<boolean> {
  try {
    await expect(l).toBeInViewport({ ratio: 1, timeout: 100 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a press at the element's centre reaches it. A note pinned to the top of the list (what
 * a move did, with its Undo) or the "Drop for no date" place pinned to its foot during a drag can
 * lie over a row that is in view.
 */
const reachable = (l: Locator) =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit !== null && el.contains(hit);
  });

/** Wholly in view and not under anything pinned to the list. */
const clear = async (l: Locator) => (await wholly(l)) && (await reachable(l));

/** Scroll the element's list to bring it to the list's middle, clear of what is pinned. */
const centre = (l: Locator) =>
  l.evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
  });

/** Resolve after `ms` in the page, for Chromium's drag scrolling to show (or not) between reads. */
const settle = (win: Page, ms: number) =>
  win.evaluate((t) => new Promise<void>((done) => setTimeout(done, t)), ms);

/**
 * Drag `row` onto `target` with stepped pointer moves. Both are brought into view together when
 * they fit; a target that does not fit with the row is reached by holding the drag at the list's
 * edge, which Chromium scrolls under a held drag. The press and the drop each go where nothing
 * pinned lies over the row or the target, and before letting go the pointer is moved onto the
 * target again until the target has stopped moving (a drag near the list's edge scrolls it), so
 * the drop is on the target and nothing else.
 */
export async function dragOnto(win: Page, row: Locator, target: Locator): Promise<void> {
  await showTogether(row, target);
  if (!(await clear(row))) await centre(row);
  await expect(row).toBeInViewport({ ratio: 1 });
  expect(await reachable(row), 'the row to drag is not under a pinned note').toBe(true);

  const box = await row.boundingBox();
  const list = await win.locator('.sb-scroll').boundingBox();
  const at = await target.boundingBox();
  if (!box || !list || !at) throw new Error('the row, its target or the sidebar list is not drawn');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  // far enough for the drag to start, without leaving the row
  await win.mouse.move(x + 16, y + 4, { steps: 4 });

  if (!(await wholly(target))) {
    // hold the drag just inside the list's edge on the target's side until the list has
    // scrolled the target into view; small moves keep the drag "over" the edge, as a hand does
    const above = at.y < box.y;
    const edge = { x: list.x + list.width / 2, y: above ? list.y + 6 : list.y + list.height - 6 };
    await win.mouse.move(edge.x, edge.y, { steps: 5 });
    let nudge = 0;
    await expect(async () => {
      nudge = 1 - nudge;
      await win.mouse.move(edge.x + nudge, edge.y);
      await expect(target).toBeInViewport({ ratio: 1, timeout: 100 });
    }).toPass({ timeout: 15_000 });
  }

  // onto the target in steps, again until it holds still under the pointer, clear of anything
  // pinned (the list may be scrolled during a drag: the next move over it carries on)
  await expect(async () => {
    if (!(await clear(target))) await centre(target);
    const a = await target.boundingBox();
    if (!a) throw new Error('the drop target is not drawn');
    await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2, { steps: 5 });
    await settle(win, 150);
    const b = await target.boundingBox();
    expect(b, 'the drop target held still under the pointer').toEqual(a);
    expect(await clear(target), 'the drop target is in view and not under a pinned place').toBe(
      true,
    );
  }).toPass({ timeout: 15_000 });
  await win.mouse.up();
}
