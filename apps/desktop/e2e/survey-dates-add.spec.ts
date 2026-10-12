/**
 * Timeline T2 in the real app: a survey date added by hand from the Datasets header, a flight
 * folder imported as its own survey date (and re-dated in the import card), and the one-time
 * prompt that files recorded datasets sitting in Every date. Off-screen, zero network, synthetic
 * data only.
 */
import { toWgs84 } from '@aio/geo';
import { withExif } from '@aio/project/builder/testing';
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, openProject, test as base, tinyManifest, type DataRoot } from './fixtures';

const test = base.extend<{
  /** The tiny fixture project with its one capture removed (list it before `win`). */
  undatedProject: { id: string };
  /**
   * The tiny project written before the app starts with two undated photos layers recorded on
   * 1 Jan 2026 (its one survey date) next to its undated model (list it before `win`).
   */
  recordedProject: { id: string };
}>({
  undatedProject: async ({ dataRoot }, use) => {
    const manifest = { ...tinyManifest(), captures: [] };
    await writeFile(join(dataRoot.projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await use({ id: dataRoot.projectId });
  },
  recordedProject: async ({ dataRoot }, use) => {
    const jpeg = await smallJpeg();
    await mkdir(join(dataRoot.projectDir, 'photos'), { recursive: true });
    for (const name of ['a1', 'a2', 'b1'])
      await writeFile(join(dataRoot.projectDir, 'photos', `${name}.jpg`), jpeg);
    const photo = (id: string, time: string) => ({
      id,
      src: { path: `photos/${id}.jpg` },
      takenAt: `2026-01-01T${time}+04:00`,
    });
    const input: ProjectManifestInput = {
      ...tinyManifest(),
      layers: [
        ...tinyManifest().layers,
        {
          kind: 'photos',
          id: 'photos-a',
          name: 'Photos A',
          items: [photo('a1', '10:00:00'), photo('a2', '10:05:00')],
        },
        { kind: 'photos', id: 'photos-b', name: 'Photos B', items: [photo('b1', '11:00:00')] },
      ],
    };
    await writeFile(
      join(dataRoot.projectDir, 'manifest.json'),
      JSON.stringify(ProjectManifest.parse(input), null, 2),
    );
    await use({ id: dataRoot.projectId });
  },
});

/** A 64 x 48 grey JPEG. */
function smallJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer();
}

/** Make the next native open dialog return these paths (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

interface SavedManifest {
  captures: { id: string; label: string; date: string }[];
  layers: { id: string; kind: string; capture?: string }[];
}

/** The project's manifest as it is on disk now. */
async function savedManifest(dataRoot: DataRoot, id: string): Promise<SavedManifest> {
  const text = await readFile(join(dataRoot.root, 'projects', id, 'manifest.json'), 'utf8');
  return JSON.parse(text) as SavedManifest;
}

const TINY = 'E2E tiny project';

async function open(win: Page, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: TINY }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
}

/** Reload the window and open the project again. */
async function reopen(win: Page, id: string) {
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await open(win, id);
}

test('a flight folder comes in as a new survey date, and the date can be changed', async ({
  app,
  win,
  dataRoot,
}) => {
  // a flight folder: three geotagged photos taken on 6 Nov 2024 and a text file
  const jpeg = await smallJpeg();
  const folder = join(dataRoot.base, 'flight');
  await mkdir(folder, { recursive: true });
  const ll = toWgs84([500000.5, 3200000.5, 0], 32639);
  for (const [i, time] of ['10:00:00', '10:00:05', '10:00:10'].entries()) {
    await writeFile(
      join(folder, `IMG_000${String(i + 1)}.JPG`),
      withExif(
        {
          lat: ll[1] + i * 0.00001,
          lon: ll[0],
          alt: 40,
          focal35: 24,
          width: 64,
          height: 48,
          dateTimeOriginal: `2024:11:06 ${time}`,
        },
        jpeg,
      ),
    );
  }
  await writeFile(join(folder, 'notes.txt'), 'flight notes');

  const id = dataRoot.projectId;
  await open(win, id);
  await nextOpenDialog(app, [folder]);
  await win.getByTestId('add-survey-date').click();
  await expect(win.getByTestId('add-date-menu')).toBeVisible();
  await win.getByTestId('add-date-folder').click();

  const panel = win.getByTestId('import-panel');
  const card = panel.getByTestId('import-survey-date');
  const select = card.locator('select');
  await expect(select).toHaveValue('capture-2024-11-06', { timeout: 30_000 });
  await expect(select.locator('option:checked')).toHaveText('6 Nov 2024 · Survey (new)');
  await expect(card).toContainText('Read from the photos.');
  await expect(panel).toContainText('1 files in flight are not data this app imports (.txt).');

  // on disk: the new date next to the old one, and a photos layer of that date
  const m = await savedManifest(dataRoot, id);
  expect(m.captures.map((c) => c.date).sort()).toEqual(['2024-11-06', '2026-01-01']);
  expect(m.captures.find((c) => c.date === '2024-11-06')).toMatchObject({
    id: 'capture-2024-11-06',
    label: 'Survey',
  });
  expect(m.layers.find((l) => l.id === 'photos-2024-11-06')).toMatchObject({
    kind: 'photos',
    capture: 'capture-2024-11-06',
  });

  // New survey date..., 7 Nov 2024: the layers move, and the date the import made is removed
  await select.selectOption({ label: 'New survey date...' });
  await card.getByTestId('import-survey-date-new').fill('2024-11-07');
  await card.getByTestId('import-survey-date-add').click();
  await expect(select).toHaveValue('capture-2024-11-07', { timeout: 30_000 });
  await expect
    .poll(async () => {
      const after = await savedManifest(dataRoot, id);
      return {
        dates: after.captures.map((c) => c.id).sort(),
        capture: after.layers.find((l) => l.id === 'photos-2024-11-06')?.capture,
      };
    })
    .toEqual({ dates: ['capture-1', 'capture-2024-11-07'], capture: 'capture-2024-11-07' });

  await expect(win.getByTestId('date-folder-capture-2024-11-07')).toContainText('7 Nov 2024');
  await expect(win.getByTestId('date-folder-capture-2024-11-06')).toHaveCount(0);
});

test('a survey date is added by hand and focused', async ({ undatedProject, win, dataRoot }) => {
  const id = undatedProject.id;
  await open(win, id);
  await expect(win.locator('[data-testid^="date-folder-"]')).toHaveCount(0);

  await win.getByTestId('add-survey-date').click();
  const menu = win.getByTestId('add-date-menu');
  await expect(menu).toBeVisible();
  await menu.getByLabel('Date', { exact: true }).fill('2026-02-03');
  await menu.getByLabel('Name', { exact: true }).fill('Baseline');
  await menu.getByTestId('add-date-submit').click();
  await expect(menu).toHaveCount(0);

  // the tree turns date-first with the one new date, focused
  const folder = win.getByTestId('date-folder-capture-2026-02-03');
  await expect(folder).toBeVisible();
  await expect(folder).toContainText('3 Feb 2026');
  await expect(folder).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('[data-testid^="date-folder-capture-"]')).toHaveCount(1);
  await expect(win.getByTestId('date-bar-open')).toContainText('3 Feb 2026');
  await expect
    .poll(async () => (await savedManifest(dataRoot, id)).captures)
    .toEqual([{ id: 'capture-2026-02-03', label: 'Baseline', date: '2026-02-03' }]);

  // the same day again: a note, and nothing is added
  await win.getByTestId('add-survey-date').click();
  await expect(menu).toBeVisible();
  await menu.getByLabel('Date', { exact: true }).fill('2026-02-03');
  await menu.getByTestId('add-date-submit').click();
  await expect(win.getByTestId('date-note')).toContainText('3 Feb 2026 is already a survey date.');
  await expect(win.locator('[data-testid^="date-folder-capture-"]')).toHaveCount(1);
  expect((await savedManifest(dataRoot, id)).captures).toHaveLength(1);
});

test.describe('recorded datasets in Every date', () => {
  test('are filed once', async ({ recordedProject, win, dataRoot }) => {
    const id = recordedProject.id;
    await open(win, id);
    const prompt = win.getByTestId('date-prompt');
    await expect(prompt).toContainText('2 datasets in Every date were recorded on survey days.');
    await expect(prompt).toContainText('2 under 1 Jan 2026');
    await prompt.getByTestId('date-prompt-file').click();
    await expect(prompt).toHaveCount(0);
    await expect(win.getByTestId('date-note')).toContainText('Filed 2 datasets.');

    // both photos layers (3 photos, one Photos group) under 1 Jan 2026, the model stays in
    // Every date
    const jan = win.getByTestId('date-folder-capture-1');
    const every = win.getByTestId('date-folder-every');
    await expect(jan.getByTestId('tree-group-photos')).toContainText('3');
    await expect(every.getByTestId('tree-group-photos')).toHaveCount(0);
    await expect(every.getByTestId('tree-row-quad')).toBeVisible();
    await expect
      .poll(async () => {
        const m = await savedManifest(dataRoot, id);
        return Object.fromEntries(m.layers.map((l) => [l.id, l.capture ?? null]));
      })
      .toEqual({ quad: null, 'photos-a': 'capture-1', 'photos-b': 'capture-1' });

    // opened again: no prompt
    await reopen(win, id);
    await expect(win.getByTestId('date-folder-capture-1')).toBeVisible();
    await expect(prompt).toHaveCount(0);
  });

  test('Not now ends the prompt too, and files nothing', async ({
    recordedProject,
    win,
    dataRoot,
  }) => {
    const id = recordedProject.id;
    await open(win, id);
    const prompt = win.getByTestId('date-prompt');
    await expect(prompt).toBeVisible();
    await prompt.getByTestId('date-prompt-later').click();
    await expect(prompt).toHaveCount(0);
    const m = await savedManifest(dataRoot, id);
    expect(m.layers.filter((l) => l.capture !== undefined)).toEqual([]);

    await reopen(win, id);
    await expect(
      win.getByTestId('date-folder-every').getByTestId('tree-group-photos'),
    ).toContainText('3');
    await expect(prompt).toHaveCount(0);
  });
});
