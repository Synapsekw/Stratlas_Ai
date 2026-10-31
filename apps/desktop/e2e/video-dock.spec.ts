/**
 * The video docked as a tile in the bottom strip and its pop-out window (UI revision W9, D4), in
 * the window CI runs, on the tank farm demo (a clip and two survey dates): the project opens with
 * the tile at the strip's start and nothing over the stage; Pop out floats the clip over the
 * stage, top left under the island, where it moves and resizes; Pop in returns it to the tile;
 * Close leaves a Show button in the strip. At 1100 x 700 the window never covers the island.
 *
 * Screenshots go to the test's output folder (test-results/), or to QUADRION_E2E_SHOTS.
 */
import type { Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEMO_FOLDER, expect, test } from './fixtures';
import { island, islandSettled, openIslandTools } from './island';
import { openDemo } from './surveyJobs';

const VIEW_READY = { timeout: 30_000 };

async function shot(win: Page, info: TestInfo, name: string): Promise<void> {
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (dir) await mkdir(dir, { recursive: true });
  await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(win: Page, testId: string): Promise<Box> {
  const b = await win.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`no ${testId}`);
  return b;
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function openTankFarm(win: Page): Promise<void> {
  await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
  await expect(win.getByTestId('video-tile')).toBeVisible(VIEW_READY);
}

/** Pop the tile out; on the software renderer a click can land while the strip still settles. */
async function popOut(win: Page): Promise<void> {
  const window = win.getByTestId('video-window');
  await expect(async () => {
    if (!(await window.isVisible()))
      await win.getByTestId('video-popout').click({ timeout: 2_000 });
    await expect(window).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/** Drag from the middle of a box by a delta. */
async function drag(win: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await win.mouse.up();
}

test.describe('the CI window', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_DEMO: DEMO_FOLDER } });

  test('the tank farm opens with the tile docked in the bottom strip and nothing over the stage', async ({
    win,
  }, info) => {
    await openTankFarm(win);
    await expect(win.getByTestId('video-window')).toHaveCount(0);
    const strip = await boxOf(win, 'bottom-strip');
    const tile = await boxOf(win, 'video-tile');
    const stage = win.locator('.ws > .stage');
    const s = await stage.boundingBox();
    if (!s) throw new Error('no stage');
    // the tile sits at the strip's start, inside it, 16:9, under the stage
    expect(tile.x).toBeGreaterThanOrEqual(strip.x);
    expect(tile.x - strip.x).toBeLessThanOrEqual(8);
    expect(tile.y + tile.height).toBeLessThanOrEqual(strip.y + strip.height + 1);
    expect(tile.width / tile.height).toBeCloseTo(16 / 9, 1);
    expect(tile.y).toBeGreaterThanOrEqual(s.y + s.height - 1);
    // the dates strip or the footage bar stands beside it, not under it
    const bar = await win.locator('.ws-strip > .tl-wrap').boundingBox();
    if (!bar) throw new Error('no bar');
    expect(bar.x).toBeGreaterThanOrEqual(tile.x + tile.width - 1);
    // the stage centre reaches the 3D view
    const hit = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x ?? 0, y ?? 0);
        return el?.tagName === 'CANVAS' && el.closest('[data-scene-view]') !== null;
      },
      [s.x + s.width / 2, s.y + s.height / 2],
    );
    expect(hit).toBe(true);
    await shot(win, info, 'video-dock-tile-1100.png');
  });

  test('pop out, drag, resize, pop in, and the window keeps its place', async ({ win }, info) => {
    await openTankFarm(win);
    // the right panel folded: the stage has room to move and grow the window in
    await win.locator('.stage-rp button').click();
    await expect(win.locator('.ws')).toHaveClass(/right-off/);
    await popOut(win);
    await expect(win.getByTestId('video-tile')).toHaveCount(0);
    const s = await win.locator('.ws > .stage').boundingBox();
    if (!s) throw new Error('no stage');
    const start = await boxOf(win, 'video-window');
    // first placed top left, under the island, at least 320 x 180 for the frame
    expect(start.x - s.x).toBeCloseTo(12, 0);
    expect(start.y - s.y).toBeGreaterThanOrEqual(111);
    const bar = await island(win).boundingBox();
    if (bar) expect(overlap(start, bar)).toBe(false);
    // the smallest window: a 320 px wide frame (less its 1 px borders)
    expect(start.width).toBeGreaterThanOrEqual(319);
    const frame0 = await win.locator('.vwin .vframe').boundingBox();
    expect(frame0?.height ?? 0).toBeGreaterThanOrEqual(177);
    await shot(win, info, 'video-dock-float-1100.png');

    // drag the title bar
    const head = await boxOf(win, 'video-header');
    await drag(win, { x: head.x + 40, y: head.y + head.height / 2 }, 60, 40);
    const moved = await boxOf(win, 'video-window');
    expect(moved.x - start.x).toBeCloseTo(60, -1);
    expect(moved.y - start.y).toBeCloseTo(40, -1);

    // resize from the bottom-right corner: wider, the frame keeps 16:9, never past 80 % of the stage
    const se = await win.locator('.vwin-rs.rs-se').boundingBox();
    if (!se) throw new Error('no resize corner');
    await drag(win, { x: se.x + se.width / 2, y: se.y + se.height / 2 }, 60, 0);
    const bigger = await boxOf(win, 'video-window');
    expect(bigger.width).toBeGreaterThan(moved.width + 30);
    expect(bigger.width).toBeLessThanOrEqual(s.width * 0.8 + 1);
    expect(bigger.height).toBeLessThanOrEqual(s.height * 0.8 + 1);
    const frame = await win.locator('.vwin .vframe').boundingBox();
    if (!frame) throw new Error('no frame');
    expect(frame.width / frame.height).toBeCloseTo(16 / 9, 1);

    // pop in: the tile is back, the stage clear
    await win.getByTestId('video-popin').click();
    await expect(win.getByTestId('video-window')).toHaveCount(0);
    await expect(win.getByTestId('video-tile')).toBeVisible();

    // out again: where it was left
    await popOut(win);
    const again = await boxOf(win, 'video-window');
    expect(again.x).toBeCloseTo(bigger.x, 0);
    expect(again.width).toBeCloseTo(bigger.width, 0);

    // close: a Show button waits in the strip and brings the tile back
    await win.getByTestId('video-window').getByRole('button', { name: 'Close the video' }).click();
    await expect(win.getByTestId('video-window')).toHaveCount(0);
    await expect(win.getByTestId('video-tile')).toHaveCount(0);
    await win.getByTestId('video-show').click();
    await expect(win.getByTestId('video-tile')).toBeVisible();
  });
});

test.describe('the smallest window', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700', QUADRION_DEMO: DEMO_FOLDER } });

  test('the floating window never covers the island', async ({ win }, info) => {
    await openTankFarm(win);
    await popOut(win);
    const s = await win.locator('.ws > .stage').boundingBox();
    if (!s) throw new Error('no stage');
    // dragged hard towards the top centre, it stops under the island
    const head = await boxOf(win, 'video-header');
    await drag(win, { x: head.x + 40, y: head.y + head.height / 2 }, s.width / 2, -400);
    // opened, the island takes its second row
    await openIslandTools(win);
    await islandSettled(win);
    const bar = await island(win).boundingBox();
    const box = await boxOf(win, 'video-window');
    if (!bar) throw new Error('no island');
    expect(overlap(box, bar)).toBe(false);
    expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    // and it stays inside the stage
    expect(box.x + box.width).toBeLessThanOrEqual(s.x + s.width);
    expect(box.y + box.height).toBeLessThanOrEqual(s.y + s.height + 1);
    await shot(win, info, 'video-dock-island-1100x700.png');
  });
});
