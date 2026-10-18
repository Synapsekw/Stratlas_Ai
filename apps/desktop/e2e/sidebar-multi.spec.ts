/**
 * Multi-select in Datasets: mark three rows, right-click a marked one: only the actions for
 * several datasets show; Hide hides all three; Move to date moves them. A right-click on an
 * unmarked row acts on that row alone and leaves the marks. Off-screen, zero network.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test } from './fixtures';

interface Probe {
  __stratlas: { workspace: { getState(): { hidden: Record<string, true> } } };
}

/** Which of these layers the store holds hidden, sorted. */
const hiddenOf = (win: Page, ids: string[]) =>
  win.evaluate(
    (ids) =>
      Object.keys((window as unknown as Probe).__stratlas.workspace.getState().hidden)
        .filter((id) => ids.includes(id))
        .sort(),
    ids,
  );

test('three marked rows share one menu: Hide and Move to date act on all three', async ({
  dataRoot,
  threeDateProject,
  win,
}) => {
  const id = threeDateProject.id;
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E three dates' }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);

  // every folder open, so every row is drawn
  const folders = win.locator('[data-testid^="date-folder-"]');
  for (let i = 0; i < (await folders.count()); i++) {
    const f = folders.nth(i);
    if ((await f.getAttribute('aria-expanded')) !== 'true')
      await f.locator('.dchev').first().click();
  }
  await expect(win.locator('[data-testid^="date-folder-"][aria-expanded="false"]')).toHaveCount(0);
  const picked = ['quad-sep', 'site-sep', 'quad-oct'];
  for (const layer of picked)
    // on the names: a row's middle can fall on its eye, which hides instead of marking
    await win
      .getByTestId(`tree-row-${layer}`)
      .locator('.tn')
      .click({ modifiers: ['Control'] });
  await expect(win.locator('.titem.marked')).toHaveCount(3);

  // the menu of a marked row: the three datasets, only what applies to several
  const row = win.getByTestId('tree-row-site-sep');
  await row.click({ button: 'right' });
  const menu = win.getByTestId('move-menu');
  await expect(menu).toContainText('3 datasets');
  await expect(menu.getByTestId('move-to-nov')).toBeVisible();
  await expect(menu.getByTestId('menu-delete')).toBeVisible();
  await expect(menu.getByTestId('ctx-item-layer.rename')).toHaveCount(0);
  await expect(menu.getByTestId('ctx-item-layer.properties')).toHaveCount(0);

  // the two dates off focus start hidden: Show brings all three in, then Hide hides all three
  await menu.getByTestId('ctx-item-layer.show').click();
  await expect.poll(() => hiddenOf(win, picked)).toEqual([]);
  await row.click({ button: 'right' });
  await expect(win.getByTestId('move-menu')).toContainText('3 datasets');
  await win.getByTestId('ctx-item-layer.hide').click();
  await expect.poll(() => hiddenOf(win, picked)).toEqual([...picked].sort());

  // Show brings them back
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-layer.show').click();
  await expect.poll(() => hiddenOf(win, picked)).toEqual([]);

  // Move to date November files all three there and the list says so
  await row.click({ button: 'right' });
  await win.getByTestId('move-to-nov').click();
  const manifest = async () =>
    (
      JSON.parse(await readFile(join(dataRoot.root, 'projects', id, 'manifest.json'), 'utf8')) as {
        layers: { id: string; capture?: string }[];
      }
    ).layers;
  await expect
    .poll(async () => (await manifest()).find((l) => l.id === 'site-sep')?.capture)
    .toBe('nov');
  const layers = await manifest();
  for (const layer of picked) expect(layers.find((l) => l.id === layer)?.capture).toBe('nov');
  await expect(win.getByTestId('date-note')).toContainText('3 datasets moved to 6 Nov 2024');

  // an unmarked row acts on itself alone and leaves the marks
  const marks = await win.locator('.titem.marked').count();
  expect(marks).toBeGreaterThan(1);
  await win.getByTestId('tree-row-design').click({ button: 'right' });
  const own = win.getByTestId('move-menu');
  await expect(own).toContainText('Move to date');
  await expect(own).toContainText('Design');
  await expect(own).not.toContainText('datasets');
  await expect(win.locator('.titem.marked')).toHaveCount(marks);
});
