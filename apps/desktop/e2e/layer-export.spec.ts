/**
 * Dataset export: two marked datasets (a model and a photo set) are copied from the right-click
 * menu into <dir>/<dataset name>/ with a .crs.json beside each; a second export refuses to
 * overwrite and says which folders were already there. The folder picker is stubbed to a temp
 * folder; synthetic data; off-screen; zero network.
 */
import type { ElectronApplication } from '@playwright/test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test as base, tinyGlb, tinyManifest } from './fixtures';

/** A 1 x 1 grey JPEG. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////' +
    '////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
const PHOTOS = [
  { id: 'a', src: { path: 'photos/ph/a.jpg' }, pos: [2, 1.6, -3] },
  { id: 'b', src: { path: 'photos/ph/b.jpg' }, pos: [3, 1.6, -4] },
];

/** Make the next native folder dialog return this folder (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

const test = base.extend<{ twoLayers: { id: string; dir: string } }>({
  twoLayers: async ({ dataRoot }, use) => {
    const m = tinyManifest();
    const manifest = {
      ...m,
      layers: [
        ...m.layers,
        {
          kind: 'photos',
          id: 'ph',
          name: 'Photos',
          visible: true,
          capture: 'capture-1',
          items: PHOTOS,
        },
      ],
    };
    await mkdir(join(dataRoot.projectDir, 'photos', 'ph'), { recursive: true });
    for (const p of PHOTOS) await writeFile(join(dataRoot.projectDir, p.src.path), JPEG);
    await writeFile(join(dataRoot.projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await use({ id: dataRoot.projectId, dir: dataRoot.projectDir });
  },
});

/** Every file under a folder with its mtime, for "nothing changed". */
async function listing(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listing(dir, r)));
    else out.push(`${r}@${String((await stat(join(dir, r))).mtimeMs)}`);
  }
  return out.sort();
}

test('marked datasets export to a folder with their frame; a second export never overwrites', async ({
  twoLayers,
  dataRoot,
  app,
  win,
}) => {
  const out = join(dataRoot.base, 'exported');
  await mkdir(out, { recursive: true });

  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect
    .poll(async () => (await openProject(win)).id, { timeout: 30_000 })
    .toBe(twoLayers.id);
  await win.locator('canvas').first().waitFor();

  const folder = win.getByTestId('date-folder-capture-1');
  if ((await folder.getAttribute('aria-expanded')) !== 'true')
    await win.getByTestId('date-name-capture-1').click();
  const photos = folder.getByTestId('tree-group-toggle-photos');
  if ((await photos.getAttribute('aria-expanded')) !== 'true') await photos.click();

  const quad = win.getByTestId('tree-row-quad');
  const ph = win.getByTestId('tree-row-ph');
  await quad.scrollIntoViewIfNeeded();
  // on the names: a row's middle can fall on its eye, which hides instead of marking
  await quad.locator('.tn').click({ modifiers: ['Control'] });
  await ph.scrollIntoViewIfNeeded();
  await ph.locator('.tn').click({ modifiers: ['Control'] });

  const exportMarked = async () => {
    await nextOpenDialog(app, [out]);
    await ph.click({ button: 'right' });
    await win.getByTestId('ctx-item-layer.export').click();
  };

  await exportMarked();
  await expect(win.getByTestId('export-toast-message').last()).toContainText(
    `2 datasets exported to ${out}`,
    { timeout: 30_000 },
  );

  const quadGlb = await readFile(join(dataRoot.projectDir, 'models', 'quad.glb'));
  expect(await readFile(join(out, 'Unit quad', 'quad.glb'))).toEqual(quadGlb);
  expect(quadGlb.equals(tinyGlb())).toBe(true);
  const crs = JSON.parse(await readFile(join(out, 'Unit quad', 'Unit quad.crs.json'), 'utf8')) as {
    crs: { epsg: number };
    origin: number[];
  };
  expect(crs.crs.epsg).toBe(32639);
  expect(crs.origin).toEqual([500000, 3200000, 0]);
  await stat(join(out, 'Photos', 'a.jpg'));
  await stat(join(out, 'Photos', 'b.jpg'));
  await stat(join(out, 'Photos', 'Photos.crs.json'));

  const before = await listing(out);
  await exportMarked();
  await expect(win.getByTestId('export-toast-message').last()).toContainText(
    'Not exported, a folder of that name is already there: Unit quad, Photos.',
    { timeout: 30_000 },
  );
  expect(await listing(out)).toEqual(before);
});
