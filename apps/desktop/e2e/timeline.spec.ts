/**
 * The survey-date timeline in the real app: the sidebar groups datasets by survey date, the date
 * bar and calendar move the focus, Alt+Left and Alt+Right step it, and the focus survives a reopen.
 * Runs on `e2e-three-dates` (4 Sep, 2 Oct, 6 Nov 2024; a model and a site outline per date and
 * one undated layer). Off-screen, zero network.
 *
 * The date folders are edited too: a dataset dragged onto another date folder is filed under that
 * date, and a folder's right-click menu renames it and picks its colour and icon. All of it is in
 * the manifest only, survives a reopen, and leaves the layers' files as they were.
 */
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test as base, tinyManifest, type DataRoot } from './fixtures';

/**
 * The tiny fixture project with its one capture removed, written before the app starts (list
 * `undatedProject` before `win`).
 */
const test = base.extend<{ undatedProject: { id: string } }>({
  undatedProject: async ({ dataRoot }, use) => {
    const manifest = { ...tinyManifest(), captures: [] };
    await writeFile(join(dataRoot.projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await use({ id: dataRoot.projectId });
  },
});

interface Probe {
  __stratlas: {
    workspace: { getState(): { hidden: Record<string, true> } };
  };
}

async function open(win: Page, name: string, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
}

const openThreeDates = (win: Page, id: string) => open(win, 'E2E three dates', id);

/** Ids of the layers the store holds hidden, sorted. */
const hidden = (win: Page) =>
  win.evaluate(() =>
    Object.keys((window as unknown as Probe).__stratlas.workspace.getState().hidden).sort(),
  );

interface SavedManifest {
  captures: { id: string; label: string; date: string; colour?: number; icon?: string }[];
  layers: { id: string; capture?: string }[];
}

const projectDir = (dataRoot: DataRoot, id: string) => join(dataRoot.root, 'projects', id);

/** The project's manifest as it is on disk now. */
async function savedManifest(dataRoot: DataRoot, id: string): Promise<SavedManifest> {
  const text = await readFile(join(projectDir(dataRoot, id), 'manifest.json'), 'utf8');
  return JSON.parse(text) as SavedManifest;
}

/** SHA-256 of every file under the project's data folders (the layers' own files). */
async function dataHashes(dataRoot: DataRoot, id: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const folder of ['models', 'vectors']) {
    const dir = join(projectDir(dataRoot, id), folder);
    for (const name of (await readdir(dir)).sort()) {
      out[`${folder}/${name}`] = createHash('sha256')
        .update(await readFile(join(dir, name)))
        .digest('hex');
    }
  }
  return out;
}

/** Reload the window and open the three-date project again. */
async function reopen(win: Page, id: string) {
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openThreeDates(win, id);
}

/** Open a closed date folder with its arrow, without moving the focus to it. */
async function expand(win: Page, folder: string) {
  const f = win.getByTestId(`date-folder-${folder}`);
  if ((await f.getAttribute('aria-expanded')) !== 'true')
    await f.getByRole('button', { name: /^Expand/ }).click();
  await expect(f).toHaveAttribute('aria-expanded', 'true');
}

test.describe('survey date timeline', () => {
  test('opens on the latest date with other dates hidden', async ({ threeDateProject, win }) => {
    await openThreeDates(win, threeDateProject.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('6 Nov 2024');
    await expect(win.getByTestId('date-folder-nov')).toHaveAttribute('aria-expanded', 'true');
    await expect(win.getByTestId('date-folder-oct')).toHaveAttribute('aria-expanded', 'false');
    expect(await hidden(win)).toEqual(['quad-oct', 'quad-sep', 'site-oct', 'site-sep']);
  });

  test('calendar jump swaps dates and keeps an extra', async ({ threeDateProject, win }) => {
    await openThreeDates(win, threeDateProject.id);
    // Turn on the September model by hand: expand Sep without focusing, use its eye.
    await win
      .getByTestId('date-folder-sep')
      .getByRole('button', { name: /Expand/ })
      .click();
    await win
      .getByTestId('date-folder-sep')
      .locator('.titem', { hasText: 'Quad' })
      .locator('.eye')
      .click();
    await win.getByTestId('date-bar-open').click();
    await win.getByTestId('cal-prev').click(); // November -> October
    await win.getByTestId('cal-day-2024-10-02').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await expect(win.getByTestId('date-folder-oct')).toHaveAttribute('aria-expanded', 'true');
    await expect(win.getByTestId('date-on-sep')).toHaveText('1 on');
    expect(await hidden(win)).toEqual(['quad-nov', 'site-nov', 'site-sep']);
  });

  test('Alt+Left and Alt+Right step dates', async ({ threeDateProject, win }) => {
    await openThreeDates(win, threeDateProject.id);
    await win.keyboard.press('Alt+ArrowLeft');
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await win.keyboard.press('Alt+ArrowRight');
    await expect(win.getByTestId('date-bar-open')).toContainText('6 Nov 2024');
  });

  test('focus survives reopening the project', async ({ threeDateProject, win }) => {
    await openThreeDates(win, threeDateProject.id);
    await win.getByTestId('date-name-sep').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await openThreeDates(win, threeDateProject.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
  });

  test('a project without captures keeps the type-first tree and no date bar', async ({
    undatedProject,
    win,
  }) => {
    await open(win, 'E2E tiny project', undatedProject.id);
    await expect(win.locator('.titem').first()).toBeVisible();
    await expect(win.locator('[data-testid^="date-folder-"]')).toHaveCount(0);
    await expect(win.getByTestId('date-bar')).toHaveCount(0);
  });
});

test.describe('survey date folders', () => {
  test('a dataset dragged onto another date folder is filed there, files untouched', async ({
    dataRoot,
    threeDateProject,
    win,
  }) => {
    const id = threeDateProject.id;
    await openThreeDates(win, id);
    const before = await savedManifest(dataRoot, id);
    const files = await dataHashes(dataRoot, id);
    const nov = win.getByTestId('date-folder-nov');
    const oct = win.getByTestId('date-folder-oct');
    await expect(nov.getByTestId('tree-row-quad-nov')).toBeVisible();

    // onto the folder it is already in: nothing is written
    await nov.getByTestId('tree-row-quad-nov').dragTo(win.getByTestId('date-name-nov'));
    await expect(nov.getByTestId('tree-row-quad-nov')).toBeVisible();
    expect(await savedManifest(dataRoot, id)).toEqual(before);

    // the November model onto the October folder
    await nov.getByTestId('tree-row-quad-nov').dragTo(win.getByTestId('date-name-oct'));
    await expect(nov.getByTestId('tree-row-quad-nov')).toHaveCount(0);
    await expand(win, 'oct');
    await expect(oct.getByTestId('tree-row-quad-nov')).toBeVisible();
    await expect(oct.getByTestId('tree-row-quad-oct')).toBeVisible();

    // the undated outline onto the October folder as well
    await win
      .getByTestId('date-folder-every')
      .getByTestId('tree-row-design')
      .dragTo(win.getByTestId('date-name-oct'));
    await expect(oct.getByTestId('tree-row-design')).toBeVisible();

    // on disk: only the two layers' `capture` changed, and no data file was touched
    const after = await savedManifest(dataRoot, id);
    const moved = (m: SavedManifest) =>
      Object.fromEntries(m.layers.map((l) => [l.id, l.capture ?? null]));
    expect(moved(after)).toEqual({ ...moved(before), 'quad-nov': 'oct', design: 'oct' });
    const strip = (m: SavedManifest) => ({
      ...m,
      layers: m.layers.map((l) => ({ ...l, capture: undefined })),
    });
    expect(strip(after)).toEqual(strip(before));
    expect(await dataHashes(dataRoot, id)).toEqual(files);

    // and it is still there after the project is opened again
    await reopen(win, id);
    await expand(win, 'oct');
    await expect(win.getByTestId('date-folder-oct').getByTestId('tree-row-quad-nov')).toBeVisible();
    await expect(win.getByTestId('date-folder-oct').getByTestId('tree-row-design')).toBeVisible();
    await expect(win.getByTestId('date-folder-every')).toHaveCount(0);
  });

  test('Every date takes the date off, unless the name carries one', async ({
    dataRoot,
    threeDateProject,
    win,
  }) => {
    const id = threeDateProject.id;
    await openThreeDates(win, id);
    const every = win.getByTestId('date-folder-every');
    const nov = win.getByTestId('date-folder-nov');
    const sep = win.getByTestId('date-folder-sep');
    const design = async () =>
      (await savedManifest(dataRoot, id)).layers.find((l) => l.id === 'design');
    // file the undated outline under November
    await every.getByTestId('tree-row-design').dragTo(win.getByTestId('date-name-nov'));
    await expect(nov.getByTestId('tree-row-design')).toBeVisible();
    expect(await design()).toMatchObject({ capture: 'nov' });

    // every dataset is dated now, so the Every date folder is gone: it comes back as a drop
    // place while a row is dragged (by hand here, as the place only shows during the drag)
    await expect(every).toHaveCount(0);
    await nov.getByTestId('tree-row-design').hover();
    await win.mouse.down();
    await win.getByTestId('date-name-oct').hover();
    await expect(every).toBeVisible();
    await expect(every).toContainText('Drop for no date');
    await every.hover();
    await every.hover();
    await win.mouse.up();
    await expect(every.getByTestId('tree-row-design')).toBeVisible();
    expect(await design()).not.toHaveProperty('capture');

    // the same move without dragging: the row's menu
    await every.getByTestId('tree-row-design').click({ button: 'right' });
    await expect(win.getByTestId('move-menu')).toBeVisible();
    await expect(win.getByTestId('move-to-every')).toBeDisabled();
    await win.getByTestId('move-to-sep').click();
    await expand(win, 'sep');
    await expect(sep.getByTestId('tree-row-design')).toBeVisible();
    expect(await design()).toMatchObject({ capture: 'sep' });
    await sep.getByTestId('tree-row-design').click({ button: 'right' });
    await win.getByTestId('move-to-every').click();
    await expect(every.getByTestId('tree-row-design')).toBeVisible();
    expect(await design()).not.toHaveProperty('capture');

    // "Quad 2024-09-04" names its date: it stays under 4 Sep, and the list says why
    await sep.getByTestId('tree-row-quad-sep').click({ button: 'right' });
    await win.getByTestId('move-to-every').click();
    await expect(win.getByTestId('date-note')).toContainText('4 Sep 2024');
    await expect(sep.getByTestId('tree-row-quad-sep')).toBeVisible();
    await expect(every.getByTestId('tree-row-quad-sep')).toHaveCount(0);
  });

  test('a folder is renamed, coloured and given an icon from its menu, and it sticks', async ({
    dataRoot,
    threeDateProject,
    win,
  }) => {
    const id = threeDateProject.id;
    await openThreeDates(win, id);
    const before = await savedManifest(dataRoot, id);
    const files = await dataHashes(dataRoot, id);
    const oct = win.getByTestId('date-folder-oct');

    // rename: right-click, Rename, type, Enter
    await oct.locator('.dfolder-row').click({ button: 'right' });
    await expect(win.getByTestId('date-menu')).toBeVisible();
    await win.getByTestId('date-menu-rename').click();
    const field = win.getByTestId('date-rename');
    await expect(field).toBeFocused();
    await field.fill('Baseline');
    await field.press('Enter');
    await expect(win.getByTestId('date-name-oct')).toContainText('2 Oct 2024');
    await expect(win.getByTestId('date-name-oct')).toContainText('Baseline');

    // colour and icon: the "more" button opens the same menu; picks keep it open
    await oct.hover();
    await win.getByTestId('date-more-oct').click();
    await win.getByTestId('date-menu-colour-5').click();
    await expect(oct).toHaveAttribute('style', /--date-5/);
    await expect(win.getByTestId('date-menu-colour-5')).toHaveAttribute('aria-checked', 'true');
    await win.getByTestId('date-menu-icon-flag').click();
    await expect(win.getByTestId('date-name-oct').locator('svg.dicon')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('date-menu')).toHaveCount(0);

    // the same colour everywhere: the date bar of the viewed date
    await win.getByTestId('date-name-oct').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await expect(win.getByTestId('date-bar-open').locator('.dtag')).toHaveAttribute(
      'style',
      /--date-5/,
    );

    // on disk: the one captures entry, nothing else
    const after = await savedManifest(dataRoot, id);
    expect(after.captures.find((c) => c.id === 'oct')).toEqual({
      id: 'oct',
      label: 'Baseline',
      date: '2024-10-02',
      colour: 5,
      icon: 'flag',
    });
    expect({ ...after, captures: after.captures.filter((c) => c.id !== 'oct') }).toEqual({
      ...before,
      captures: before.captures.filter((c) => c.id !== 'oct'),
    });
    expect(await dataHashes(dataRoot, id)).toEqual(files);

    // after the project is opened again
    await reopen(win, id);
    const again = win.getByTestId('date-folder-oct');
    await expect(win.getByTestId('date-name-oct')).toContainText('Baseline');
    await expect(again).toHaveAttribute('style', /--date-5/);
    await expect(win.getByTestId('date-name-oct').locator('svg.dicon')).toBeVisible();

    // reset: back to the colour of its place in date order (the second date), no icon
    await again.locator('.dfolder-row').click({ button: 'right' });
    await win.getByTestId('date-menu-reset').click();
    await expect(again).toHaveAttribute('style', /--date-2/);
    await expect(win.getByTestId('date-name-oct').locator('svg.dicon')).toHaveCount(0);
    expect((await savedManifest(dataRoot, id)).captures.find((c) => c.id === 'oct')).toEqual({
      id: 'oct',
      label: 'Baseline',
      date: '2024-10-02',
    });
  });
});
