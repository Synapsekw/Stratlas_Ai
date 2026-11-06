/**
 * The window's bands (UI revision W12, design D1, shell/layoutBands.ts): below 1280 px the Layers
 * column is folded and opens as an overlay over the stage, which Escape or a click on the stage
 * closes, while the right panel stays docked at 300 px and pushes the stage (founder, 30 Oct
 * 2026); from 1280 px it is folded and opens docked; from 1440 px it is open. The rail and its
 * Processing group stay at every width.
 *
 * Every other spec pins the column open; this one lets the bands place it with
 * QUADRION_E2E_AUTOFOLD=1. Each band logs the stage's share of the window, Layers folded and
 * open ("[e2e] stage ..."). QUADRION_E2E_SHOTS=<folder> saves a screenshot per band.
 */
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { expect, test } from './fixtures';

const SHOTS = process.env.QUADRION_E2E_SHOTS;
const RAIL = 52;
/** tokens.css: the Layers column's default width. */
const LAYERS = 252;

async function shot(win: Page, name: string) {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

async function openTiny(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('.proj-switch')).toContainText('E2E tiny project');
  await expect(win.locator('.nav-item[aria-current="page"] .lbl')).toHaveText('Scene');
}

async function expectWidth(win: Page, width: number) {
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(width);
}

/** The stage's width and its share of the window. */
const stageShare = (win: Page) =>
  win.evaluate(() => {
    const w = document.querySelector('.stage')?.getBoundingClientRect().width ?? 0;
    return { width: Math.round(w), share: w / window.innerWidth };
  });

/** The stage's box once it has settled (the fold's slide and the grid's snap). */
async function settledStage(win: Page) {
  let last = -1;
  await expect
    .poll(
      async () => {
        const { width } = await stageShare(win);
        const same = width === last;
        last = width;
        return same && width > 0;
      },
      { intervals: [250] },
    )
    .toBe(true);
  return stageShare(win);
}

const layers = (win: Page) => win.getByTestId('layers-column');

/** The element at the middle of the column is the column's own, not the stage's. */
const columnOnTop = (win: Page) =>
  win.evaluate(() => {
    const col = document.querySelector('[data-testid="layers-column"]');
    const r = col?.getBoundingClientRect();
    if (!col || !r) return false;
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at !== null && col.contains(at);
  });

function logShare(size: string, folded: number, open: number) {
  process.stdout.write(
    `[e2e] stage at ${size}: ${String(Math.round(folded * 100))} % with Layers folded, ` +
      `${String(Math.round(open * 100))} % open\n`,
  );
}

test.describe('below 1280 px', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_E2E_AUTOFOLD: '1' } });

  test('the stage keeps 60 % with Layers closed; Layers opens over it and Escape closes it', async ({
    win,
  }) => {
    await expectWidth(win, 1100);
    await openTiny(win);
    const app = win.locator('.app');
    await expect(app).toHaveAttribute('data-sb', 'collapsed');
    await expect(app).toHaveAttribute('data-sb-overlay', '');
    // the rail's Processing group with Create maps from photos stays on screen
    await expect(win.getByTestId('rail-processing-group')).toBeVisible();

    const folded = await settledStage(win);
    expect(folded.share).toBeGreaterThanOrEqual(0.6);
    // the right panel stays docked at 300 px at the window's end, beside the stage
    const right = await win.evaluate(() => {
      const r = document.querySelector('aside.right')?.getBoundingClientRect();
      return r ? { width: Math.round(r.width), end: Math.round(r.right) } : null;
    });
    expect(right).toEqual({ width: 300, end: 1100 });
    await shot(win, 'bands-1100-folded');

    // Ctrl+L opens the column over the stage: the stage keeps its width
    await win.keyboard.press('Control+L');
    await expect(app).toHaveAttribute('data-sb', 'expanded');
    await expect(layers(win)).toBeVisible();
    await expect.poll(() => columnOnTop(win)).toBe(true);
    const box = await layers(win).boundingBox();
    expect(Math.round(box?.x ?? -1)).toBe(RAIL);
    const open = await settledStage(win);
    expect(open.width).toBe(folded.width);
    await shot(win, 'bands-1100-overlay');
    logShare('1100 x 720', folded.share, open.share);

    // Escape closes it
    await win.keyboard.press('Escape');
    await expect(app).toHaveAttribute('data-sb', 'collapsed');
    await expect(layers(win)).toBeHidden();

    // the title bar's toggle opens it again, and a press on the stage closes it
    await win.getByTestId('layers-toggle').click();
    await expect(app).toHaveAttribute('data-sb', 'expanded');
    await expect.poll(() => columnOnTop(win)).toBe(true);
    const stage = await win.locator('.stage').boundingBox();
    if (!stage) throw new Error('no stage');
    // a free spot of the stage: its middle, a little above the island
    const x = stage.x + stage.width * 0.75;
    const y = stage.y + stage.height * 0.4;
    expect(
      await win.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('.stage'), [
        x,
        y,
      ] as const),
    ).toBe(true);
    await win.mouse.click(x, y);
    await expect(app).toHaveAttribute('data-sb', 'collapsed');

    // no setting changed: the person's own fold is untouched
    expect(
      await win.evaluate(() =>
        window.aio.invoke('settings:get', {}).then((s) => s.sidebarCollapsed),
      ),
    ).toBe(false);
  });
});

test.describe('1280 to 1440 px', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1280x800', QUADRION_E2E_AUTOFOLD: '1' } });

  test('Layers starts folded and opens beside the stage', async ({ win }) => {
    await expectWidth(win, 1280);
    await openTiny(win);
    const app = win.locator('.app');
    await expect(app).toHaveAttribute('data-sb', 'collapsed');
    await expect(app).not.toHaveAttribute('data-sb-overlay', /.*/);
    await expect(win.getByTestId('rail-processing-group')).toBeVisible();
    const folded = await settledStage(win);
    await shot(win, 'bands-1280-folded');
    await win.keyboard.press('Control+B');
    await expect(app).toHaveAttribute('data-sb', 'expanded');
    await expect
      .poll(async () => Math.round((await win.locator('main.main').boundingBox())?.x ?? -1))
      .toBe(RAIL + LAYERS);
    const open = await settledStage(win);
    expect(open.width).toBe(folded.width - LAYERS);
    logShare('1280 x 800', folded.share, open.share);
  });
});

test.describe('1440 px and up', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1440x900', QUADRION_E2E_AUTOFOLD: '1' } });

  test('Layers is open beside the stage', async ({ win }) => {
    await expectWidth(win, 1440);
    await openTiny(win);
    const app = win.locator('.app');
    await expect(app).toHaveAttribute('data-sb', 'expanded');
    await expect(app).not.toHaveAttribute('data-sb-overlay', /.*/);
    await expect(layers(win)).toBeVisible();
    await expect(win.getByTestId('rail-processing-group')).toBeVisible();
    await expect
      .poll(async () => Math.round((await win.locator('main.main').boundingBox())?.x ?? -1))
      .toBe(RAIL + LAYERS);
    const open = await settledStage(win);
    await shot(win, 'bands-1440-open');
    await win.keyboard.press('Control+B');
    await expect(app).toHaveAttribute('data-sb', 'collapsed');
    const folded = await settledStage(win);
    expect(folded.width).toBe(open.width + LAYERS);
    logShare('1440 x 900', folded.share, open.share);
    // the person's fold: Ctrl+B brings it back
    await win.keyboard.press('Control+B');
    await expect(app).toHaveAttribute('data-sb', 'expanded');
  });
});
