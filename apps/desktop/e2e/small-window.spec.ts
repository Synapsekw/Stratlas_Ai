/**
 * The smallest window, 1100 x 700 (the size the CI runners give the app): what only goes wrong
 * when there is little room. Asked for here, so a run at the default size covers it too.
 *
 * Screenshots go to the test's output folder (test-results/), or to QUADRION_E2E_SHOTS when it
 * names a folder.
 */
import type { Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

/** A view that was just created (the map loads its style, the 3D scene its model) takes a while. */
const VIEW_READY = { timeout: 30_000 };

const stageBar = (win: Page) => win.getByRole('toolbar', { name: 'Stage tools' });

/** Switch the stage with its view switch (the one control of that name on the toolbar). */
async function showView(win: Page, view: '3D' | 'Map'): Promise<void> {
  const button = stageBar(win)
    .getByRole('group', { name: 'Stage view' })
    .getByRole('button', { name: view, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', view === '3D' ? '3d' : 'map');
}

async function openProject(win: Page): Promise<void> {
  // the window is the smallest one (within a pixel or two: display scaling rounds)
  const [w, h] = await win.evaluate(() => [innerWidth, innerHeight]);
  expect(Math.abs(w - 1100), `window width ${String(w)}`).toBeLessThanOrEqual(2);
  expect(Math.abs(h - 700), `window height ${String(h)}`).toBeLessThanOrEqual(2);
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs b')).toHaveText('Scene');
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible(VIEW_READY);
}

async function shot(win: Page, info: TestInfo, name: string): Promise<void> {
  // two frames, so what was just laid out has been drawn
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const dir = process.env.QUADRION_E2E_SHOTS;
  if (dir) await mkdir(dir, { recursive: true });
  await win.screenshot({ path: dir ? join(dir, name) : info.outputPath(name) });
}

test('the Map toolbar shows its tools again after a visit to the 3D view', async ({
  win,
}, info) => {
  await openProject(win);
  const bar = stageBar(win);
  const layers = bar.getByRole('button', { name: 'Layers and issue pins', exact: true });
  const more = bar.getByRole('button', { name: 'More tools', exact: true });

  // the map's toolbar fits the stage: every group on the bar, nothing folded
  await showView(win, 'Map');
  await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
  await expect(layers).toBeVisible();
  await expect(more).toHaveCount(0);

  // the 3D view has more tools than fit: Labels and layers is the first group to fold
  await showView(win, '3D');
  await expect(bar.getByRole('button', { name: 'Environment and time of day' })).toBeVisible(
    VIEW_READY,
  );
  await expect(more).toBeVisible();
  await expect(layers).toHaveCount(0);

  // back on the map the bar is as it was: what the 3D view folded does not stay folded
  await showView(win, 'Map');
  await expect(win.locator('.maplibregl-canvas')).toBeVisible(VIEW_READY);
  await expect(layers).toBeVisible();
  await expect(more).toHaveCount(0);
  await shot(win, info, 'map-toolbar-after-3d.png');
});
