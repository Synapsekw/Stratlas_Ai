/**
 * The data screens' areas are resizable so the data gets the room (founder, Media as the example):
 * in Media the library and the opened photo split by a handle the person drags, the size is kept
 * after a reload, a double-click puts it back and the arrow keys move it; the Issues card and the
 * agent column drag the same way, and the screen beside the column gives way.
 *
 * On the tank farm demo (`pnpm demo:build --quick`), opened as a working copy.
 */
import type { Locator, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_FOLDER, expect, test } from './fixtures';
import { openDemo } from './surveyJobs';

const TANK_FARM = { id: 'demo-tank-farm', name: 'Demo tank farm' };
test.skip(
  !existsSync(join(DEMO_FOLDER, TANK_FARM.id, 'manifest.json')),
  `no demos in ${DEMO_FOLDER}: run pnpm demo:build --quick`,
);
test.use({ appEnv: { QUADRION_DEMO: DEMO_FOLDER } });
test.setTimeout(120_000);

/** One arrow key press on a handle, in px (split/model.ts SPLIT_STEP). */
const STEP = 16;

async function goTo(win: Page, name: 'Issues' | 'Media') {
  await win.locator('.sb-nav .nav-item', { hasText: name }).first().click();
  await expect(win.locator(`.app[data-screen="${name.toLowerCase()}"]`)).toBeVisible();
}

const width = async (l: Locator) => (await l.boundingBox())?.width ?? -1;
const valueNow = async (l: Locator) => Number(await l.getAttribute('aria-valuenow'));

/** Drag a handle `dx` px sideways (negative: to the left), in small moves as a hand does. */
async function drag(win: Page, handle: Locator, dx: number) {
  const box = await handle.boundingBox();
  if (!box) throw new Error('the handle is not on the screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + dx, y, { steps: 10 });
  await win.mouse.up();
}

/** Where a pane sized at the end lands after growing by `grow`: within its max and the other's min. */
function grown(from: number, grow: number, container: number, max: number, otherMin: number) {
  return Math.min(from + grow, max, container - otherMin);
}

async function openPhoto(win: Page) {
  await goTo(win, 'Media');
  await win.locator('.media-main .m-card.sq[data-photo]').first().click();
  await expect(win.locator('.media.with-viewer .media-viewer')).toBeVisible();
}

test('the Media viewer is dragged wider, kept after a reload, reset and moved by keys', async ({
  win,
}) => {
  await openDemo(win, TANK_FARM.name, TANK_FARM.id);
  await goTo(win, 'Media');
  const handle = win.getByRole('separator', { name: 'Resize the library' });
  // no photo open: the library alone, no handle
  await expect(win.locator('.media-main .m-card.sq[data-photo]').first()).toBeVisible();
  await expect(handle).toHaveCount(0);

  await openPhoto(win);
  const viewer = win.locator('.media-viewer');
  const split = win.locator('.media-split');
  const room = await width(split);
  const before = await width(viewer);
  // at rest the viewer has 54% of the screen
  expect(Math.abs(before - room * 0.54)).toBeLessThanOrEqual(2);

  // 200 px toward the gallery: the viewer grows (up to 80%, the gallery keeps 200 px)
  await drag(win, handle, -200);
  const expected = grown(before, 200, room, room * 0.8, 200);
  await expect.poll(() => width(viewer)).toBeGreaterThan(before + 100);
  const after = await width(viewer);
  expect(Math.abs(after - expected)).toBeLessThanOrEqual(2);
  expect(Math.abs((await valueNow(handle)) - after)).toBeLessThanOrEqual(1);

  // a reload keeps the size
  await win.reload();
  await openDemo(win, TANK_FARM.name, TANK_FARM.id);
  await openPhoto(win);
  await expect.poll(async () => Math.abs((await width(viewer)) - after)).toBeLessThanOrEqual(2);

  // a double-click puts the default back
  await handle.dblclick();
  await expect
    .poll(async () => Math.abs((await width(viewer)) - (await width(split)) * 0.54))
    .toBeLessThanOrEqual(2);

  // three arrow presses to the left: the viewer grows by three steps
  const start = await valueNow(handle);
  await handle.focus();
  for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowLeft');
  await expect.poll(() => valueNow(handle)).toBe(start + 3 * STEP);
});

test('the Issues card and the agent column are dragged wider', async ({ win }) => {
  await openDemo(win, TANK_FARM.name, TANK_FARM.id);
  await goTo(win, 'Issues');

  // the card: 420 px, dragged 60 px wider
  const card = win.locator('.iss-side');
  const cardHandle = win.getByRole('separator', { name: 'Resize the issue list' });
  await expect(cardHandle).toBeVisible();
  const room = await width(win.locator('.iss-split'));
  const cardBefore = await width(card);
  expect(Math.abs(cardBefore - 420)).toBeLessThanOrEqual(1);
  await drag(win, cardHandle, -60);
  const cardExpected = grown(cardBefore, 60, room, room * 0.6, 280);
  await expect
    .poll(async () => Math.abs((await width(card)) - cardExpected))
    .toBeLessThanOrEqual(2);

  // the agent column: open, today's width, dragged 40 px wider; the screen gives it the room
  await win.getByTestId('agent-toggle').click();
  const dock = win.locator('#agent-dock');
  await expect(dock).toBeVisible();
  const dockHandle = dock.getByRole('separator', { name: 'Resize the assistant' });
  await expect(dockHandle).toBeVisible();
  const main = await width(win.locator('.main'));
  const dockBefore = await width(dock);
  const innerWidth = await win.evaluate(() => window.innerWidth);
  expect(Math.abs(dockBefore - Math.min(360, Math.round(innerWidth * 0.33)))).toBeLessThanOrEqual(
    1,
  );
  await drag(win, dockHandle, -40);
  const dockExpected = grown(dockBefore, 40, main, main * 0.5, 280);
  await expect
    .poll(async () => Math.abs((await width(dock)) - dockExpected))
    .toBeLessThanOrEqual(2);
  const edges = await win.evaluate(() => ({
    screen: document.querySelector('.main > .screen')?.getBoundingClientRect().right ?? 0,
    dock: document.querySelector('#agent-dock')?.getBoundingClientRect().left ?? 0,
  }));
  expect(edges.screen).toBeLessThanOrEqual(edges.dock + 0.5);
});
