/**
 * Placing a walk (the walk layer and placing): a walk with a computed path is placed on a drawing
 * in a project with no coordinate system, by its start, its end and one correction pin, and saved;
 * the Datasets row loses its "Needs placing" badge and the pose file is written. A walk is removed
 * from its row, and its folder goes to the project trash. The Place walk strip never covers the
 * drawing, also in the smallest window.
 *
 * The project is written by `walkFixture.ts` into the test's own data root (the shared fixture
 * project is left as it is). Skipped when ffmpeg with libx264 is missing (CI installs it).
 */
import type { Locator, Page } from '@playwright/test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import {
  createWalkProject,
  ffmpegReady,
  SHEET_PX,
  WALK_ID,
  WALK_LAYER,
  WALK_NAME,
  WALK_PROJECT,
} from './walkFixture';

async function openWalkProject(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: WALK_PROJECT.name }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
}

/** The walk's row in the Datasets list, with its folder opened when the date put it in one. */
async function walkRow(win: Page): Promise<Locator> {
  const row = win.getByTestId(`tree-row-${WALK_LAYER}`);
  if (!(await row.isVisible())) {
    const folder = win.getByTestId('date-folder-capture-1');
    if ((await folder.getAttribute('aria-expanded')) === 'false')
      await folder.getByRole('button').first().click();
  }
  await expect(row).toBeVisible();
  return row;
}

/** Press one of the row's action buttons; they show on hover or focus. */
async function rowAction(win: Page, kind: 'open' | 'place' | 'remove'): Promise<void> {
  const row = await walkRow(win);
  await row.hover();
  await win.getByTestId(`walk-${kind}-${WALK_LAYER}`).click();
}

/**
 * Click the drawing at a pixel of its picture, wherever the view has put it. The strip above the
 * pane changes height between steps and the view fits itself to the new pane size, so the
 * picture's place is read once it has stopped moving.
 */
async function clickSheet(win: Page, px: [number, number]): Promise<void> {
  // the strip grows as pins come in and the pane shrinks under it: fit the sheet in again first
  await win
    .getByTestId('raster-view')
    .getByRole('button', { name: 'Fit the whole raster' })
    .click();
  const plane = win.getByTestId('raster-view').locator('.raster-plane');
  let r = await plane.boundingBox();
  for (let i = 0; i < 20; i++) {
    await win.waitForTimeout(100);
    const next = await plane.boundingBox();
    const same =
      r !== null &&
      next !== null &&
      Math.abs(next.x - r.x) < 0.5 &&
      Math.abs(next.y - r.y) < 0.5 &&
      Math.abs(next.width - r.width) < 0.5;
    r = next;
    if (same) break;
  }
  if (!r) throw new Error('the drawing is not on screen');
  const k = r.width / SHEET_PX.width;
  await win.mouse.click(r.x + px[0] * k, r.y + px[1] * k);
}

/** What lies on top at the drawing pane's centre: the drawing, or something over it. */
async function centreReachesDrawing(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const view = document.querySelector('[data-testid="raster-view"]');
    if (!view) return false;
    const r = view.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(top && view.contains(top) && !top.closest('[data-testid="walk-place-strip"]'));
  });
}

/** The strip ends above the drawing pane: it takes room, it does not lie over the drawing. */
async function stripAboveDrawing(win: Page): Promise<boolean> {
  const strip = await win.getByTestId('walk-place-strip').boundingBox();
  const view = await win.getByTestId('raster-view').boundingBox();
  return Boolean(strip && view && strip.y + strip.height <= view.y + 1);
}

/** Open Place walk on the fixture walk and answer the date step: the strip asks for the start. */
async function beginPlacing(win: Page): Promise<Locator> {
  await rowAction(win, 'place');
  const strip = win.getByTestId('walk-place-strip');
  await expect(strip).toHaveAttribute('data-step', 'date', { timeout: 30_000 });
  await expect(strip).toContainText('Choose the survey date of this walk');
  await strip.getByTestId('walk-place-date').first().click();
  await expect(strip).toHaveAttribute('data-step', 'start', { timeout: 30_000 });
  await expect(strip).toContainText('Where did the walk start?');
  await expect(strip.getByTestId('walk-place-on')).toHaveValue('sheet-ground-floor');
  await win
    .getByTestId('raster-view')
    .getByRole('button', { name: 'Fit the whole raster' })
    .click();
  return strip;
}

test.describe('placing a walk', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('a walk is placed on a drawing by its start, end and a pin, and stays placed', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(180_000);
    const dir = await createWalkProject(dataRoot.root);
    await win.reload();
    await openWalkProject(win);

    // the walk sits in the Datasets list under 360 walks, waiting to be placed
    const row = await walkRow(win);
    await expect(row).toContainText(WALK_NAME);
    await expect(win.getByTestId(`tree-badge-${WALK_LAYER}`)).toHaveText('Needs placing');

    const strip = await beginPlacing(win);
    // the strip takes room above the drawing and leaves its middle free
    expect(await stripAboveDrawing(win)).toBe(true);
    expect(await centreReachesDrawing(win)).toBe(true);

    // start and end, as the synthetic walk went: 40 m east, then 30 m north (0.2 m a pixel)
    await clickSheet(win, [100, 175]);
    await expect(strip).toHaveAttribute('data-step', 'end');
    await expect(strip).toContainText('Where did it end?');
    await clickSheet(win, [300, 25]);
    await expect(strip).toHaveAttribute('data-step', 'correct');
    await expect(strip.getByTestId('walk-place-pin')).toHaveCount(2);

    // the path and its stills are drawn on the sheet
    const view = win.getByTestId('raster-view');
    await expect(view.getByTestId('walk-line').first()).toBeVisible();
    const dots = await view
      .getByTestId('walk-stills')
      .first()
      .evaluate((p) => (p.getAttribute('d') ?? '').split('M').length - 1);
    expect(dots).toBeGreaterThanOrEqual(10);

    // a correction: scrub to 30 s, Pin here, click where the camera was then
    await win.getByTestId('walk-scrub').fill('30');
    await expect
      .poll(async () => Number(await win.getByTestId('walk-bar').getAttribute('data-time')))
      .toBeCloseTo(30, 0);
    await strip.getByTestId('walk-place-pin-here').click();
    await expect(strip).toContainText('Click the true spot for this moment.');
    await clickSheet(win, [256, 175]);
    await expect(strip.getByTestId('walk-place-pin')).toHaveCount(3);
    // the clicks follow the synthetic walk, so every pin fits within half a metre
    const residuals = (await strip.getByTestId('walk-place-pin').allInnerTexts()).map((t) =>
      Number(/(\d+\.\d\d) m/.exec(t)?.[1] ?? NaN),
    );
    expect(residuals).toHaveLength(3);
    for (const r of residuals) expect(r).toBeLessThan(0.5);
    expect(await centreReachesDrawing(win)).toBe(true);

    // Save: the strip closes, the badge goes, the pose file is written
    await strip.getByTestId('walk-place-save').click();
    await expect(win.getByTestId('walk-place-strip')).toHaveCount(0, { timeout: 30_000 });
    await expect(win.getByTestId(`tree-row-${WALK_LAYER}`)).toBeVisible();
    await expect(win.getByTestId(`tree-badge-${WALK_LAYER}`)).toHaveCount(0);
    const walkDir = join(dir, 'walks', WALK_ID);
    await expect.poll(() => readdir(walkDir)).toContain('pose.json');
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      layers: { id: string; capture?: string; place?: { pins: unknown[]; placedOn?: string } }[];
    };
    const layer = manifest.layers.find((l) => l.id === WALK_LAYER);
    expect(layer?.capture).toBe('capture-1');
    expect(layer?.place?.pins).toHaveLength(3);
    expect(layer?.place?.placedOn).toBe('sheet-ground-floor');

    // reopened, the walk is still placed
    await win.reload();
    await openWalkProject(win);
    await walkRow(win);
    await expect(win.getByTestId(`tree-badge-${WALK_LAYER}`)).toHaveCount(0);
    expect((await stat(join(walkDir, 'pose.json'))).size).toBeGreaterThan(0);
  });

  test('a walk is removed from its row, and its folder goes to the project trash', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    const dir = await createWalkProject(dataRoot.root);
    await win.reload();
    await openWalkProject(win);

    await rowAction(win, 'remove');
    const confirm = win.getByTestId('walk-remove-confirm');
    await expect(confirm).toContainText(
      `Remove ${WALK_NAME}? Its files stay in the project trash for seven days.`,
    );
    await confirm.getByTestId('walk-remove-yes').click();
    await expect(win.getByTestId(`tree-row-${WALK_LAYER}`)).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => readdir(join(dir, 'walks'))).toEqual([]);
    const trash = await readdir(join(dir, '.trash'));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(new RegExp(`-${WALK_ID}$`));
    expect(await readdir(join(dir, '.trash', trash[0] ?? ''))).toContain('walk.json');
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      layers: { id: string }[];
    };
    expect(manifest.layers.map((l) => l.id)).not.toContain(WALK_LAYER);
  });
});

test.describe('placing a walk in the smallest window', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

  test('the Place walk strip does not cover the drawing at 1100 x 700', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    await createWalkProject(dataRoot.root);
    await win.reload();
    await openWalkProject(win);
    const strip = await beginPlacing(win);
    expect(await stripAboveDrawing(win)).toBe(true);
    expect(await centreReachesDrawing(win)).toBe(true);
    await clickSheet(win, [100, 175]);
    await expect(strip).toHaveAttribute('data-step', 'end');
    await clickSheet(win, [300, 25]);
    await expect(strip).toHaveAttribute('data-step', 'correct');
    // the strip grew a row of pins: still above the drawing
    expect(await stripAboveDrawing(win)).toBe(true);
    expect(await centreReachesDrawing(win)).toBe(true);
  });
});
