/**
 * Remove from library and Delete on every kind of card: a project in the data folder, a package, a
 * folder the person added, and a demo. Everything runs in temporary data and profile folders.
 *
 * Remove hides the card on this computer (userData `library-view.json`) and touches no file; it
 * stays hidden after a restart until Add project folder brings it back. Delete moves the folder or
 * file to the recycle bin after a confirm that names the path. The file manager and the recycle bin
 * are stood in for in the main process (as in `project-menu.spec.ts`): the bin is a folder beside
 * the data root, so nothing is ever trashed outside the test's own temporary folders.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  CHANGE_DEMO,
  createDataRoot,
  DEMO_FOLDER,
  expect,
  hasChangeDemo,
  launchApp,
  NetworkGuard,
  openProject,
  test,
  tinyGlb,
  tinyManifest,
  type DataRoot,
} from './fixtures';

interface Seen {
  __e2eTrashed?: string[];
}

/** Launch on `dataRoot` with the recycle bin stood in for (a move into `bin`, as it does it). */
async function start(dataRoot: DataRoot, bin: string, env: Record<string, string> = {}) {
  const app = await launchApp(dataRoot, env);
  const network = new NetworkGuard();
  await network.attach(app);
  await app.evaluate(({ shell }, binDir) => {
    const seen = globalThis as Seen;
    seen.__e2eTrashed = [];
    shell.trashItem = async (p: string) => {
      const fs = process.getBuiltinModule('node:fs');
      const path = process.getBuiltinModule('node:path');
      await fs.promises.mkdir(binDir, { recursive: true });
      await fs.promises.rename(p, path.join(binDir, path.basename(p)));
      seen.__e2eTrashed?.push(p);
    };
  }, bin);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, network };
}

const trashed = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as Seen).__e2eTrashed?.slice() ?? []);

/** Answer the next folder picker (Add project folder) with `dir`. */
const stubFolderPicker = (app: ElectronApplication, dir: string) =>
  app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [target] });
  }, dir);

const card = (win: Page, name: string) => win.getByTestId('project-card').filter({ hasText: name });
const dots = (win: Page, name: string) => win.getByRole('button', { name: `Actions for ${name}` });

async function pickFromMenu(win: Page, name: string, item: 'remove' | 'delete' | 'close') {
  await dots(win, name).click();
  await win.getByTestId(`project-menu-${item}`).click();
}

/** The delete confirm of `name`; it names `path`. */
async function confirmDelete(win: Page, name: string, path: string, text: string) {
  const dlg = win.getByRole('alertdialog', { name: `Delete ${name}?` });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(text);
  await expect(dlg).toContainText(path);
  await dlg.getByTestId('project-delete-confirm').click();
  await expect(dlg).toBeHidden();
}

/** A small native project folder at `dir`. */
async function writeProject(dir: string, id: string, name: string): Promise<void> {
  await mkdir(join(dir, 'models'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...tinyManifest(), id, name }, null, 2),
  );
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
}

const viewFile = (dataRoot: DataRoot) => join(dataRoot.userData, 'library-view.json');
const hiddenKeys = async (dataRoot: DataRoot): Promise<string[]> => {
  try {
    return (
      (JSON.parse(await readFile(viewFile(dataRoot), 'utf8')) as { hidden?: string[] }).hidden ?? []
    );
  } catch {
    return [];
  }
};
const sameFile = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

test('remove hides a data-folder project; it stays hidden after a restart and Add project folder brings it back', async ({
  dataRoot,
}) => {
  test.setTimeout(180_000);
  const yardDir = join(dataRoot.root, 'projects', 'removable-yard');
  await writeProject(yardDir, 'removable-yard', 'Removable yard');
  const bin = join(dataRoot.base, 'recycle-bin');

  let run = await start(dataRoot, bin);
  try {
    const { app, win } = run;
    await expect(win.getByTestId('project-card')).toHaveCount(2);
    // Remove is offered on any card and needs no confirm
    await dots(win, 'Removable yard').click();
    await expect(win.getByTestId('project-menu-remove')).toContainText('Remove from library');
    await expect(win.getByTestId('project-menu-remove')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await win.getByTestId('project-menu-remove').click();
    await expect(card(win, 'Removable yard')).toHaveCount(0);
    await expect(win.getByTestId('project-card')).toHaveCount(1);
    const notice = win.getByTestId('library-notice');
    await expect(notice).toContainText('Removable yard was removed from the library');
    await expect(notice).toContainText(yardDir);
    // nothing was touched: the folder is whole and the recycle bin was not asked
    expect(await trashed(app)).toEqual([]);
    expect(existsSync(join(yardDir, 'manifest.json'))).toBe(true);
    expect(await hiddenKeys(dataRoot)).toEqual([yardDir.toLowerCase()]);
    expect(await run.network.outbound()).toEqual([]);
  } finally {
    await run.app.close();
  }

  // a restart: still out of the library, still on disk
  run = await start(dataRoot, bin);
  try {
    const { app, win } = run;
    await expect(card(win, 'E2E tiny project')).toBeVisible();
    await expect(card(win, 'Removable yard')).toHaveCount(0);
    await expect(win.getByTestId('project-card')).toHaveCount(1);
    expect(existsSync(join(yardDir, 'manifest.json'))).toBe(true);

    // Add project folder on its folder brings it back
    await stubFolderPicker(app, yardDir);
    await win.getByRole('button', { name: 'Add project folder' }).first().click();
    await expect(card(win, 'Removable yard')).toBeVisible();
    await expect(win.getByTestId('project-card')).toHaveCount(2);
    expect(await hiddenKeys(dataRoot)).toEqual([]);
  } finally {
    await run.app.close();
  }

  // and it stays back after one more restart
  run = await start(dataRoot, bin);
  try {
    await expect(card(run.win, 'Removable yard')).toBeVisible();
    await expect(run.win.getByTestId('project-card')).toHaveCount(2);
  } finally {
    await run.app.close();
  }
});

test('delete moves a package and an added folder to the recycle bin after a confirm naming the path', async ({
  dataRoot,
}) => {
  test.setTimeout(300_000);
  const bin = join(dataRoot.base, 'recycle-bin');
  const pkg = join(dataRoot.root, 'projects', 'Package yard.aio');
  const outside = join(dataRoot.base, 'elsewhere', 'Outside yard');
  await writeProject(outside, 'outside-yard', 'Outside yard');

  // a package of its own, exported by a builder with a data folder of its own
  const builder = await createDataRoot();
  try {
    await writeProject(join(builder.root, 'projects', 'pack-src'), 'pack-src', 'Package yard');
    const b = await start(builder, join(builder.base, 'recycle-bin'));
    try {
      await b.app.evaluate(({ dialog }, target) => {
        dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
      }, pkg);
      await card(b.win, 'Package yard').click();
      await expect.poll(async () => (await openProject(b.win)).id).toBe('pack-src');
      await b.win.locator('.nav-item', { hasText: 'Reports' }).first().click();
      await b.win.getByTestId('export-package').click();
      const dialog = b.win.getByTestId('package-export');
      await expect(dialog.getByTestId('pkg-size')).not.toContainText('...');
      await dialog.getByTestId('pkg-export').click();
      await expect(dialog.getByTestId('pkg-done')).toBeVisible({ timeout: 180_000 });
      expect((await stat(pkg)).size).toBeGreaterThan(0);
    } finally {
      await b.app.close();
    }
  } finally {
    await rm(builder.base, { recursive: true, force: true, maxRetries: 3 });
  }

  // first run: add the folder from outside the data folder, then delete both cards
  let run = await start(dataRoot, bin);
  try {
    const { app, win } = run;
    await expect(card(win, 'Package yard')).toBeVisible();
    await stubFolderPicker(app, outside);
    await win.getByRole('button', { name: 'Add project folder' }).first().click();
    await expect(card(win, 'Outside yard')).toBeVisible();
    await expect(win.getByTestId('project-card')).toHaveCount(3);
    expect(await readFile(join(dataRoot.userData, 'library.json'), 'utf8')).toContain(
      'Outside yard',
    );

    // Cancel deletes nothing
    await pickFromMenu(win, 'Package yard', 'delete');
    const dlg = win.getByRole('alertdialog', { name: 'Delete Package yard?' });
    await expect(dlg).toContainText(pkg);
    await expect(dlg.getByTestId('project-delete-cancel')).toBeFocused();
    await dlg.getByTestId('project-delete-cancel').click();
    await expect(dlg).toBeHidden();
    expect(existsSync(pkg)).toBe(true);
    expect(await trashed(app)).toEqual([]);

    // the package: its file goes to the bin, nothing else
    await pickFromMenu(win, 'Package yard', 'delete');
    await confirmDelete(win, 'Package yard', pkg, 'The package file moves to the recycle bin.');
    await expect(card(win, 'Package yard')).toHaveCount(0);
    expect(existsSync(pkg)).toBe(false);
    expect(existsSync(join(bin, 'Package yard.aio'))).toBe(true);

    // the added folder: whole into the bin, and gone from the library list
    await pickFromMenu(win, 'Outside yard', 'delete');
    await confirmDelete(win, 'Outside yard', outside, 'recycle bin');
    await expect(card(win, 'Outside yard')).toHaveCount(0);
    await expect(win.getByTestId('project-card')).toHaveCount(1);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(bin, 'Outside yard', 'manifest.json'))).toBe(true);
    expect(await trashed(app)).toEqual([pkg, outside]);
    expect(await readFile(join(dataRoot.userData, 'library.json'), 'utf8')).not.toContain(
      'Outside yard',
    );
    // the data folder and the other project are untouched
    expect(existsSync(join(dataRoot.projectDir, 'manifest.json'))).toBe(true);
    expect(await run.network.outbound()).toEqual([]);
  } finally {
    await run.app.close();
  }

  // a restart: neither comes back
  run = await start(dataRoot, bin);
  try {
    await expect(card(run.win, 'E2E tiny project')).toBeVisible();
    await expect(run.win.getByTestId('project-card')).toHaveCount(1);
  } finally {
    await run.app.close();
  }
});

test.describe('a demo card', () => {
  const demoEnv = { QUADRION_DEMO: DEMO_FOLDER };
  const demoKey = `demo:${CHANGE_DEMO.id}`;
  const bundled = join(DEMO_FOLDER, CHANGE_DEMO.id);

  test('a removed demo stays out after a restart', async ({ dataRoot }) => {
    test.skip(!hasChangeDemo(), `no change demo in ${DEMO_FOLDER}: run pnpm demo:change --quick`);
    test.setTimeout(180_000);
    const bin = join(dataRoot.base, 'recycle-bin');

    let run = await start(dataRoot, bin, demoEnv);
    try {
      const { app, win } = run;
      await expect(card(win, CHANGE_DEMO.name)).toBeVisible();
      // never opened: no working copy, so the confirm names no folder and says so
      await pickFromMenu(win, CHANGE_DEMO.name, 'delete');
      const dlg = win.getByRole('alertdialog', { name: `Delete ${CHANGE_DEMO.name}?` });
      await expect(dlg).toContainText('Nothing of this demo is on disk outside the app.');
      await expect(dlg.getByTestId('project-delete-path')).toHaveCount(0);
      await dlg.getByTestId('project-delete-cancel').click();
      await expect(dlg).toBeHidden();
      await pickFromMenu(win, CHANGE_DEMO.name, 'remove');
      await expect(card(win, CHANGE_DEMO.name)).toHaveCount(0);
      await expect(win.getByTestId('library-notice')).toContainText('was removed from the library');
      expect(await hiddenKeys(dataRoot)).toContain(demoKey);
      expect(await trashed(app)).toEqual([]);
    } finally {
      await run.app.close();
    }

    run = await start(dataRoot, bin, demoEnv);
    try {
      await expect(card(run.win, 'E2E tiny project')).toBeVisible();
      await expect(card(run.win, CHANGE_DEMO.name)).toHaveCount(0);
      expect(existsSync(join(bundled, 'truth.json'))).toBe(true);
    } finally {
      await run.app.close();
    }
  });

  test('delete moves a demo working copy only, and the demo stays out after a restart', async ({
    dataRoot,
  }) => {
    test.skip(!hasChangeDemo(), `no change demo in ${DEMO_FOLDER}: run pnpm demo:change --quick`);
    test.setTimeout(240_000);
    const bin = join(dataRoot.base, 'recycle-bin');
    const copy = join(dataRoot.userData, 'demo', CHANGE_DEMO.id);

    let run = await start(dataRoot, bin, demoEnv);
    try {
      const { app, win } = run;
      // opening the demo makes its working copy; the bundled folder stays as it shipped
      await card(win, CHANGE_DEMO.name).click();
      await expect
        .poll(async () => (await openProject(win)).id, { timeout: 60_000 })
        .toBe(CHANGE_DEMO.id);
      expect(existsSync(join(copy, 'manifest.json'))).toBe(true);
      await win.locator('.nav-item', { hasText: 'Projects' }).first().click();

      // the open demo holds Delete until it is closed
      await dots(win, CHANGE_DEMO.name).click();
      await expect(win.getByTestId('project-menu-delete')).toHaveAttribute('aria-disabled', 'true');
      await win.getByTestId('project-menu-close').click();
      await expect.poll(async () => (await openProject(win)).id).toBeNull();

      await pickFromMenu(win, CHANGE_DEMO.name, 'delete');
      const dlg = win.getByRole('alertdialog', { name: `Delete ${CHANGE_DEMO.name}?` });
      await expect(dlg).toBeVisible();
      // the confirm names the working copy, never the folder that ships with the app
      const shown = (await dlg.getByTestId('project-delete-path').textContent()) ?? '';
      expect(sameFile(shown, copy)).toBe(true);
      await dlg.getByTestId('project-delete-confirm').click();
      await expect(dlg).toBeHidden();
      await expect(card(win, CHANGE_DEMO.name)).toHaveCount(0);

      // only the working copy went to the bin
      const moved = await trashed(app);
      expect(moved).toHaveLength(1);
      expect(sameFile(moved[0] ?? '', copy)).toBe(true);
      expect(existsSync(copy)).toBe(false);
      expect(existsSync(join(bin, CHANGE_DEMO.id))).toBe(true);
      expect(existsSync(join(bundled, 'truth.json'))).toBe(true);
      expect(await hiddenKeys(dataRoot)).toContain(demoKey);
      expect(await run.network.outbound()).toEqual([]);
    } finally {
      await run.app.close();
    }

    run = await start(dataRoot, bin, demoEnv);
    try {
      await expect(card(run.win, 'E2E tiny project')).toBeVisible();
      await expect(card(run.win, CHANGE_DEMO.name)).toHaveCount(0);
      expect(existsSync(join(bundled, 'truth.json'))).toBe(true);
      expect(existsSync(copy)).toBe(false);
    } finally {
      await run.app.close();
    }
  });
});
