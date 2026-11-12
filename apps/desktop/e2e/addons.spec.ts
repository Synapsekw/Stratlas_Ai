/**
 * Add-on model packs (N1): Settings, Models and detection, Add-ons against a catalogue and
 * archives served on loopback (`QUADRION_ADDONS_URL`; the zero-network guard lets only that origin
 * through). The archives are the tiny fakes of `src/main/addons/addon.fakes.ts`: the synthetic
 * marker detector, the colour segmenter and a ground classifier file, a few kilobytes each.
 *
 * - The three known add-ons are listed with the download size from the catalogue; Road defects
 *   downloads with progress, its model joins Detection models (as an add-on, no Remove there) and
 *   Remove on the add-on row takes it away again.
 * - An archive whose file does not match its manifest is refused with the reason on its row, and
 *   nothing is installed.
 * - Offline only: the catalogue is never read (no request reaches the server), Choose file
 *   installs the Ground classifier from a local file, and the Clean up panel of a COPC cloud then
 *   offers Also mark ground (the panel only; no PDAL run).
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fakeAddonArchive,
  fakeCatalogue,
  fakeCatalogueEntry,
  type FakeAddon,
} from '../src/main/addons/addon.fakes';
import { openCleanupFromMenu, openNoisyProject, writeNoisyProject } from './cleanupHelpers';
import { NetworkGuard, expect, test as base } from './fixtures';

interface AddonServer {
  origin: string;
  /** The add-ons the catalogue offers; set by each test before the app reads it. */
  offer: FakeAddon[];
  /** Paths the server was asked for, in order. */
  hits: string[];
}

const test = base.extend<{ addonServer: AddonServer }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  addonServer: async ({}, use) => {
    const state: Omit<AddonServer, 'origin'> = { offer: [], hits: [] };
    const server = createServer((req, res) => {
      const path = req.url ?? '';
      state.hits.push(path);
      if (path === '/addons/catalogue.json') {
        const body = JSON.stringify(fakeCatalogue(state.offer.map((a) => fakeCatalogueEntry(a))));
        res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        return;
      }
      const a = state.offer.find((x) => path === `/addons/${x.fileName}`);
      if (!a) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(a.bytes.length),
      });
      res.end(a.bytes);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${String(port)}`;
    try {
      await use({ origin, offer: state.offer, hits: state.hits });
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  },
  network: async ({ addonServer }, use) => {
    await use(new NetworkGuard([addonServer.origin]));
  },
  appEnv: async ({ addonServer }, use) => {
    await use({
      QUADRION_ADDONS_URL: `${addonServer.origin}/addons/`,
      AIO_NETWORK_GUARD_ALLOW: addonServer.origin,
    });
  },
});

test.setTimeout(120_000);

const ROAD = () => fakeAddonArchive({ id: 'road-defects', kind: 'detector', name: 'Road defects' });
const SEGMENT = () =>
  fakeAddonArchive({ id: 'segmentation', kind: 'segmenter', name: 'Segmentation' });
const GROUND = () =>
  fakeAddonArchive({
    id: 'ground-classifier',
    kind: 'point-classifier',
    name: 'Ground classifier',
  });

async function openModels(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Models and detection' })
    .click();
  await win.getByTestId('addons').scrollIntoViewIfNeeded();
}

/** Make the next native open dialog return this file (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, file) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: [file] });
    };
  }, path);
}

test('downloads Road defects from the catalogue, lists its model and removes it', async ({
  win,
  addonServer,
}) => {
  addonServer.offer.push(ROAD(), SEGMENT(), GROUND());
  await openModels(win);

  for (const id of ['road-defects', 'segmentation', 'ground-classifier']) {
    await expect(win.getByTestId(`addon-${id}-download`)).toHaveText(/^Download \(\d/);
    await expect(win.getByTestId(`addon-${id}-facts`)).toContainText('Licence MIT');
  }
  await expect(win.getByTestId('addons-catalogue')).toHaveCount(0);

  await win.getByTestId('addon-road-defects-download').click();
  await expect(win.getByTestId('addon-road-defects-state')).toHaveText('Version 1.0.0', {
    timeout: 30_000,
  });
  await expect(win.getByTestId('addon-road-defects-note')).toContainText('is installed');
  expect(addonServer.hits).toContain('/addons/road-defects-1.0.0.aioaddon');

  // Detection models lists the add-on's model, which is removed from the add-on row only
  const model = win.getByTestId('infer-model').filter({ hasText: 'Road defects' });
  await expect(model).toHaveCount(1, { timeout: 15_000 });
  await expect(model).toContainText('Add-on');
  await expect(model.getByRole('button', { name: /Remove/ })).toHaveCount(0);

  await win.getByTestId('addons').scrollIntoViewIfNeeded();
  await win.getByTestId('addon-road-defects-remove').click();
  await win.getByTestId('addon-road-defects-remove-yes').click();
  await expect(win.getByTestId('addon-road-defects-state')).toHaveText('Not installed');
  await expect(win.getByTestId('addon-road-defects-download')).toBeVisible();
  await expect(model).toHaveCount(0, { timeout: 15_000 });
});

test('refuses an archive whose file does not match its manifest, and installs nothing', async ({
  win,
  addonServer,
}) => {
  addonServer.offer.push(
    fakeAddonArchive({
      id: 'road-defects',
      kind: 'detector',
      name: 'Road defects',
      override: { 'model.onnx': 'not the listed model' },
    }),
  );
  await openModels(win);
  await win.getByTestId('addon-road-defects-download').click();
  const error = win.getByTestId('addon-road-defects-error');
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).not.toBeEmpty();
  await expect(win.getByTestId('addon-road-defects-state')).toHaveText('Not installed');
  await expect(win.getByTestId('addon-road-defects-remove')).toHaveCount(0);
  const listed = await win.evaluate(() => window.aio.invoke('addons:list', {}));
  expect(listed.addons.find((a) => a.id === 'road-defects')?.installed).toBeNull();
});

// Offline only is on before the app starts, so not even its first read of the list goes out
test.describe('offline', () => {
  test.beforeEach(async ({ dataRoot }) => {
    await writeNoisyProject(dataRoot.projectDir);
    await writeFile(
      join(dataRoot.userData, 'settings.json'),
      JSON.stringify({ offlineOnly: true }),
    );
  });

  test('offline only: no catalogue read, Choose file installs the Ground classifier', async ({
    app,
    win,
    dataRoot,
    addonServer,
    network,
  }) => {
    addonServer.offer.push(GROUND());
    await openModels(win);
    await expect(win.getByTestId('addons-catalogue')).toContainText('Offline only');
    await expect(win.getByTestId('addon-ground-classifier-download')).toHaveCount(0);

    const file = join(dataRoot.base, GROUND().fileName);
    await writeFile(file, GROUND().bytes);
    await nextOpenDialog(app, file);
    await win.getByTestId('addons-choose').click();
    await expect(win.getByTestId('addon-ground-classifier-state')).toHaveText('Version 1.0.0', {
      timeout: 30_000,
    });
    expect(addonServer.hits).toEqual([]);
    expect(await network.allowed()).toEqual([]);

    // the Clean up panel of a COPC cloud offers ground marking, off by default
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
    await openNoisyProject(win);
    await openCleanupFromMenu(win);
    const ground = win.getByTestId('cleanup-noise-ground');
    await expect(ground).toBeVisible();
    await expect(ground).not.toBeChecked();
  });
});
