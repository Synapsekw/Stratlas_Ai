/**
 * Folders on the Projects screen: one level of folders, kept per computer in userData
 * `library-view.json`. A card is dragged onto a folder tile with real mouse input (the card is a
 * draggable wrapper around buttons, so this is the check that Chromium starts the drag at all),
 * moved from its menu, found by search, and the folder is deleted without touching a project.
 */
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import {
  expect,
  launchApp,
  NetworkGuard,
  test,
  tinyGlb,
  tinyManifest,
  type DataRoot,
} from './fixtures';

const YARD_ID = 'throwaway-yard';
const TINY = 'E2E tiny project';
const YARD = 'Throwaway yard';

/** A second small project beside `e2e-tiny`. */
async function writeYard(dataRoot: DataRoot): Promise<string> {
  const dir = join(dataRoot.root, 'projects', YARD_ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...tinyManifest(), id: YARD_ID, name: YARD }, null, 2),
  );
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  return dir;
}

async function start(dataRoot: DataRoot) {
  const app = await launchApp(dataRoot);
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, network };
}

/** Start with a folder `Site A` already in the library (and nothing in it). */
async function seedFolder(dataRoot: DataRoot, placed: Record<string, string> = {}) {
  await writeFile(
    join(dataRoot.userData, 'library-view.json'),
    JSON.stringify({
      schema: 'aio.library-view/1',
      hidden: [],
      folders: [{ id: 'f_0123456789', name: 'Site A' }],
      placed,
    }),
  );
}

const card = (win: Page, name: string) => win.getByTestId('project-card').filter({ hasText: name });
const tiles = (win: Page) => win.getByTestId('folder-tile');
const tile = (win: Page, name: string) => tiles(win).filter({ hasText: name });
const place = (win: Page) => win.getByTestId('library-place');

async function newFolder(win: Page, name: string): Promise<void> {
  await win.getByTestId('library-new-folder').click();
  await win.getByTestId('folder-name').fill(name);
  await win.getByTestId('folder-name-confirm').click();
  await expect(tile(win, name)).toBeVisible();
}

/** Move a card from its menu. `to` is a folder name or 'No folder'. */
async function moveFromMenu(win: Page, project: string, to: string): Promise<void> {
  await win.getByRole('button', { name: `Actions for ${project}` }).click();
  await win.getByTestId('project-menu-move').click();
  const dialog = win.getByTestId('move-folder-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('move-folder-option').filter({ hasText: to }).click();
  await win.getByTestId('move-folder-confirm').click();
  await expect(dialog).toBeHidden();
}

const viewFile = async (dataRoot: DataRoot) =>
  JSON.parse(await readFile(join(dataRoot.userData, 'library-view.json'), 'utf8')) as {
    folders: { id: string; name: string }[];
    placed: Record<string, string>;
  };

test('make a folder, drag a card onto it, open it, go back, and the counts follow', async ({
  dataRoot,
}) => {
  test.setTimeout(120_000);
  await writeYard(dataRoot);
  const run = await start(dataRoot);
  try {
    const { win } = run;
    await expect(win.getByTestId('project-card')).toHaveCount(2);
    await expect(tiles(win)).toHaveCount(0);

    await newFolder(win, 'Site A');
    await expect(tile(win, 'Site A')).toHaveAttribute('aria-label', 'Site A, 0 projects');

    // a real drag: mouse down on the first card, move, release over the tile. The tile row and
    // the card are both in view at the top of the page; scrolling between the mouse down and the
    // move would make Chromium pick the card that has slid under the pointer instead.
    const mover =
      (await win.getByTestId('project-card').first().locator('.pc-name').textContent()) ?? '';
    expect([TINY, YARD]).toContain(mover);
    const stayer = mover === YARD ? TINY : YARD;
    await card(win, mover).dragTo(tile(win, 'Site A'));

    await expect(tile(win, 'Site A')).toHaveAttribute('aria-label', 'Site A, 1 project');
    await expect(win.getByTestId('project-card')).toHaveCount(1);
    await expect(card(win, mover)).toHaveCount(0);
    await expect(card(win, stayer)).toBeVisible();
    await expectAccessible(win, 'Project library with folders');

    // open the folder: only its project, with the folder name as the heading
    await tile(win, 'Site A').click();
    await expect(place(win)).toContainText('Site A');
    await expect(win.getByTestId('project-card')).toHaveCount(1);
    await expect(card(win, mover)).toBeVisible();
    await expect(tiles(win)).toHaveCount(0);

    // back to All projects: the loose card is back, the tile still counts one
    await win.getByTestId('folder-back').click();
    await expect(tile(win, 'Site A')).toHaveAttribute('aria-label', 'Site A, 1 project');
    await expect(card(win, stayer)).toBeVisible();
    await expect(card(win, mover)).toHaveCount(0);

    // dragging a card out again: into the folder's page, onto the back link
    await tile(win, 'Site A').click();
    await card(win, mover).dragTo(win.getByTestId('folder-back'));
    await expect(win.getByTestId('folder-empty')).toBeVisible();
    await win.getByTestId('folder-back').click();
    await expect(win.getByTestId('project-card')).toHaveCount(2);
    await expect(tile(win, 'Site A')).toHaveAttribute('aria-label', 'Site A, 0 projects');

    expect(await run.network.outbound()).toEqual([]);
  } finally {
    await run.app.close();
  }
});

test('Move to folder and No folder from the card menu', async ({ dataRoot }) => {
  await writeYard(dataRoot);
  await seedFolder(dataRoot);
  const run = await start(dataRoot);
  try {
    const { win } = run;
    await expect(tile(win, 'Site A')).toHaveAttribute('aria-label', 'Site A, 0 projects');

    await moveFromMenu(win, YARD, 'Site A');
    await expect(card(win, YARD)).toHaveCount(0);
    await expect(tile(win, 'Site A')).toHaveAttribute('aria-label', 'Site A, 1 project');
    expect(Object.values((await viewFile(dataRoot)).placed)).toEqual(['f_0123456789']);

    await tile(win, 'Site A').click();
    await expect(card(win, YARD)).toBeVisible();
    await moveFromMenu(win, YARD, 'No folder');
    await expect(win.getByTestId('folder-empty')).toBeVisible();
    await win.getByTestId('folder-back').click();
    await expect(card(win, YARD)).toBeVisible();
    await expect(tile(win, 'Site A')).toHaveAttribute('aria-label', 'Site A, 0 projects');
    expect((await viewFile(dataRoot)).placed).toEqual({});
  } finally {
    await run.app.close();
  }
});

test('a search finds a card inside a folder', async ({ dataRoot }) => {
  await writeYard(dataRoot);
  await seedFolder(dataRoot);
  const run = await start(dataRoot);
  try {
    const { win } = run;
    await moveFromMenu(win, YARD, 'Site A');
    await expect(card(win, YARD)).toHaveCount(0);

    await win.getByRole('searchbox', { name: 'Filter projects' }).fill('yard');
    await expect(card(win, YARD)).toBeVisible();
    await expect(win.getByTestId('project-card')).toHaveCount(1);
    await expect(card(win, YARD).getByTestId('card-folder')).toHaveText('Site A');
    // the tiles step aside while searching
    await expect(tiles(win)).toHaveCount(0);

    await win.getByRole('searchbox', { name: 'Filter projects' }).fill('');
    await expect(card(win, YARD)).toHaveCount(0);
    await expect(tile(win, 'Site A')).toBeVisible();
  } finally {
    await run.app.close();
  }
});

test('deleting a folder leaves its projects in the library and their folders on disk', async ({
  dataRoot,
}) => {
  const yardDir = await writeYard(dataRoot);
  await seedFolder(dataRoot);
  const run = await start(dataRoot);
  try {
    const { win } = run;
    await moveFromMenu(win, YARD, 'Site A');
    await expect(card(win, YARD)).toHaveCount(0);

    await tile(win, 'Site A').click({ button: 'right' });
    await win.getByTestId('folder-menu-delete').click();
    const dialog = win.getByTestId('folder-delete-dialog');
    await expect(dialog).toContainText('stay in the library without a folder');
    await expect(dialog).toContainText('No file is touched');
    await win.getByTestId('folder-delete-confirm').click();
    await expect(dialog).toBeHidden();

    await expect(tiles(win)).toHaveCount(0);
    await expect(win.getByTestId('project-card')).toHaveCount(2);
    await expect(card(win, YARD)).toBeVisible();
    await expect(card(win, YARD).getByTestId('card-folder')).toHaveCount(0);
    expect(existsSync(join(yardDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(dataRoot.projectDir, 'manifest.json'))).toBe(true);
    const view = await viewFile(dataRoot);
    expect(view.folders).toEqual([]);
    expect(view.placed).toEqual({});
  } finally {
    await run.app.close();
  }
});

test('folders survive a restart', async ({ dataRoot }) => {
  test.setTimeout(120_000);
  await writeYard(dataRoot);
  let run = await start(dataRoot);
  try {
    await newFolder(run.win, 'Site A');
    await moveFromMenu(run.win, YARD, 'Site A');
    await expect(tile(run.win, 'Site A')).toHaveAttribute('aria-label', 'Site A, 1 project');
  } finally {
    await run.app.close();
  }

  run = await start(dataRoot);
  try {
    const { win } = run;
    await expect(tile(win, 'Site A')).toHaveAttribute('aria-label', 'Site A, 1 project');
    await expect(card(win, YARD)).toHaveCount(0);
    await expect(card(win, TINY)).toBeVisible();
    await tile(win, 'Site A').click();
    await expect(card(win, YARD)).toBeVisible();
    expect(await run.network.outbound()).toEqual([]);
  } finally {
    await run.app.close();
  }
});
