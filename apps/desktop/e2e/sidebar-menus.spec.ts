/**
 * Right-click menus across the Datasets sidebar (15 Oct 2026): empty space, a date folder, a group
 * heading and a row of each kind the demo holds, each opened by right-click and by Shift+F10, show
 * their items and run one action each. A photo pin on the map opens the photo menu with Align to.
 * Synthetic data only; off-screen; zero network.
 */
import type { Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test } from './fixtures';
import { stageMode } from './island';

interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        hidden: Record<string, true>;
        project: { manifest: { layers: { id: string; kind: string; name: string }[] } } | null;
      };
    };
    stage(): { saveView(): { position: number[]; target: number[] } } | null;
  };
}

interface MapEl extends Element {
  __aioMap: {
    getContainer(): HTMLElement;
    getLayer(id: string): unknown;
    project(ll: [number, number]): { x: number; y: number };
    querySourceFeatures(id: string): {
      properties: Record<string, unknown> | null;
      geometry: { type: string; coordinates: unknown };
    }[];
  };
}

async function openThreeDates(win: Page, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E three dates' }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
}

const hidden = (win: Page) =>
  win.evaluate(() =>
    Object.keys((window as unknown as Probe).__stratlas.workspace.getState().hidden),
  );

/** Menus open on the page, whatever their kind (a menu is a portal on the body). */
const menus = (win: Page) => win.locator('body > [role="menu"]');

/** Let a trailing event (a contextmenu after a key) arrive before the next look. */
const settle = (win: Page) =>
  win.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            done();
          }),
        ),
      ),
  );

/**
 * Open the menu by right-click, check it, close it with Escape; then by Shift+F10 on the focused
 * element, check it again (and that exactly one menu is open) and close it.
 */
async function both(win: Page, el: Locator, menuId: string, check: () => Promise<void>) {
  await el.click({ button: 'right' });
  await expect(win.getByTestId(menuId)).toBeVisible();
  await check();
  await win.keyboard.press('Escape');
  await expect(menus(win)).toHaveCount(0);
  await el.focus();
  await win.keyboard.press('Shift+F10');
  await expect(win.getByTestId(menuId)).toBeVisible();
  await settle(win);
  await expect(menus(win)).toHaveCount(1);
  await check();
  await win.keyboard.press('Escape');
  await expect(menus(win)).toHaveCount(0);
}

test('empty space opens the project menu; Add survey date opens its dialog', async ({
  threeDateProject,
  win,
}) => {
  await openThreeDates(win, threeDateProject.id);
  const check = async () => {
    await expect(win.getByTestId('ctx-menu').getByTestId('ctx-item-project.addData')).toBeVisible();
    await expect(win.getByTestId('ctx-menu')).toBeInViewport({ ratio: 1 });
  };
  // by mouse: the tree's own heading, which is no row, folder or group
  await win.locator('.sb-tree .tree-h .caps').click({ button: 'right' });
  await expect(win.getByTestId('ctx-menu')).toBeVisible();
  await check();
  await win.keyboard.press('Escape');
  await expect(menus(win)).toHaveCount(0);
  // by keyboard: a button of the tree's own header that is not a row
  await win.getByTestId('add-data').focus();
  await win.keyboard.press('Shift+F10');
  await expect(win.getByTestId('ctx-menu')).toBeVisible();
  await settle(win);
  await expect(menus(win)).toHaveCount(1);
  await check();
  await win.getByTestId('ctx-item-project.addSurveyDate').click();
  await expect(win.getByTestId('add-date-menu')).toBeVisible();
});

test('a date folder menu has its items by mouse and keyboard; Zoom to moves the camera', async ({
  threeDateProject,
  win,
}) => {
  await openThreeDates(win, threeDateProject.id);
  // the folder's name button: focusable for Shift+F10, and a right-click on it reaches the folder
  const name = win.getByTestId('date-name-oct');
  await both(win, name, 'date-menu', async () => {
    for (const id of [
      'date-menu-view',
      'date-menu-rename',
      'date-menu-compare',
      'ctx-item-date.zoomTo',
      'ctx-item-date.export',
    ])
      await expect(win.getByTestId(id)).toBeVisible();
  });
  const before = await win.evaluate(() =>
    (window as unknown as Probe).__stratlas.stage()?.saveView(),
  );
  await name.click({ button: 'right' });
  await win.getByTestId('ctx-item-date.zoomTo').click();
  await expect
    .poll(() =>
      win.evaluate(() => (window as unknown as Probe).__stratlas.stage()?.saveView().target),
    )
    .not.toEqual(before?.target);
});

test('a group heading menu hides its group', async ({ threeDateProject, win }) => {
  await openThreeDates(win, threeDateProject.id);
  await win.getByTestId('date-name-nov').click();
  const header = win.getByTestId('date-folder-nov').getByTestId('tree-group-maps');
  await both(win, header.locator('.tgroup-btn'), 'move-menu', async () => {
    await expect(win.getByTestId('move-menu')).toContainText('Maps and rasters');
    await expect(win.getByTestId('ctx-item-group.toggle')).toBeVisible();
  });
  await header.click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.hide').click();
  await expect.poll(() => hidden(win)).toContain('site-nov');
});

test('a row: Rename persists, Properties shows its file, Hide hides', async ({
  dataRoot,
  threeDateProject,
  win,
}) => {
  await openThreeDates(win, threeDateProject.id);
  await win.getByTestId('date-name-sep').click();
  const row = win.getByTestId('tree-row-quad-sep');
  await both(win, row, 'move-menu', async () => {
    for (const id of [
      'ctx-item-layer.zoomTo',
      'ctx-item-layer.rename',
      'move-to-oct',
      'ctx-item-layer.properties',
      'menu-delete',
    ])
      await expect(win.getByTestId(id)).toBeVisible();
  });
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.rename').click();
  await win.getByTestId('layer-rename').fill('Quad survey');
  await win.keyboard.press('Enter');
  await expect(row).toContainText('Quad survey');
  const manifest = JSON.parse(
    await readFile(join(dataRoot.root, 'projects', threeDateProject.id, 'manifest.json'), 'utf8'),
  ) as { layers: { id: string; name: string; capture?: string }[] };
  expect(manifest.layers.find((l) => l.id === 'quad-sep')).toMatchObject({
    name: 'Quad survey',
    capture: 'sep',
  });
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.properties').click();
  await expect(win.getByTestId('layer-props')).toContainText('models/');
  await win.getByTestId('layer-props-close').click();
  await row.focus();
  await win.keyboard.press('F2');
  await expect(win.getByTestId('layer-rename')).toBeFocused();
  await win.keyboard.press('Escape');
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.hide').click();
  await expect.poll(() => hidden(win)).toContain('quad-sep');
});

test('a row of each kind in the change demo has its kind items', async ({ demoProject }) => {
  const { win } = demoProject;
  const layers = await win.evaluate(
    () =>
      (window as unknown as Probe).__stratlas.workspace.getState().project?.manifest.layers ?? [],
  );
  // open every date folder so every row is drawn
  const folders = win.locator('[data-testid^="date-folder-"]');
  for (let i = 0; i < (await folders.count()); i++) {
    const f = folders.nth(i);
    if ((await f.getAttribute('aria-expanded')) === 'false')
      await f.locator('.dchev').first().click();
  }
  let seen = 0;
  const extra: Record<string, string> = {
    mesh: 'ctx-item-mesh.georef',
    pointcloud: 'ctx-item-cloud.settings',
    photos: 'ctx-item-photos.alignTo',
    video: 'ctx-item-video.calibrate',
    raster: 'ctx-item-layer.export',
    vector: 'ctx-item-layer.export',
  };
  for (const kind of Object.keys(extra)) {
    const l = layers.find((x) => x.kind === kind);
    if (!l) continue;
    const row = win.getByTestId(`tree-row-${l.id}`).first();
    // in a closed group of a date folder: the menus above cover it
    if ((await row.count()) === 0 || !(await row.isVisible())) continue;
    await row.scrollIntoViewIfNeeded();
    await row.click({ button: 'right' });
    await expect(win.getByTestId('move-menu').getByTestId(extra[kind] ?? '')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(menus(win)).toHaveCount(0);
    seen++;
  }
  expect(seen).toBeGreaterThan(2);
});

test('a row menu fits the window, so every item can be reached', async ({
  threeDateProject,
  win,
}) => {
  await openThreeDates(win, threeDateProject.id);
  await win.getByTestId('date-name-sep').click();
  await win.getByTestId('tree-row-quad-sep').click({ button: 'right' });
  await expect(win.getByTestId('move-menu')).toBeVisible();
  await expect(win.getByTestId('move-menu')).toBeInViewport({ ratio: 1 });
  await expect(win.getByTestId('menu-delete')).toBeInViewport({ ratio: 1 });
});

test('a photo pin on the map opens the photo menu with Align to', async ({ demoProject }) => {
  const { win } = demoProject;
  const layers = await win.evaluate(
    () =>
      (window as unknown as Probe).__stratlas.workspace.getState().project?.manifest.layers ?? [],
  );
  test.skip(!layers.some((l) => l.kind === 'photos'), 'the demo holds no photo set');
  // the map beside 3D, so the pins show
  const mode = await win.locator('.stage').getAttribute('data-mode');
  if (mode !== 'split') await stageMode(win, 'Split');
  const found: { at: { x: number; y: number } | null } = { at: null };
  await expect
    .poll(
      async () => {
        found.at = await win.evaluate(() => {
          const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
            MapEl | undefined;
          if (!el?.__aioMap.getLayer('aio-photos-pt')) return null;
          const f = el.__aioMap.querySourceFeatures('aio-photos')[0];
          if (!f) return null;
          const p = el.__aioMap.project(f.geometry.coordinates as [number, number]);
          const r = el.__aioMap.getContainer().getBoundingClientRect();
          return { x: r.left + p.x, y: r.top + p.y };
        });
        return found.at !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const at = found.at ?? { x: 0, y: 0 };
  await win.mouse.click(at.x, at.y, { button: 'right' });
  // a single photo opens its menu, a cluster lists its photos first
  const list = win.getByTestId('photo-menu-list');
  if (await list.isVisible().catch(() => false)) await list.getByRole('menuitem').first().click();
  await expect(win.getByTestId('photo-menu')).toBeVisible();
  await expect(win.getByTestId('photo-menu-alignTo')).toBeVisible();
});
