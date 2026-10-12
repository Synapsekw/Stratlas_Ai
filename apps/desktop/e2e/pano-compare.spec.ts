/**
 * Panoramas of two survey dates side by side (timeline T3), and "Compare with..." from the tree,
 * in the real app. Runs on `e2e-pano-dates` (4 Sep, 2 Oct, 6 Nov 2024; a model and three
 * panoramas per date, panoFixtures.ts). Off-screen, zero network.
 *
 * The left Panoramas pane leads: it steps through its date's panoramas and follows the date bar;
 * the right pane shows the panorama of its own date nearest on the ground (within 25 m, else it
 * says so and offers the nearest anyway). Linked panes look the same way.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, openProject, test as base } from './fixtures';
import { choosePane, createPanoDateProject, PANO_DATE_PROJECT_NAME } from './panoFixtures';

/** The panorama project, written before the app starts (list `panoProject` before `win`). */
const test = base.extend<{ panoProject: { id: string } }>({
  panoProject: async ({ dataRoot }, use) => {
    await use(await createPanoDateProject(dataRoot));
  },
});

interface Probe {
  __stratlas: {
    graphics(): { getState(): { tier: string; setOverride(t: string | null): void } };
  };
}

async function openPanoDates(win: Page, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: PANO_DATE_PROJECT_NAME }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
}

const pane = (win: Page, side: 'left' | 'right') =>
  win.locator(`[data-testid="pane-pano"][data-side="${side}"]`);

/** The look-around view of a side (the WebGL sphere). */
const surface = (win: Page, side: 'left' | 'right') => pane(win, side).locator('[role="img"]');

const yaw = async (win: Page, side: 'left' | 'right') =>
  Number(await pane(win, side).getAttribute('data-yaw'));

/** Drag across the middle of a side's view, `dx` pixels to the right. */
async function dragLook(win: Page, view: Locator, dx: number) {
  const box = await view.boundingBox();
  if (!box) throw new Error('the panorama view is not on screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + dx, y, { steps: 8 });
  await win.mouse.up();
}

/**
 * Right-click a row of a date folder (a layer, or a group header such as "Panoramas"), "Compare
 * with another date...", then the target date.
 */
async function compareRow(win: Page, folder: string, rowId: string, to: string) {
  const row = win.getByTestId(`date-folder-${folder}`).getByTestId(rowId);
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  const menu = win.getByTestId('move-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('move-compare').click();
  await menu.getByTestId(`compare-to-${to}`).click();
  await expect(menu).toHaveCount(0);
}

/** Right-click a date folder, "Compare with...", then the target date. */
async function compareFolder(win: Page, folder: string, to: string) {
  const row = win.getByTestId(`date-folder-${folder}`).locator('.dfolder-row');
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  const menu = win.getByTestId('date-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('date-menu-compare').click();
  await menu.getByTestId(`compare-to-${to}`).click();
  await expect(menu).toHaveCount(0);
}

/** Panoramas of 6 Nov on the left, 2 Oct on the right, from the tree. */
async function compareNovWithOct(win: Page) {
  await compareRow(win, 'nov', 'tree-group-panoramas', 'oct');
  await expect(pane(win, 'left')).toHaveAttribute('data-capture', 'nov');
  await expect(pane(win, 'right')).toHaveAttribute('data-capture', 'oct');
}

const stageView = (win: Page, view: '3D' | 'Map' | 'Split') =>
  win
    .getByRole('toolbar', { name: 'Stage tools' })
    .getByRole('group', { name: 'Stage view' })
    .getByRole('button', { name: view, exact: true });

test.describe('panoramas of two survey dates', () => {
  test('compare a Panoramas row with another date: pair, link, pick, step, follow the date bar', async ({
    panoProject,
    win,
  }) => {
    await openPanoDates(win, panoProject.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('6 Nov 2024');

    // 1. the Panoramas header of 6 Nov compared with 2 Oct: two Panoramas panes, nearest paired
    await compareNovWithOct(win);
    await expect(stageView(win, 'Split')).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByTestId('pane-pano')).toHaveCount(2);
    await expect(pane(win, 'left')).toHaveAttribute('data-pano', 'pano-nov/p1');
    await expect(pane(win, 'right')).toHaveAttribute('data-pano', 'pano-oct/p1');
    expect(Number(await pane(win, 'right').getAttribute('data-distance'))).toBeCloseTo(2, 1);
    await expect(win.getByTestId('pane-select-left')).toHaveValue('pano@nov');
    await expect(win.getByTestId('pane-select-right')).toHaveValue('pano@oct');

    // 2. linked: a drag on the left turns the right the same way
    await expect(surface(win, 'left')).toHaveAttribute('data-status', /./);
    const before = await yaw(win, 'left');
    await dragLook(win, surface(win, 'left'), 120);
    await expect.poll(() => yaw(win, 'left')).not.toBe(before);
    await expect
      .poll(async () => (await yaw(win, 'right')) === (await yaw(win, 'left')))
      .toBe(true);
    // unlinked: the right stays where it was
    const link = win.getByTestId('compare-link');
    await expect(link).toHaveAttribute('aria-pressed', 'true');
    await link.click();
    await expect(link).toHaveAttribute('aria-pressed', 'false');
    const rightYaw = await yaw(win, 'right');
    const leftYaw = await yaw(win, 'left');
    await dragLook(win, surface(win, 'left'), -150);
    await expect.poll(() => yaw(win, 'left')).not.toBe(leftYaw);
    expect(await yaw(win, 'right')).toBe(rightYaw);

    // 3. the right picker: Panoramas of 4 Sep, paired again
    await choosePane(win, 'right', 'pano', 'sep');
    await expect(pane(win, 'right')).toHaveAttribute('data-capture', 'sep');
    await expect(pane(win, 'right')).toHaveAttribute('data-pano', 'pano-sep/p1');
    await expect(pane(win, 'left')).toHaveAttribute('data-pano', 'pano-nov/p1');

    // 4. Next on the left steps, and the right follows
    const next = pane(win, 'left').getByRole('button', { name: 'Next panorama' });
    await next.click();
    await expect(pane(win, 'left')).toHaveAttribute('data-pano', 'pano-nov/p2');
    await expect(pane(win, 'right')).toHaveAttribute('data-pano', 'pano-sep/p2');
    // the third (60 m east) has no panorama of 4 Sep within 25 m: the right says so
    await next.click();
    await expect(pane(win, 'left')).toHaveAttribute('data-pano', 'pano-nov/p3');
    await expect(pane(win, 'right')).toHaveAttribute('data-pano', '');
    await expect(pane(win, 'right')).toContainText('No panorama of 4 Sep 2024 within 25 m');
    const nearest = pane(win, 'right').getByRole('button', { name: /^Show the nearest/ });
    await expect(nearest).toHaveText('Show the nearest (40 m)');
    await nearest.click();
    await expect(pane(win, 'right')).toHaveAttribute('data-pano', 'pano-sep/p3');

    // 5. the date bar's previous date: the left moves to 2 Oct, at the panorama nearest its spot
    await win.getByTestId('date-bar-prev').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await expect(pane(win, 'left')).toHaveAttribute('data-capture', 'oct');
    await expect(pane(win, 'left')).toHaveAttribute('data-pano', 'pano-oct/p3');
    await expect(pane(win, 'right')).toHaveAttribute('data-capture', 'sep');
  });

  test('Compare with on a date folder, from the 3D view, opens two 3D views', async ({
    panoProject,
    win,
  }) => {
    await openPanoDates(win, panoProject.id);
    await expect(win.locator('[data-scene-view] canvas')).toHaveCount(1, { timeout: 30_000 });
    await expect(stageView(win, '3D')).toHaveAttribute('aria-pressed', 'true');
    // a software GPU is the Low tier, where a comparison draws two maps by design: pin Medium
    await win.evaluate(() => {
      const g = (window as unknown as Probe).__stratlas.graphics().getState();
      if (g.tier === 'low') g.setOverride('medium');
    });
    await compareFolder(win, 'oct', 'nov');
    await expect(stageView(win, 'Split')).toHaveAttribute('aria-pressed', 'true');
    await expect(win.locator('[data-scene-view] canvas')).toHaveCount(2, { timeout: 30_000 });
    await expect(win.getByTestId('pane-select-left')).toHaveValue('3d@oct');
    await expect(win.getByTestId('pane-select-right')).toHaveValue('3d@nov');
  });

  test('the split, both dates and the left panorama survive reopening the project', async ({
    panoProject,
    win,
  }) => {
    await openPanoDates(win, panoProject.id);
    await compareNovWithOct(win);
    await pane(win, 'left').getByRole('button', { name: 'Next panorama' }).click();
    await expect(pane(win, 'left')).toHaveAttribute('data-pano', 'pano-nov/p2');

    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await openPanoDates(win, panoProject.id);
    const split = stageView(win, 'Split');
    if ((await split.getAttribute('aria-pressed')) !== 'true') await split.click();
    await expect(split).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByTestId('pane-pano')).toHaveCount(2);
    await expect(pane(win, 'left')).toHaveAttribute('data-capture', 'nov');
    await expect(pane(win, 'right')).toHaveAttribute('data-capture', 'oct');
    await expect(pane(win, 'left')).toHaveAttribute('data-pano', 'pano-nov/p2');
    await expect(pane(win, 'right')).toHaveAttribute('data-pano', 'pano-oct/p2');
  });
});

test.describe('panoramas of two dates in the smallest window', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

  test('the pane bar and the picker leave the centre of each view free', async ({
    panoProject,
    win,
  }) => {
    await openPanoDates(win, panoProject.id);
    await compareNovWithOct(win);
    for (const side of ['left', 'right'] as const) {
      await expect(surface(win, side).locator('canvas')).toHaveCount(1);
      const box = await pane(win, side).boundingBox();
      if (!box) throw new Error(`the ${side} panorama view is not on screen`);
      const hit = await win.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el ? el.tagName.toLowerCase() : null;
        },
        [box.x + box.width / 2, box.y + box.height / 2] as const,
      );
      expect(hit, `the centre of the ${side} pane`).toBe('canvas');
    }
  });
});
