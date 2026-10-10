/**
 * Settings, Processing tools: installing and updating the pipeline pack from inside the app.
 *
 * A temporary data folder holds an old fake pack (0.2.0, one pipeline) and, outside it, a newer
 * fake pack archive (every pipeline the app knows, checksums in its manifest), both a few
 * kilobytes (`packArchive.fakes.ts`; never the real 400 MB pack). The start notice shows once a
 * project is open, Settings says the pack is too old, installing the archive flips it to up to
 * date, and the Jobs header shows the new version without a restart. The native file dialog and
 * the Recycle Bin are stubbed in main; the launch asks for the notice (QUADRION_PACK_NOTICE=1),
 * which an automated run otherwise never shows.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakePackArchive, fakePackFiles } from '../src/main/jobs/packArchive.fakes';
import { expect, launchApp, test, type DataRoot } from './fixtures';

/** This computer as a pack manifest and a pack archive name it. */
const PLATFORM = `${process.platform}-${process.arch}`;
const ENV = {
  // no development interpreter: the pack comes from the data folder's runtime
  QUADRION_PIPELINE_PYTHON: '',
  QUADRION_PIPELINE_PACK: '',
  QUADRION_PACK_NOTICE: '1',
};

async function writeOldPack(data: DataRoot, version: string): Promise<string> {
  const dir = join(data.root, 'runtime', `pipeline-pack-${version}`);
  const files = fakePackFiles(version, { platform: PLATFORM, pipelines: ['system.selftest'] });
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(dir, ...name.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...name.split('/')), bytes);
  }
  return dir;
}

async function writeArchive(dir: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `pipeline-pack-${version}-${PLATFORM}.tar.gz`);
  await writeFile(
    path,
    fakePackArchive(version, {
      platform: PLATFORM,
      files: { 'python/Lib/site.py': '# fake', 'models/sam/model.json': '{}' },
    }),
  );
  return path;
}

/** The file dialog answers `path`; a pack "moved to the bin" is removed (never the real bin). */
async function stubDialogAndBin(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog, shell }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
    shell.trashItem = (dir: string) =>
      process.getBuiltinModule('node:fs').promises.rm(dir, { recursive: true });
  }, path);
}

async function openTinyProject(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs')).toContainText('E2E tiny project');
}

test('the start notice leads to Settings, where a pack file installs and Jobs follows', async ({
  dataRoot,
  network,
}, testInfo) => {
  await writeOldPack(dataRoot, '0.2.0');
  const archive = await writeArchive(join(dataRoot.base, 'kit'), '0.5.0');
  const app = await launchApp(dataRoot, ENV);
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await stubDialogAndBin(app, archive);

    // no project open: no notice
    await expect(win.getByTestId('project-card').first()).toBeVisible();
    await expect(win.getByTestId('tools-notice')).toHaveCount(0);
    await openTinyProject(win);
    const notice = win.getByTestId('tools-notice');
    await expect(notice).toContainText('Processing tools need an update');
    await expect(notice).toContainText('pack 0.2.0');
    await win.screenshot({ path: testInfo.outputPath('processing-tools-notice.png') });
    await notice.getByRole('button', { name: 'Update processing tools' }).click();

    // Settings, Processing tools: too old, and what for
    await expect(win.getByRole('heading', { level: 1, name: 'Processing tools' })).toBeVisible();
    const page = win.getByTestId('processing-tools');
    await expect(page.getByTestId('tools-state')).toHaveAttribute('data-state', 'too-old');
    await expect(page.getByTestId('tools-state')).toContainText('Too old for this version');
    await expect(page.getByTestId('tools-version')).toHaveText('0.2.0');
    await expect(page.getByTestId('tools-needs')).toContainText('This pack cannot run');
    await expect(win.getByTestId('tools-notice')).toHaveCount(0); // not on the page it points at
    await win.screenshot({ path: testInfo.outputPath('processing-tools-too-old.png') });

    // install from the file the dialog answers
    await page.getByTestId('tools-choose').click();
    await expect(page.getByTestId('tools-note')).toContainText(
      'Processing tools 0.5.0 are installed.',
    );
    await expect(page.getByTestId('tools-state')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('tools-state')).toContainText('Up to date');
    await expect(page.getByTestId('tools-version')).toHaveText('0.5.0');
    await expect(page.getByTestId('tools-needs')).toHaveCount(0);
    // the pack is in place, with nothing half-unpacked beside it
    const runtime = join(dataRoot.root, 'runtime');
    expect((await readdir(runtime)).sort()).toEqual(['pipeline-pack-0.2.0', 'pipeline-pack-0.5.0']);
    expect(existsSync(join(runtime, 'pipeline-pack-0.5.0', 'python', 'python.exe'))).toBe(true);

    // the old pack is listed with its size and stays until removed
    const others = win.getByTestId('tools-others');
    await expect(others.getByTestId('tools-pack-0.2.0')).toContainText('0.2.0');
    await win.screenshot({ path: testInfo.outputPath('processing-tools.png') });

    // the same file again asks before replacing
    await page.getByTestId('tools-choose').click();
    const replace = page.getByTestId('tools-replace');
    await expect(replace).toContainText('Pack 0.5.0 is already installed.');
    await replace.getByRole('button', { name: 'Keep it' }).click();
    await expect(replace).toHaveCount(0);

    // Jobs shows the new pack without a restart, and the notice is gone
    await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
    await expect(win.locator('.jobs-rt')).toContainText('0.5.0');
    await expect(win.getByTestId('tools-notice')).toHaveCount(0);

    // back in Settings: remove the old pack, with a confirmation
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Processing tools' })
      .click();
    await win.getByTestId('tools-remove-0.2.0').click();
    expect(existsSync(join(runtime, 'pipeline-pack-0.2.0'))).toBe(true);
    await win.getByTestId('tools-remove-confirm-0.2.0').click();
    await expect(win.getByTestId('tools-others')).toHaveCount(0);
    await expect(win.getByTestId('tools-note')).toContainText('pipeline-pack-0.2.0 was moved');
    expect(await readdir(runtime)).toEqual(['pipeline-pack-0.5.0']);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a newer pack file in the data folder is offered, and a dismissed notice stays away', async ({
  dataRoot,
  network,
}) => {
  await writeOldPack(dataRoot, '0.2.0');
  // newer than any real pack that may lie in this machine's Downloads
  await writeArchive(join(dataRoot.root, 'runtime'), '99.1.0');
  const app = await launchApp(dataRoot, ENV);
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await openTinyProject(win);
    const notice = win.getByTestId('tools-notice');
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
    // dismissed for this pack: a reload (the next start of the window) does not bring it back
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await openTinyProject(win);
    // the pack has been read again (Jobs shows it) and the notice still stays away
    await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
    await expect(win.locator('.jobs-rt')).toContainText('0.2.0');
    await win.waitForTimeout(500);
    await expect(win.getByTestId('tools-notice')).toHaveCount(0);

    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Processing tools' })
      .click();
    const offer = win.getByTestId('tools-offer');
    await expect(offer).toContainText(`pipeline-pack-99.1.0-${PLATFORM}.tar.gz`);
    await offer
      .getByRole('button', { name: 'Install pack 99.1.0 found in the data folder' })
      .click();
    await expect(win.getByTestId('tools-note')).toContainText(
      'Processing tools 99.1.0 are installed.',
    );
    await expect(win.getByTestId('tools-state')).toHaveAttribute('data-state', 'ok');
    await expect(win.getByTestId('tools-offer')).toHaveCount(0);
    await win.locator('.sb-nav .nav-item', { hasText: 'Jobs' }).click();
    await expect(win.locator('.jobs-rt')).toContainText('99.1.0');
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

test('an automated run never shows the notice, and a broken file changes nothing', async ({
  dataRoot,
  network,
}) => {
  await writeOldPack(dataRoot, '0.2.0');
  const kit = join(dataRoot.base, 'kit');
  const whole = await writeArchive(kit, '0.5.0');
  const cut = join(kit, 'cut-short.tar.gz');
  const bytes = fakePackArchive('0.6.0', { platform: PLATFORM });
  await writeFile(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
  // as every other spec starts the app: without QUADRION_PACK_NOTICE
  const app = await launchApp(dataRoot, { ...ENV, QUADRION_PACK_NOTICE: '' });
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await stubDialogAndBin(app, cut);
    await openTinyProject(win);
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Processing tools' })
      .click();
    await expect(win.getByTestId('tools-state')).toHaveAttribute('data-state', 'too-old');
    await expect(win.getByTestId('tools-notice')).toHaveCount(0);

    await win.getByTestId('tools-choose').click();
    await expect(win.getByTestId('tools-error')).toContainText('damaged or was cut short');
    await expect(win.getByTestId('tools-state')).toHaveAttribute('data-state', 'too-old');
    expect(await readdir(join(dataRoot.root, 'runtime'))).toEqual(['pipeline-pack-0.2.0']);
    expect(existsSync(whole)).toBe(true);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
