/**
 * The menu of one project on the Projects screen (three dots on its card, or right-click): Open,
 * Rename, Show in folder, Delete. Runs on a throwaway project in a temporary data root.
 *
 * The file manager and the recycle bin are stood in for in the main process: Show in folder only
 * records the path (no Explorer window opens during a test run), and the recycle bin is a folder
 * beside the data root, so the test can see that the project was moved there whole, not erased.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import {
  expect,
  launchApp,
  NetworkGuard,
  openProject,
  test,
  tinyGlb,
  tinyManifest,
  type DataRoot,
} from './fixtures';

const YARD_ID = 'throwaway-yard';

/** A second small project beside `e2e-tiny`, the one the test renames and deletes. */
async function writeYard(dataRoot: DataRoot): Promise<string> {
  const dir = join(dataRoot.root, 'projects', YARD_ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...tinyManifest(), id: YARD_ID, name: 'Throwaway yard' }, null, 2),
  );
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  return dir;
}

interface Seen {
  __e2eRevealed?: string[];
  __e2eTrashed?: string[];
}

/** Launch on `dataRoot` with the file manager and the recycle bin stood in for (see above). */
async function start(dataRoot: DataRoot, bin: string) {
  const app = await launchApp(dataRoot);
  const network = new NetworkGuard();
  await network.attach(app);
  await app.evaluate(({ shell }, binDir) => {
    const seen = globalThis as Seen;
    seen.__e2eRevealed = [];
    seen.__e2eTrashed = [];
    shell.showItemInFolder = (p: string) => {
      seen.__e2eRevealed?.push(p);
    };
    shell.trashItem = async (p: string) => {
      const fs = process.getBuiltinModule('node:fs');
      const path = process.getBuiltinModule('node:path');
      await fs.promises.mkdir(binDir, { recursive: true });
      // a move, as the recycle bin does it: refused while a file inside is held open
      await fs.promises.rename(p, path.join(binDir, path.basename(p)));
      seen.__e2eTrashed?.push(p);
    };
  }, bin);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, network };
}

const seenIn = (app: ElectronApplication, what: keyof Seen) =>
  app.evaluate((_e, k) => (globalThis as Seen)[k]?.slice() ?? [], what);

const card = (win: Page, name: string) => win.getByTestId('project-card').filter({ hasText: name });
const dots = (win: Page, name: string) => win.getByRole('button', { name: `Actions for ${name}` });
const menu = (win: Page) => win.getByTestId('project-menu');
const manifestName = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { name: string }).name;

/**
 * Where a card and its dots are, with the card scrolled into view first: in a small window (CI
 * runs at the minimum, 1100 x 700) the library is one column and the second card starts below
 * the fold, where `elementFromPoint` finds nothing.
 */
async function cardLayout(win: Page, name: string) {
  await card(win, name).scrollIntoViewIfNeeded();
  return card(win, name).evaluate((el) => {
    const c = el.getBoundingClientRect();
    const more = el.parentElement?.querySelector('.pc-more');
    const b = more?.getBoundingClientRect();
    const mid = { x: c.left + c.width / 2, y: c.top + c.height / 2 };
    const apart = (r: DOMRect | undefined) =>
      b === undefined ||
      r === undefined ||
      r.right <= b.left ||
      r.left >= b.right ||
      r.bottom <= b.top ||
      r.top >= b.bottom;
    const onDots = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
    return {
      middleInView:
        mid.x >= 0 && mid.x < window.innerWidth && mid.y >= 0 && mid.y < window.innerHeight,
      // the card itself or something inside it (its picture, its name)
      middleIsCard: el.contains(document.elementFromPoint(mid.x, mid.y)),
      dotsOnTop: more?.contains(onDots) === true,
      dotsInsideCard:
        b !== undefined &&
        b.left >= c.left &&
        b.right <= c.right &&
        b.top >= c.top &&
        b.bottom <= c.bottom,
      dotsClearOfText: ['.pc-kind', '.pc-name', '.pc-date', '.pc-where', '.pc-size'].every((q) =>
        apart(el.querySelector(q)?.getBoundingClientRect()),
      ),
      dotsClearOfOtherCards: [...document.querySelectorAll('[data-testid="project-card"]')]
        .filter((other) => other !== el)
        .every((other) => apart(other.getBoundingClientRect())),
    };
  });
}

test('a project card has a menu: rename keeps after a restart, delete moves the folder away', async ({
  dataRoot,
}) => {
  test.setTimeout(180_000);
  const yardDir = await writeYard(dataRoot);
  const bin = join(dataRoot.base, 'recycle-bin');

  // ---------------------------------------------------------------- first run: menu and rename
  let run = await start(dataRoot, bin);
  try {
    const { app, win } = run;
    await expect(win.getByTestId('project-card')).toHaveCount(2);
    await expect(card(win, 'Throwaway yard')).toBeVisible();

    // every card has its own dots, named after its project
    const more = dots(win, 'Throwaway yard');
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(dots(win, 'E2E tiny project')).toBeVisible();
    // the dots are not part of the card's own text: the specs that find a card by name still do
    await expect(card(win, 'Throwaway yard')).not.toContainText('Actions');
    // they sit in the corner of their own card and cover nothing else, whatever the window size
    for (const name of ['E2E tiny project', 'Throwaway yard'])
      expect(await cardLayout(win, name), name).toEqual({
        middleInView: true,
        middleIsCard: true,
        dotsOnTop: true,
        dotsInsideCard: true,
        dotsClearOfText: true,
        dotsClearOfOtherCards: true,
      });
    await expectAccessible(win, 'Projects with the card menus');

    // keyboard: Enter opens with focus on the first item, arrows move, Escape closes and returns
    await more.focus();
    await win.keyboard.press('Enter');
    await expect(menu(win)).toBeVisible();
    await expect(menu(win)).toHaveAttribute('aria-label', 'Project Throwaway yard');
    await expect(win.getByTestId('project-menu-open')).toBeFocused();
    await win.keyboard.press('ArrowDown');
    await expect(win.getByTestId('project-menu-rename')).toBeFocused();
    await win.keyboard.press('ArrowUp');
    await win.keyboard.press('ArrowUp');
    await expect(win.getByTestId('project-menu-delete')).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(menu(win)).toBeHidden();
    await expect(more).toBeFocused();
    await more.focus();
    await win.keyboard.press('Space');
    await expect(menu(win)).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(menu(win)).toBeHidden();

    // a click on the dots opens the menu, never the project
    await more.click();
    await expect(menu(win)).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(menu(win).getByRole('menuitem')).toHaveText([
      'Open',
      'Rename',
      'Show in folder',
      'Delete',
    ]);
    expect((await openProject(win)).id).toBeNull();
    await expectAccessible(win, 'Project menu');

    // Show in folder: main is asked for this project's own folder
    await win.getByTestId('project-menu-reveal').click();
    await expect(menu(win)).toBeHidden();
    await expect.poll(() => seenIn(app, '__e2eRevealed')).toEqual([yardDir]);

    // Rename: the name in the app changes, the folder on disk keeps its name
    await more.click();
    await win.getByTestId('project-menu-rename').click();
    const rename = win.getByRole('dialog', { name: 'Rename project' });
    await expect(rename).toBeVisible();
    const field = rename.getByLabel('Project name');
    await expect(field).toHaveValue('Throwaway yard');
    await expect(field).toBeFocused();
    await expect(rename).toContainText(`The folder on disk keeps its name: ${YARD_ID}`);
    await expectAccessible(win, 'Rename project');
    await field.fill('Renamed yard');
    await win.keyboard.press('Enter');
    await expect(rename).toBeHidden();
    await expect(card(win, 'Renamed yard')).toBeVisible();
    await expect(card(win, 'Throwaway yard')).toHaveCount(0);
    await expect(win.getByTestId('project-card')).toHaveCount(2);
    expect(await manifestName(yardDir)).toBe('Renamed yard');
    expect(await manifestName(join(yardDir, '..', 'e2e-tiny'))).toBe('E2E tiny project');
    // the previous manifest is kept beside the new one
    expect(
      (JSON.parse(await readFile(join(yardDir, 'manifest.json.bak'), 'utf8')) as { name: string })
        .name,
    ).toBe('Throwaway yard');
    expect(await run.network.outbound()).toEqual([]);
  } finally {
    await run.app.close();
  }

  // ---------------------------------------------------------------- second run: it kept
  run = await start(dataRoot, bin);
  try {
    const { app, win } = run;
    await expect(card(win, 'Renamed yard')).toBeVisible();
    await expect(card(win, 'Throwaway yard')).toHaveCount(0);

    // a plain click on the card still opens the project
    await card(win, 'Renamed yard').click();
    await expect(win.locator('.crumbs')).toContainText('Renamed yard');
    expect((await openProject(win)).id).toBe(YARD_ID);
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
    await expect(card(win, 'Renamed yard')).toContainText('Open');

    // right-click opens the same menu; on the open project it adds two actions and holds Delete
    await card(win, 'Renamed yard').click({ button: 'right' });
    await expect(menu(win)).toBeVisible();
    expect((await openProject(win)).id).toBe(YARD_ID);
    await expect(win.getByTestId('project-menu-export')).toBeVisible();
    await expect(win.getByTestId('project-menu-close')).toBeVisible();
    const del = win.getByTestId('project-menu-delete');
    await expect(del).toHaveAttribute('aria-disabled', 'true');
    await expect(del).toContainText('Close the project first');
    // (forced: Playwright itself will not click an item marked disabled)
    await del.click({ force: true });
    await expect(win.getByRole('alertdialog')).toHaveCount(0);
    await expect(menu(win)).toBeVisible();
    await expectAccessible(win, 'Project menu of the open project');

    // renaming the open project shows at once in the sidebar
    await win.getByTestId('project-menu-rename').click();
    const rename = win.getByRole('dialog', { name: 'Rename project' });
    await rename.getByLabel('Project name').fill('Yard to delete');
    await rename.getByRole('button', { name: 'Rename' }).click();
    await expect(rename).toBeHidden();
    await expect(win.locator('.proj-switch b')).toHaveText('Yard to delete');
    await expect(card(win, 'Yard to delete')).toBeVisible();
    expect(await manifestName(yardDir)).toBe('Yard to delete');

    // close it from its menu, then delete it
    await dots(win, 'Yard to delete').click();
    await win.getByTestId('project-menu-close').click();
    await expect.poll(async () => (await openProject(win)).id).toBeNull();
    await expect(card(win, 'Yard to delete')).not.toContainText('Open');

    await dots(win, 'Yard to delete').click();
    await win.getByTestId('project-menu-delete').click();
    const confirm = win.getByRole('alertdialog', { name: 'Delete Yard to delete?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('moves to the recycle bin');
    await expect(confirm).toContainText(yardDir);
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expectAccessible(win, 'Delete project');

    // Cancel deletes nothing
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    expect(existsSync(yardDir)).toBe(true);
    expect(await seenIn(app, '__e2eTrashed')).toEqual([]);

    await dots(win, 'Yard to delete').click();
    await win.getByTestId('project-menu-delete').click();
    await confirm.getByRole('button', { name: 'Move to recycle bin' }).click();
    await expect(confirm).toBeHidden();
    await expect(card(win, 'Yard to delete')).toHaveCount(0);
    await expect(win.getByTestId('project-card')).toHaveCount(1);

    // the folder left the data root for the recycle bin, whole; nothing else was touched
    expect(await seenIn(app, '__e2eTrashed')).toEqual([yardDir]);
    expect(existsSync(yardDir)).toBe(false);
    expect(await manifestName(join(bin, YARD_ID))).toBe('Yard to delete');
    expect(existsSync(join(bin, YARD_ID, 'models', 'quad.glb'))).toBe(true);
    expect(existsSync(join(dataRoot.root, 'projects'))).toBe(true);
    expect(existsSync(join(dataRoot.projectDir, 'manifest.json'))).toBe(true);

    // the other card still opens with a plain click
    await card(win, 'E2E tiny project').click();
    await expect(win.locator('.crumbs')).toContainText('E2E tiny project');
    expect((await openProject(win)).id).toBe(dataRoot.projectId);
    expect(await run.network.outbound()).toEqual([]);
  } finally {
    await run.app.close();
  }
});

test('a delete the recycle bin refuses shows the error and keeps the project', async ({
  dataRoot,
}) => {
  const yardDir = await writeYard(dataRoot);
  const run = await start(dataRoot, join(dataRoot.base, 'recycle-bin'));
  try {
    const { app, win } = run;
    await app.evaluate(({ shell }) => {
      shell.trashItem = () => Promise.reject(new Error('The recycle bin is full'));
    });
    await dots(win, 'Throwaway yard').click();
    await win.getByTestId('project-menu-delete').click();
    const confirm = win.getByRole('alertdialog', { name: 'Delete Throwaway yard?' });
    await confirm.getByRole('button', { name: 'Move to recycle bin' }).click();
    const alert = confirm.getByRole('alert');
    await expect(alert).toContainText('The project was not deleted. It is still in the library.');
    await expect(alert).toContainText('The recycle bin is full');
    await expect(alert).toContainText('Nothing was deleted');
    await expectAccessible(win, 'Delete project, refused');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(card(win, 'Throwaway yard')).toBeVisible();
    await expect(win.getByTestId('project-card')).toHaveCount(2);
    expect(existsSync(join(yardDir, 'manifest.json'))).toBe(true);
  } finally {
    await run.app.close();
  }
});
