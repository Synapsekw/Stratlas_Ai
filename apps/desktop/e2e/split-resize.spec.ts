/**
 * The data screens' areas are resizable so the data gets the room (founder): the Issues card and
 * the agent column drag wider, and the screen beside the column gives way. Inspect has no
 * draggable split: its opened photo keeps its width while the photo column scrolls and after a
 * reload (the old Media handle, its double-click reset and arrow keys no longer exist by design).
 *
 * On the tank farm demo (`pnpm demo:build --quick`), opened as a working copy.
 */
import type { Locator, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_FOLDER, expect, test } from './fixtures';
import { photoTiles } from './inspect';
import { openDemo } from './surveyJobs';

const TANK_FARM = { id: 'demo-tank-farm', name: 'Demo tank farm' };
test.skip(
  !existsSync(join(DEMO_FOLDER, TANK_FARM.id, 'manifest.json')),
  `no demos in ${DEMO_FOLDER}: run pnpm demo:build --quick`,
);
test.use({ appEnv: { QUADRION_DEMO: DEMO_FOLDER } });
test.setTimeout(120_000);

async function goTo(win: Page, name: 'Issues' | 'Inspect') {
  await win.locator('.sb-nav .nav-item', { hasText: name }).first().click();
  await expect(win.locator(`.app[data-screen="${name.toLowerCase()}"]`)).toBeVisible();
}

const width = async (l: Locator) => (await l.boundingBox())?.width ?? -1;

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
  await goTo(win, 'Inspect');
  await photoTiles(win).first().click();
  await expect(inspectViewer(win)).toBeVisible();
}

const inspectViewer = (win: Page) =>
  win.locator('[aria-label="Inspect"] [data-testid="photo-viewer"]').first();

test('the Inspect viewer keeps its width when the photo column scrolls and after a reload', async ({
  win,
}) => {
  await openDemo(win, TANK_FARM.name, TANK_FARM.id);
  await goTo(win, 'Inspect');
  // Inspect has no draggable split (the column widths are fixed by the layout): no handle at all
  await expect(photoTiles(win).first()).toBeVisible();
  await expect(win.getByRole('separator', { name: 'Resize the library' })).toHaveCount(0);

  await openPhoto(win);
  const viewer = inspectViewer(win);
  const before = await width(viewer);
  expect(before).toBeGreaterThan(300);

  // the photo column scrolls to its end: the viewer neither moves nor changes size
  const list = win.getByTestId('inspect-photos').locator('.insp-photos-list');
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => width(viewer)).toBeCloseTo(before, 0);
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => width(viewer)).toBeCloseTo(before, 0);

  // a reload gives the same width back
  await win.reload();
  await openDemo(win, TANK_FARM.name, TANK_FARM.id);
  await openPhoto(win);
  await expect
    .poll(async () => Math.abs((await width(inspectViewer(win))) - before))
    .toBeLessThanOrEqual(2);
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

  // the agent column: open, today's width, dragged 40 px wider (the screen keeps 448 px); the
  // screen gives it the room
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
  const dockExpected = grown(dockBefore, 40, main, main * 0.5, 448);
  await expect
    .poll(async () => Math.abs((await width(dock)) - dockExpected))
    .toBeLessThanOrEqual(2);
  const edges = await win.evaluate(() => ({
    screen: document.querySelector('.main > .screen')?.getBoundingClientRect().right ?? 0,
    dock: document.querySelector('#agent-dock')?.getBoundingClientRect().left ?? 0,
  }));
  expect(edges.screen).toBeLessThanOrEqual(edges.dock + 0.5);
});
