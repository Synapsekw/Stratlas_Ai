/**
 * Library covers: the new project wizard writes the cover it was given, Change thumbnail on a
 * project folder writes its `thumbnail.jpg`, a package gets a cover kept on this computer only
 * (the `.aio` file is never touched), and "Use the last 3D view" offers the view as the project's
 * scene was left.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, launchApp, NetworkGuard, test, tinyManifest, type DataRoot } from './fixtures';

const card = (win: Page, name: string) =>
  win.getByTestId('project-card').filter({ hasText: name }).first();
const cardImg = (win: Page, name: string) => card(win, name).locator('img.pc-img');
const goProjects = (win: Page) => win.locator('.nav-item', { hasText: 'Projects' }).first().click();

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(b: Buffer): { width: number; height: number } {
  expect([...b.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) throw new Error(`no JPEG marker at ${String(i)}`);
    const m = b[i + 1] ?? 0;
    // SOF0..SOF15, not DHT (c4), JPG (c8) or DAC (cc)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error('no start-of-frame marker');
}

/** A picture to upload, larger than a cover so it has to be scaled down. */
async function writePng(file: string): Promise<string> {
  await writeFile(
    file,
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#2a7f62' } })
      .png()
      .toBuffer(),
  );
  return file;
}

/** The card picture is shown, not broken. */
async function expectLoaded(img: Locator) {
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
}

async function openCoverDialog(win: Page, name: string) {
  await card(win, name).scrollIntoViewIfNeeded();
  await card(win, name).click({ button: 'right' });
  await win.getByTestId('project-menu-thumbnail').click();
  const dlg = win.getByTestId('cover-dialog');
  await expect(dlg).toBeVisible();
  return dlg;
}

async function saveCover(dlg: Locator) {
  await dlg.getByTestId('cover-save').click();
  await expect(dlg).toBeHidden({ timeout: 15_000 });
}

test('the wizard writes the chosen cover into the new project', async ({ win, dataRoot }) => {
  await win.getByTestId('new-project').first().click();
  const wiz = win.getByTestId('new-project-wizard');
  await wiz.getByLabel('Project name').fill('Cover yard');
  const cover = wiz.getByTestId('wizard-cover');
  // a built-in cover is picked from the start: a new project never gets the blank placeholder
  await expect(cover.getByTestId('cover-builtin-contours')).toHaveAttribute('aria-pressed', 'true');
  // the new project has never been open in 3D: no picture of it to take
  await expect(cover.getByTestId('cover-last-view')).toBeDisabled();
  // an uploaded picture still shows after a step away and back
  await cover
    .getByTestId('cover-upload')
    .setInputFiles(await writePng(join(dataRoot.base, 'a.png')));
  const preview = cover.getByTestId('cover-preview').locator('img');
  await expectLoaded(preview);
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Back' }).click();
  await expectLoaded(preview);
  await cover.getByTestId('cover-builtin-grid').click();
  await expect(cover.getByTestId('cover-builtin-grid')).toHaveAttribute('aria-pressed', 'true');
  await win.screenshot({ path: test.info().outputPath('wizard-project-step.png') });
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
  await wiz.getByLabel('Origin coordinate').fill('29.0276, 48.1352, 30');
  await expect(wiz.getByTestId('origin-readout')).toContainText('E 2');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Create project' }).click();
  await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });

  const thumb = join(dataRoot.root, 'projects', 'cover-yard', 'thumbnail.jpg');
  await expect.poll(() => existsSync(thumb), { timeout: 15_000 }).toBe(true);
  const size = jpegSize(await readFile(thumb));
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(640);
  expect(size.width).toBeGreaterThan(size.height);

  await goProjects(win);
  const img = cardImg(win, 'Cover yard');
  await expect(img).toHaveAttribute('src', /^aio:\/\/project\/[^?]+\/thumbnail\.jpg\?v=\d+$/);
  await expectLoaded(img);
});

test('Change thumbnail on a project uploads an image and the card shows it at once', async ({
  win,
  dataRoot,
}) => {
  const png = await writePng(join(dataRoot.base, 'site photo.png'));
  const name = 'E2E tiny project';
  const thumb = join(dataRoot.projectDir, 'thumbnail.jpg');
  await expect(card(win, name)).toBeVisible();
  // the tiny project has no picture of its own yet
  await expect(cardImg(win, name)).toHaveCount(0);

  // a built-in cover first
  let dlg = await openCoverDialog(win, name);
  await dlg.getByTestId('cover-builtin-ridge').click();
  await saveCover(dlg);
  const img = cardImg(win, name);
  await expect(img).toHaveAttribute('src', /^aio:\/\/project\/e2e-tiny\/thumbnail\.jpg\?v=\d+$/);
  await expectLoaded(img);
  const first = await img.getAttribute('src');
  const firstBytes = await readFile(thumb);

  // then an uploaded picture: the card changes without a reload
  dlg = await openCoverDialog(win, name);
  await dlg.getByTestId('cover-upload').setInputFiles(png);
  await expect(dlg.getByTestId('cover-preview')).toHaveAttribute('data-kind', 'image');
  await saveCover(dlg);
  await expect(img).not.toHaveAttribute('src', first ?? '');
  await expect(img).toHaveAttribute('src', /^aio:\/\/project\/e2e-tiny\/thumbnail\.jpg\?v=\d+$/);
  await expectLoaded(img);
  const bytes = await readFile(thumb);
  expect(bytes.equals(firstBytes)).toBe(false);
  // scaled down to a cover: 1200 x 800 becomes 640 x 427
  expect(jpegSize(bytes)).toEqual({ width: 640, height: 427 });
});

/** Answer the next native save dialog with `file` (main process). */
async function stubSaveDialog(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, file);
}

const sha256 = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

test('a package gets a cover on this computer only; the package file is unchanged', async ({
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(240_000);
  // the tiny project gets a picture of its own, so its package carries one
  await writeFile(
    join(dataRoot.projectDir, 'thumbnail.jpg'),
    await sharp({ create: { width: 320, height: 180, channels: 3, background: '#b06030' } })
      .jpeg()
      .toBuffer(),
  );
  const file = join(dataRoot.base, 'tiny cover.aio');
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await win.locator('.nav-item', { hasText: 'Reports' }).first().click();
  await win.getByTestId('export-package').click();
  const exp = win.getByTestId('package-export');
  await expect(exp.getByTestId('pkg-size')).not.toContainText('...');
  await stubSaveDialog(app, file);
  await exp.getByTestId('pkg-export').click();
  await expect(exp.getByTestId('pkg-done')).toBeVisible({ timeout: 180_000 });
  const before = await sha256(file);
  const mtime = (await stat(file)).mtimeMs;

  // a customer machine opens the package; it stays in the customer's library
  const customer: DataRoot = {
    base: dataRoot.base,
    root: join(dataRoot.base, 'customer-data'),
    userData: join(dataRoot.base, 'customer-user'),
    projectId: '',
    projectDir: '',
  };
  await mkdir(customer.root, { recursive: true });
  const network = new NetworkGuard();
  const c = await launchApp(customer, {}, [file]);
  await network.attach(c);
  try {
    const cw = await c.firstWindow();
    await cw.waitForLoadState('domcontentloaded');
    await expect(cw.getByTestId('welcome')).toContainText('E2E tiny project', { timeout: 30_000 });
    await goProjects(cw);
    const name = 'E2E tiny project';
    const img = cardImg(cw, name);
    await expect(img).toHaveAttribute('src', /^aio:\/\/project\//);
    const own = await img.getAttribute('src');

    let dlg = await openCoverDialog(cw, name);
    // nothing of this computer yet: no way back to a picture it already shows
    await expect(dlg.getByTestId('cover-reset')).toHaveCount(0);
    await dlg.getByTestId('cover-builtin-dots').click();
    await saveCover(dlg);
    await expect(img).toHaveAttribute('src', /^aio:\/\/cover\/[0-9a-f]{64}\.jpg\?v=\d+$/);
    await expectLoaded(img);
    expect(await sha256(file)).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtime);

    dlg = await openCoverDialog(cw, name);
    await expect(dlg.getByTestId('cover-reset')).toContainText("Use the project's own picture");
    await dlg.getByTestId('cover-reset').click();
    await saveCover(dlg);
    await expect(img).toHaveAttribute('src', own ?? '');
    await expectLoaded(img);
    expect(await sha256(file)).toBe(before);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await c.close();
  }
});

test('Use the last 3D view is greyed until the project has been open in 3D, then sets the card', async ({
  win,
  dataRoot,
}) => {
  const name = 'E2E tiny project';
  // a built-in cover first, so the card has a picture to change from
  let dlg = await openCoverDialog(win, name);
  const view = dlg.getByTestId('cover-last-view');
  await expect(view).toBeDisabled();
  await expect(view).toContainText('Use the last 3D view');
  await expect(dlg).toContainText('Open this project in the 3D view first');
  await dlg.getByTestId('cover-builtin-grid').click();
  await saveCover(dlg);
  const img = cardImg(win, name);
  await expect(img).toHaveAttribute('src', /^aio:\/\/project\/e2e-tiny\/thumbnail\.jpg\?v=\d+$/);
  const before = await img.getAttribute('src');
  const builtin = await readFile(join(dataRoot.projectDir, 'thumbnail.jpg'));

  // the scene, then back: the 3D view as it was left is offered, with a small preview
  await card(win, name).click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 30_000 });
  await goProjects(win);
  await expect(card(win, name)).toBeVisible();
  dlg = await openCoverDialog(win, name);
  const last = dlg.getByTestId('cover-last-view');
  await expect(last).toBeEnabled({ timeout: 10_000 });
  await expect(dlg).not.toContainText('Open this project in the 3D view first');
  await expectLoaded(last.locator('img'));
  await last.click();
  await expect(last).toHaveAttribute('aria-pressed', 'true');
  await expect(dlg.getByTestId('cover-preview')).toHaveAttribute('data-kind', 'image');
  await expectLoaded(dlg.getByTestId('cover-preview').locator('img'));
  await saveCover(dlg);
  await expect(img).not.toHaveAttribute('src', before ?? '');
  await expect(img).toHaveAttribute('src', /^aio:\/\/project\/e2e-tiny\/thumbnail\.jpg\?v=\d+$/);
  await expectLoaded(img);
  const bytes = await readFile(join(dataRoot.projectDir, 'thumbnail.jpg'));
  expect(bytes.equals(builtin)).toBe(false);
  const size = jpegSize(bytes);
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(640);
});

test('another project has no last 3D view of its own', async ({ win, dataRoot }) => {
  const dir = join(dataRoot.root, 'projects', 'second-yard');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...tinyManifest(), id: 'second-yard', name: 'Second yard' }, null, 2),
  );
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  // the library is read again on a reload
  await win.reload();
  await expect(card(win, 'Second yard')).toBeVisible({ timeout: 15_000 });
  await card(win, 'E2E tiny project').click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 30_000 });
  await goProjects(win);
  await expect(card(win, 'Second yard')).toBeVisible();
  const dlg = await openCoverDialog(win, 'Second yard');
  await expect(dlg.getByTestId('cover-last-view')).toBeDisabled();
});
