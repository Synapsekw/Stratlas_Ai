/**
 * The workbench drawer (stage-island D20) and the dark backing behind the window's buttons (D28)
 * in the real app: with the right sidebar hidden, a live tool slides the front bench in over the
 * stage without an agent, Esc slides it out, a click on the island opens it with focus trapped and
 * Esc gives focus back to the island. Folded, the buttons sit on a dark strip; right to left, with
 * the left sidebar a rail, the same strip covers what the buttons reach past it (I-R23).
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
    await expect(drawer(win).locator('.wb-section').first()).toBeVisible();
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
    // woken by the pointer first, as a person's click on it is
    await win.locator('.island').hover({ position: { x: 4, y: 4 } });
    await expect(island(win)).toHaveAttribute('data-state', 'ready');
    await win.locator('.island').click({ position: { x: 4, y: 4 } });
    await expect(drawer(win)).toHaveAttribute('data-open', '');
    // one gesture, one surface: the island's tools stay shut behind the drawer (I-R64)
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

test.describe('the backing behind the window buttons', () => {
  test('the right panel folded: a dark strip under the buttons, none while it shows', async ({
    twoDateProject,
    win,
  }, info) => {
    await openCard(win, 'E2E two dates', twoDateProject.id);
    const backing = win.getByTestId('caption-backing');
    await expect(backing).toBeHidden();
    await foldRight(win);
    const area = await captionArea(win);
    if (area.kept.right === 0) {
      // no window buttons drawn over the page on this platform: nothing to back
      await expect(backing).toBeHidden();
      return;
    }
    await expect(backing).toBeVisible();
    const box = await backing.boundingBox();
    const size = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box).not.toBeNull();
    if (box) {
      expect(box.y).toBe(0);
      expect(Math.abs(box.x + box.width - size.width)).toBeLessThanOrEqual(1);
      expect(box.width).toBeGreaterThanOrEqual(area.kept.right - 1);
      expect(box.height).toBeGreaterThanOrEqual(area.height - 1);
    }
    await shot(win, info, 'caption-backing-folded.png');
  });
});

test.describe('right to left', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720' } });

  test('with the left sidebar a rail, the backing covers what the buttons reach past it', async ({
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

    const state = () =>
      win.evaluate(() => {
        const width = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().width;
        return {
          side: width('#app-sidebar') ?? 0,
          back: width('[data-testid="caption-backing"]') ?? 0,
        };
      });
    // expanded: the buttons lie wholly over the sidebar's logo row, nothing of the main area
    await expect.poll(async () => (await state()).back).toBe(0);
    await win.getByTestId('panel-handle-left').click();
    await expect(win.locator('.app')).toHaveAttribute('data-sb', 'collapsed');
    await expect
      .poll(async () => {
        const s = await state();
        return Math.abs(s.back - (area.kept.right - s.side));
      })
      .toBeLessThanOrEqual(2);
    expect((await state()).back, 'about 86 px past the rail').toBeGreaterThan(40);
    await shot(win, info, 'caption-backing-rtl-rail.png');
  });
});
