/**
 * Placing a walk on a drawing (the walk layer and placing by start and end): in a project with no
 * coordinate system, the walk's shape follows the pointer, a start click and an end click place
 * it (an end in the same area as the start is allowed), its End handle is dragged, Fine-tune opens the
 * 360, and Save writes a pose that keeps the walk's L; Edit placement reopens it and Remove
 * placement clears it. A walk is removed from its row, and its folder goes to the project trash.
 * A walk that was never processed shows why, offers Process walk and draws no line. The toolbar
 * never covers the drawing, also in the smallest window.
 *
 * The project is written by `walkFixture.ts` into the test's own data root (the shared fixture
 * project is left as it is). Skipped when ffmpeg with libx264 is missing (CI installs it).
 */
import type { Locator, Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import {
  createWalkProject,
  ffmpegReady,
  openWalkProject,
  poseBendM,
  rowAction,
  SHEET_LAYER,
  SHEET_PX,
  WALK_ID,
  WALK_LAYER,
  WALK_NAME,
  walkRow,
} from './walkFixture';

interface ManifestFile {
  layers: {
    id: string;
    capture?: string;
    place?: { pins: unknown[]; placedOn?: string };
  }[];
}

async function walkLayer(dir: string): Promise<ManifestFile['layers'][number] | undefined> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ManifestFile;
  return manifest.layers.find((l) => l.id === WALK_LAYER);
}

/**
 * The page point of a pixel of the drawing's picture, wherever the view has put it. The toolbar
 * above the pane can change height between steps and the view fits itself to the new pane size,
 * so the picture is fitted again and its place read once it has stopped moving.
 */
async function sheetPoint(win: Page, px: [number, number]): Promise<{ x: number; y: number }> {
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
  return { x: r.x + px[0] * k, y: r.y + px[1] * k };
}

/** Click the drawing at a pixel of its picture. */
async function clickSheet(win: Page, px: [number, number]): Promise<void> {
  const p = await sheetPoint(win, px);
  await win.mouse.click(p.x, p.y);
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

/** The toolbar ends above the drawing pane: it takes room, it does not lie over the drawing. */
async function stripAboveDrawing(win: Page): Promise<boolean> {
  const strip = await win.getByTestId('walk-place-strip').boundingBox();
  const view = await win.getByTestId('raster-view').boundingBox();
  return Boolean(strip && view && strip.y + strip.height <= view.y + 1);
}

/** Open Place walk on the fixture walk: the toolbar asks for the start on the drawing. */
async function beginPlacing(win: Page): Promise<Locator> {
  await rowAction(win, 'place');
  const strip = win.getByTestId('walk-place-strip');
  await expect(strip).toHaveAttribute('data-step', 'start', { timeout: 30_000 });
  await expect(strip.getByTestId('walk-place-on')).toHaveValue(SHEET_LAYER);
  // nothing to save before the start
  await expect(strip.getByTestId('walk-place-save')).toBeDisabled();
  await win
    .getByTestId('raster-view')
    .getByRole('button', { name: 'Fit the whole raster' })
    .click();
  return strip;
}

test.describe('placing a walk', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('a walk is placed on a drawing by its start and end, adjusted, saved, and its placement removed', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(240_000);
    const dir = await createWalkProject(dataRoot.root);
    await win.reload();
    await openWalkProject(win);

    // the walk sits in the Datasets list under 360 walks, waiting to be placed
    const row = await walkRow(win);
    await expect(row).toContainText(WALK_NAME);
    await expect(win.getByTestId(`tree-badge-${WALK_LAYER}`)).toHaveText('Needs placing');

    const strip = await beginPlacing(win);
    // the walk has no survey date: the field offers the capture's
    await expect(strip.getByTestId('walk-place-date-field')).toHaveValue('capture-1');
    // the toolbar takes room above the drawing and leaves its middle free
    expect(await stripAboveDrawing(win)).toBe(true);
    expect(await centreReachesDrawing(win)).toBe(true);

    // before the start, the walk's whole shape follows the pointer as a ghost
    const view = win.getByTestId('raster-view');
    const hover = await sheetPoint(win, [120, 150]);
    await win.mouse.move(hover.x, hover.y);
    await expect(view.getByTestId('walk-preview')).toHaveAttribute('data-ghost', 'true');

    // start and end, as the synthetic walk went: 40 m east, then 30 m north (0.2 m a pixel)
    await clickSheet(win, [100, 175]);
    await expect(strip).toHaveAttribute('data-step', 'end');
    // an end 1 m from the start is allowed: a walk can finish where it began
    const near = await sheetPoint(win, [105, 175]);
    await win.mouse.move(near.x, near.y);
    await expect(strip.getByTestId('walk-place-hint')).toHaveText(
      'Click where the walk ended. Esc moves the start.',
    );
    await clickSheet(win, [300, 25]);
    await expect(strip).toHaveAttribute('data-step', 'placed');
    await expect(view.getByTestId('walk-line').first()).toBeVisible();
    await expect(view.getByTestId('walk-handle-start')).toBeVisible();
    await expect(view.getByTestId('walk-handle-end')).toBeVisible();
    expect(await centreReachesDrawing(win)).toBe(true);

    // drag the End handle a little: the walk is refitted and stays placed
    await sheetPoint(win, [300, 25]);
    const end = await view.getByTestId('walk-handle-end').boundingBox();
    if (!end) throw new Error('the End handle is not on screen');
    const ex = end.x + end.width / 2;
    const ey = end.y + end.height / 2;
    await win.mouse.move(ex, ey);
    await win.mouse.down();
    await win.mouse.move(ex, ey + 15, { steps: 5 });
    await win.mouse.up();
    await expect(strip).toHaveAttribute('data-step', 'placed');

    // Fine-tune opens the 360 beside the drawing, and closes again
    await strip.getByTestId('walk-place-finetune').click();
    await expect(strip.getByTestId('walk-place-finetune')).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByTestId('walk-view')).toBeVisible();
    await expect(strip.getByTestId('walk-place-pin-here')).toBeVisible();
    await strip.getByTestId('walk-place-finetune').click();
    await expect(strip).toHaveAttribute('data-step', 'placed');

    // Save: the toolbar closes, the badge goes, the pose keeps the walk's L
    await strip.getByTestId('walk-place-save').click();
    await expect(win.getByTestId('walk-place-strip')).toHaveCount(0, { timeout: 30_000 });
    await expect(win.getByTestId(`tree-row-${WALK_LAYER}`)).toBeVisible();
    await expect(win.getByTestId(`tree-badge-${WALK_LAYER}`)).toHaveCount(0);
    const walkDir = join(dir, 'walks', WALK_ID);
    await expect.poll(() => readdir(walkDir)).toContain('pose.json');
    await expect.poll(() => poseBendM(dir)).toBeGreaterThan(15);
    const layer = await walkLayer(dir);
    expect(layer?.capture).toBe('capture-1');
    expect(layer?.place?.pins).toHaveLength(2);
    expect(layer?.place?.placedOn).toBe(SHEET_LAYER);

    // Edit placement reopens the saved placement with both handles
    await rowAction(win, 'edit');
    const again = win.getByTestId('walk-place-strip');
    await expect(again).toHaveAttribute('data-step', 'placed', { timeout: 30_000 });
    await expect(view.getByTestId('walk-handle-start')).toBeVisible();
    await expect(view.getByTestId('walk-handle-end')).toBeVisible();

    // Remove placement: the walk stays, unplaced
    await again.getByTestId('walk-place-remove').click();
    await again.getByTestId('walk-place-remove-yes').click();
    await expect(win.getByTestId('walk-place-strip')).toHaveCount(0, { timeout: 30_000 });
    await walkRow(win);
    await expect(win.getByTestId(`tree-badge-${WALK_LAYER}`)).toHaveText('Needs placing');
    await expect.poll(async () => (await walkLayer(dir))?.place).toBeUndefined();
    expect(await walkLayer(dir)).toBeDefined();
  });

  test('a walk is removed from its row, and its folder goes to the project trash', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    const dir = await createWalkProject(dataRoot.root);
    await win.reload();
    await openWalkProject(win);

    // the walk is open in the 360 pane (its playback file in use) when it is removed
    await rowAction(win, 'open');
    await expect(win.getByTestId('walk-view')).toHaveAttribute('data-status', 'ready', {
      timeout: 60_000,
    });
    await rowAction(win, 'remove');
    const confirm = win.getByTestId('remove-dialog');
    await expect(confirm.getByTestId('remove-dialog-title')).toContainText(WALK_NAME);
    await confirm.getByTestId('remove-dialog-confirm').click();
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

  test('a walk that was never processed shows why, offers Process walk and draws no line', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    await createWalkProject(dataRoot.root, { processed: false });
    await win.reload();
    await openWalkProject(win);
    await rowAction(win, 'place');
    const strip = win.getByTestId('walk-place-strip');
    await expect(strip).toHaveAttribute('data-step', 'check', { timeout: 30_000 });
    const notice = strip.getByTestId('walk-place-notice');
    await expect(notice).toHaveAttribute('data-state', 'none');
    await expect(notice).toContainText('This walk is not processed yet, so its path is unknown.');
    const process = strip.getByTestId('walk-place-process');
    await expect(process).toBeVisible();
    await expect(process).toHaveText('Process walk');
    // without a pipeline pack (CI may have none) the button says why it cannot run
    if (await process.isDisabled())
      await expect(strip).toContainText('Needs a newer pipeline pack');
    await expect(strip.getByTestId('walk-place-anyway')).toBeVisible();

    // the pointer over the surface draws nothing: the path is unknown
    const view = win.getByTestId('raster-view');
    const surface = (await view.isVisible())
      ? view
      : win.locator('[data-scene-view] canvas').first();
    const box = await surface.boundingBox();
    if (!box) throw new Error('no surface on screen');
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10, { steps: 3 });
    await win.waitForTimeout(300);
    await expect(win.getByTestId('walk-preview')).toHaveCount(0);
    await expect(win.getByTestId('walk-line')).toHaveCount(0);

    // Place between two points anyway goes on to the start
    await strip.getByTestId('walk-place-anyway').click();
    await expect(strip).toHaveAttribute('data-step', 'start');
  });
});

test.describe('placing a walk in the smallest window', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

  test('the Place walk toolbar does not cover the drawing at 1100 x 700', async ({
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
    await expect(strip).toHaveAttribute('data-step', 'placed');
    // placed, with its Save row: still above the drawing
    expect(await stripAboveDrawing(win)).toBe(true);
    expect(await centreReachesDrawing(win)).toBe(true);
  });
});
