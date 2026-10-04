import type { ElectronApplication, Page } from '@playwright/test';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pmtilesFile } from '../src/main/testing';
import { expect, test } from './fixtures';

/** The next native open dialog answers with `path`. */
async function answerOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
  }, path);
}

async function openSettings(win: Page, page: string): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: page }).click();
  await expect(win.locator('.set-page h1')).toHaveText(page);
}

test('imports a map pack file, shows it on the coverage map and removes it', async ({
  app,
  win,
  dataRoot,
}) => {
  const src = join(dataRoot.base, 'Doha Streets.pmtiles');
  await writeFile(src, pmtilesFile({ maxZoom: 14, bbox: [51.4, 25.2, 51.6, 25.4] }));
  await openSettings(win, 'Offline maps');
  await expect(win.getByTestId('pack-coverage')).toBeVisible();
  await expect(win.getByText(/No map packs in/)).toBeVisible();

  await answerOpenDialog(app, src);
  await win.getByRole('button', { name: 'Import pack file' }).click();
  const row = win.getByTestId('pack-table').locator('tr', { hasText: 'Doha Streets' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('doha-streets');
  await expect(row).toContainText('z14');
  await expect(row).toContainText('Imported');
  expect((await readdir(join(dataRoot.root, 'packs'))).sort()).toEqual([
    'doha-streets.json',
    'doha-streets.pmtiles',
  ]);

  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await row.getByRole('button', { name: 'Remove Doha Streets' }).click();
  await expect(win.getByText(/No map packs in/)).toBeVisible();
  expect(await readdir(join(dataRoot.root, 'packs'))).toEqual([]);
});

test('refuses a file that is not a map pack', async ({ app, win, dataRoot }) => {
  const src = join(dataRoot.base, 'notes.pmtiles');
  await writeFile(src, 'not a pack');
  await openSettings(win, 'Offline maps');
  await answerOpenDialog(app, src);
  await win.getByRole('button', { name: 'Import pack file' }).click();
  await expect(win.getByRole('alert')).toContainText('not a PMTiles map pack');
});

test('plans a region download offline: country, zoom, size estimate and the online note', async ({
  win,
  dataRoot,
}) => {
  await openSettings(win, 'Offline maps');
  await win.getByRole('button', { name: 'Add a region' }).click();
  const panel = win.getByTestId('add-region');
  await expect(panel).toContainText('This downloads map data from build.protomaps.com');
  const download = panel.getByRole('button', { name: /^Download/ });
  await expect(download).toBeDisabled();

  await panel.getByLabel('Country').selectOption('qatar');
  await expect(panel.getByTestId('draft-bbox')).toHaveText('50.74, 24.47, 51.65, 26.20');
  await expect(panel.getByLabel('Pack name')).toHaveValue('Qatar');
  await panel.getByLabel('Maximum zoom').selectOption('14');
  await expect(panel.getByTestId('pack-estimate')).toContainText(/About \d/);
  await expect(download).toBeEnabled();

  // Offline-only turns the download off; nothing was started.
  await openSettings(win, 'Privacy and cloud');
  await win.getByRole('switch', { name: 'Offline-only workstation' }).click();
  await openSettings(win, 'Offline maps');
  await win.getByRole('button', { name: 'Add a region' }).click();
  await expect(win.getByTestId('add-region')).toContainText('offline-only');
  await win.getByTestId('add-region').getByLabel('Country').selectOption('kuwait');
  await expect(
    win.getByTestId('add-region').getByRole('button', { name: /^Download/ }),
  ).toBeDisabled();
  expect(await readdir(join(dataRoot.root, 'packs'))).toEqual([]);
});

test('switches between dark, light and system themes and to right-to-left', async ({ win }) => {
  await openSettings(win, 'Appearance');
  const html = win.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await win.getByRole('radio', { name: /^Light/ }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(html).toHaveAttribute('data-theme-setting', 'light');

  await win.getByRole('radio', { name: /^System/ }).click();
  await expect(html).toHaveAttribute('data-theme-setting', 'system');
  const prefersDark = await win.evaluate(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  await expect(html).toHaveAttribute('data-theme', prefersDark ? 'dark' : 'light');

  await win.getByRole('button', { name: 'Right to left' }).click();
  await expect(html).toHaveAttribute('dir', 'rtl');
  // Timelines and the stage keep their geometry.
  const sidebarRight = await win
    .locator('.sidebar')
    .evaluate((el) => el.getBoundingClientRect().right);
  const viewport = await win.evaluate(() => window.innerWidth);
  expect(sidebarRight).toBeGreaterThan(viewport / 2);

  // Survives a restart of the renderer.
  await win.reload();
  await expect(html).toHaveAttribute('dir', 'rtl');
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Appearance' }).click();
  await win.getByRole('button', { name: 'Left to right' }).click();
  await win.getByRole('radio', { name: /^Dark/ }).click();
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('about lists the version, folders and licences, and refuses an unsigned installer', async ({
  app,
  win,
  dataRoot,
}) => {
  await openSettings(win, 'About and updates');
  await expect(win.getByTestId('about-data')).toHaveText(dataRoot.root);
  await expect(win.getByTestId('licences').locator('tbody tr').first()).toBeVisible();
  expect(await win.getByTestId('licences').locator('tbody tr').count()).toBeGreaterThan(20);
  await win.getByLabel('Filter licences').fill('maplibre');
  await expect(win.getByTestId('licences')).toContainText('maplibre-gl');

  const fake = join(dataRoot.base, 'Setup-9.9.9.exe');
  await writeFile(fake, 'MZ not really an installer');
  await answerOpenDialog(app, fake);
  await win.getByRole('button', { name: 'Choose installer' }).click();
  await expect(win.getByTestId('update-verdict')).toContainText(/not signed|not valid/, {
    timeout: 30_000,
  });
  await expect(win.getByRole('button', { name: 'Install and restart' })).toHaveCount(0);

  // The online check is off by default and needs an address before it can run.
  const online = win.getByRole('switch', { name: 'Check for updates online' });
  await expect(online).toHaveAttribute('aria-checked', 'false');
  await online.click();
  await expect(win.getByRole('button', { name: 'Check now' })).toBeDisabled();
});

test('the pack manager and about pages make no network requests while idle', async ({
  win,
  network,
}) => {
  await openSettings(win, 'Offline maps');
  await win.getByRole('button', { name: 'Add a region' }).click();
  await win.getByTestId('add-region').getByLabel('Country').selectOption('uae');
  await win.waitForTimeout(1000);
  await openSettings(win, 'About and updates');
  await win.waitForTimeout(500);
  expect(await network.outbound()).toEqual([]);
});
