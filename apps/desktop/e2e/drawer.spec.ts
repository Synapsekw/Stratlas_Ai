/**
 * The workbench drawer (stage-island D20) and the dark backing behind the window's buttons (D28)
 * in the real app: with the right sidebar hidden, a live tool slides the front bench in over the
 * stage without an agent, Esc slides it out, a click on the island opens it with focus trapped and
 * Esc gives focus back to the island. The window's buttons sit over the title bar (UI revision
 * W11): folded or not, and right to left, nothing of the stage lies under them and no backing is
 * needed (D28 and I-R23 before the title bar).
 *
 * Screenshots go to the test's output folder (test-results/), or to QUADRION_E2E_SHOTS.
 */
import type { Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { captionArea } from './caption';
import { expect, openProject, test } from './fixtures';
import { island } from './island';

const VIEW_READY = { timeout: 30_000 };

async function openCard(win: Page, name: string, id: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible(VIEW_READY);
  await expect.poll(async () => (await openProject(win)).id, VIEW_READY).toBe(id);
}

async function shot(win: Page, info: TestInfo, name: string): Promise<void> {
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (dir) await mkdir(dir, { recursive: true });
  await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
}

/** Fold the right sidebar away with the stage's own toggle, and wait for the strip. */
async function foldRight(win: Page): Promise<void> {
  await win.locator('.stage-rp button').click();
  await expect(win.locator('.ws')).toHaveClass(/right-off/);
  await expect
    .poll(() => win.locator('.ws > .right').evaluate((el) => el.getBoundingClientRect().width))
    .toBeLessThan(20);
}

const drawer = (win: Page) => win.getByTestId('wb-drawer');

/** The drawer has finished sliding in: its end edge is the window's edge. */
const drawerIn = (win: Page) =>
  expect
    .poll(() =>
      drawer(win).evaluate((el) => Math.abs(el.getBoundingClientRect().right - innerWidth)),
    )
    .toBeLessThanOrEqual(1);

test.describe('the drawer', () => {
  test('a live tool slides the bench in without an agent; Esc slides it out', async ({
    twoDateProject,
    win,
  }, info) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    await foldRight(win);
    await expect(drawer(win)).toHaveCount(0);

    await win.locator('[data-scene-view] canvas').first().focus();
    await win.keyboard.press('m');
    await expect(drawer(win).getByTestId('survey-drawbar')).toBeVisible();
    // one live copy of each bench: the folded sidebar renders none while the drawer shows (I-R38)
    await expect(win.getByTestId('survey-drawbar')).toHaveCount(1);
    await expect(drawer(win)).toHaveAttribute('data-open', '');
    await expect(drawer(win)).toHaveAttribute('data-front', 'measure');
    // the bench itself is shown: the live card on top, the Saved footer under it
    await expect(drawer(win).getByTestId('survey-saved')).toBeVisible();
    await expect(drawer(win).locator('.agent')).toHaveCount(0);
    // it covers the stage's end edge only, and the sidebar stays folded
    await expect(win.locator('.ws')).toHaveClass(/right-off/);
    await drawerIn(win);
    // the island centres on the stage the drawer leaves, so it is not cut (I-R42)
    await expect
      .poll(async () => {
        const i = await island(win).boundingBox();
        const d = await drawer(win).boundingBox();
        return i && d ? Math.round(d.x - (i.x + i.width)) : null;
      })
      .toBeGreaterThanOrEqual(0);
    await shot(win, info, 'drawer-live.png');

    await win.keyboard.press('Escape');
    await expect(drawer(win)).toHaveCount(0);
  });

  test('a click on the island opens it with focus inside; Esc returns focus to the island', async ({
    twoDateProject,
    win,
  }, info) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    await foldRight(win);
    await expect(island(win)).not.toHaveAttribute('data-state', /tools|date/);
    // a click on the notch at rest
    await win.locator('.island').click({ position: { x: 4, y: 4 } });
    await expect(drawer(win)).toHaveAttribute('data-open', '');
    // one gesture, one surface: the island's tools stay shut behind the drawer (I-R64), and a
    // pointer resting on the notch does not open them over it either (D20)
    await expect(island(win)).not.toHaveAttribute('data-state', /tools|date/);
    await win.mouse.move(1, 1);
    await win.locator('.island').hover({ position: { x: 6, y: 6 } });
    await win.waitForTimeout(400);
    await expect(island(win)).not.toHaveAttribute('data-state', /tools|date/);
    await expect
      .poll(() =>
        win.evaluate(() => !!document.activeElement?.closest('[data-testid="wb-drawer"]')),
      )
      .toBe(true);
    await drawerIn(win);
    await shot(win, info, 'drawer-click.png');
    // one Esc closes it and gives the focus back to an island with nothing open
    await win.keyboard.press('Escape');
    await expect(drawer(win)).toHaveCount(0);
    await expect(island(win)).toBeFocused();
    await expect(island(win)).not.toHaveAttribute('data-state', /tools|date/);
  });
});

test.describe('the window buttons over the title bar', () => {
  test('the right panel folded: the buttons sit on the title bar, the stage below it', async ({
    twoDateProject,
    win,
  }, info) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    await foldRight(win);
    const area = await captionArea(win);
    const boxes = await win.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
      const bar = box('.titlebar');
      const stage = box('.stage');
      return {
        width: innerWidth,
        bar: bar ? { top: bar.top, right: bar.right, bottom: bar.bottom } : null,
        stageTop: stage?.top ?? -1,
      };
    });
    expect(boxes.bar).not.toBeNull();
    expect(boxes.bar?.top).toBe(0);
    expect(Math.abs((boxes.bar?.right ?? 0) - boxes.width)).toBeLessThanOrEqual(1);
    expect(boxes.bar?.bottom ?? 0).toBeGreaterThanOrEqual(area.height - 1);
    expect(boxes.stageTop).toBeGreaterThanOrEqual((boxes.bar?.bottom ?? 0) - 0.5);
    // nothing to back: the old strip stays away
    await expect(win.getByTestId('caption-backing')).toBeHidden();
    await shot(win, info, 'caption-titlebar-folded.png');
  });
});

test.describe('right to left', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720' } });

  test('with Layers folded, the title bar keeps clear of what the buttons reach past the rail', async ({
    twoDateProject,
    win,
  }, info) => {
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: 'Appearance' }).click();
    await win.getByRole('button', { name: 'Right to left' }).click();
    await expect(win.locator('html')).toHaveAttribute('dir', 'rtl');
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
    await openCard(win, 'E2E two dates', twoDateProject.id);
    const area = await captionArea(win);
    test.skip(area.kept.right === 0, 'no window buttons are drawn over the page here');
    if ((await win.locator('.app').getAttribute('data-sb')) !== 'collapsed')
      await win.getByTestId('panel-handle-left').click();
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
    // the buttons are at the window's physical right, the bar's start right to left: every
    // control of the bar ends before them
    const room = (await win.evaluate(() => innerWidth)) - area.kept.right;
    await expect
      .poll(() =>
        win.evaluate(() =>
          Math.max(
            ...[...document.querySelectorAll('.titlebar > *, .titlebar .sb-status-row > *')]
              .map((el) => el.getBoundingClientRect())
              .filter((r) => r.width > 0)
              .map((r) => r.right),
          ),
        ),
      )
      .toBeLessThanOrEqual(room + 0.5);
    await expect(win.getByTestId('caption-backing')).toBeHidden();
    await shot(win, info, 'caption-titlebar-rtl.png');
  });
});
