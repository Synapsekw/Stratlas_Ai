/**
 * Settings, Processing tools: installing and updating the pipeline pack from inside the app.
 *
 * A temporary data folder holds an old fake pack (0.2.0, one pipeline) and, outside it, a newer
 * fake pack archive (every pipeline the app knows, checksums in its manifest), both a few
 * kilobytes (`packArchive.fakes.ts`; never the real 400 MB pack). The start notice shows once a
 * project is open, Settings says the pack is too old, installing the archive flips it to up to
 * date, and processing uses the new version without a restart. The native file dialog and
 * the Recycle Bin are stubbed in main; the launch asks for the notice (QUADRION_PACK_NOTICE=1),
 * which an automated run otherwise never shows.
 *
 * The Processing engine card (ODM, ADR 0012) installs from a local stand-in: a loopback server
 * serves `odm-fake/fake-setup.mjs` as the setup, named by a test pin (`QUADRION_ODM_PIN_FILE`),
 * and main runs it with Electron as Node (both only with QUADRION_E2E=1). Nothing is downloaded
 * from the internet and the real ODM setup never runs.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fakePackArchive, fakePackFiles } from '../src/main/jobs/packArchive.fakes';
import {
  closeProcessing,
  expect,
  launchApp,
  NetworkGuard,
  openProcessing,
  test,
  type DataRoot,
} from './fixtures';
import { ODM_FAKE_DIR, PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY } from './photoPack';

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

/**
 * Nothing of the Settings page is cut off or pushed sideways (CI runs a small window,
 * 1100 x 720): the page does not scroll sideways and `inside` lies wholly in the window.
 */
async function expectFits(win: Page, ...inside: (string | Locator)[]): Promise<void> {
  const sideways = await win.locator('.set-body').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(sideways, 'the Settings page scrolls sideways').toBeLessThanOrEqual(1);
  for (const it of inside) {
    const target = typeof it === 'string' ? win.getByTestId(it) : it;
    // centred, not flush with an edge, where a fraction of a pixel can stay clipped (CI's scale 1)
    await target.evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
    });
    await expect(target, String(it)).toBeInViewport({ ratio: 1 });
  }
}

async function openTinyProject(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs')).toContainText('E2E tiny project');
}

/** The version of the processing tools the job runner would use, or null. */
const runtimeVersion = (win: Page) =>
  win.evaluate(async () => {
    const r = await window.aio.invoke('jobs:list', {});
    return r.runtime.found ? r.runtime.version : null;
  });

test('the start notice leads to Settings, where a pack file installs and processing follows', async ({
  dataRoot,
  network,
}, testInfo) => {
  await writeOldPack(dataRoot, '0.2.0');
  const archive = await writeArchive(join(dataRoot.base, 'kit'), '0.8.0');
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
    await expect(notice).toContainText('The processing tools need an update');
    await expect(notice).toContainText('version 0.2.0');
    await expect(notice).toBeInViewport({ ratio: 1 });
    await win.screenshot({ path: testInfo.outputPath('processing-tools-notice.png') });
    await notice.getByRole('button', { name: 'Update processing tools' }).click();

    // Settings, Processing tools: too old, and what for
    await expect(win.getByRole('heading', { level: 1, name: 'Processing tools' })).toBeVisible();
    const page = win.getByTestId('processing-tools');
    await expect(page.getByTestId('tools-state')).toHaveAttribute('data-state', 'too-old');
    await expect(page.getByTestId('tools-state')).toContainText('Too old for this version');
    await expect(page.getByTestId('tools-version')).toHaveText('0.2.0');
    await expect(page.getByTestId('tools-needs')).toContainText('This version cannot run');
    await expect(win.getByTestId('tools-notice')).toHaveCount(0); // not on the page it points at
    await expectFits(win, 'tools-info', 'tools-needs', 'tools-choose');
    await win.screenshot({ path: testInfo.outputPath('processing-tools-too-old.png') });

    // install from the file the dialog answers
    await page.getByTestId('tools-choose').click();
    await expect(page.getByTestId('tools-note')).toContainText(
      'Processing tools 0.8.0 are installed.',
    );
    await expect(page.getByTestId('tools-state')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('tools-state')).toContainText('Up to date');
    await expect(page.getByTestId('tools-version')).toHaveText('0.8.0');
    await expect(page.getByTestId('tools-needs')).toHaveCount(0);
    // the pack is in place, with nothing half-unpacked beside it
    const runtime = join(dataRoot.root, 'runtime');
    expect((await readdir(runtime)).sort()).toEqual(['pipeline-pack-0.2.0', 'pipeline-pack-0.8.0']);
    expect(existsSync(join(runtime, 'pipeline-pack-0.8.0', 'python', 'python.exe'))).toBe(true);

    // the old pack is listed with its size and stays until removed
    const others = win.getByTestId('tools-others');
    await expect(others.getByTestId('tools-pack-0.2.0')).toContainText('0.2.0');
    await expectFits(win, 'tools-note', 'tools-remove-0.2.0');
    await win.screenshot({ path: testInfo.outputPath('processing-tools.png') });

    // the same file again asks before replacing
    await page.getByTestId('tools-choose').click();
    const replace = page.getByTestId('tools-replace');
    await expect(replace).toContainText('Version 0.8.0 is already installed.');
    await expectFits(win, 'tools-replace', 'tools-replace-yes');
    await replace.getByRole('button', { name: 'Keep it' }).click();
    await expect(replace).toHaveCount(0);

    // processing follows without a restart: nothing says the tools are missing, the notice is gone
    await expect.poll(() => runtimeVersion(win)).toBe('0.8.0');
    await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
    const drawer = await openProcessing(win);
    await expect(drawer.getByTestId('proc-tools')).toHaveCount(0);
    await closeProcessing(win);
    await expect(win.getByTestId('tools-notice')).toHaveCount(0);

    // back in Settings: remove the old pack, with a confirmation
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Processing tools' })
      .click();
    await win.getByTestId('tools-remove-0.2.0').click();
    expect(existsSync(join(runtime, 'pipeline-pack-0.2.0'))).toBe(true);
    await expectFits(win, 'tools-remove-confirm-0.2.0');
    await win.getByTestId('tools-remove-confirm-0.2.0').click();
    await expect(win.getByTestId('tools-others')).toHaveCount(0);
    await expect(win.getByTestId('tools-note')).toContainText('pipeline-pack-0.2.0 was moved');
    expect(await readdir(runtime)).toEqual(['pipeline-pack-0.8.0']);
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
    // the pack has been read again and the notice still stays away
    await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).click();
    await expect.poll(() => runtimeVersion(win)).toBe('0.2.0');
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
      .getByRole('button', { name: 'Install version 99.1.0 found in the data folder' })
      .click();
    await expect(win.getByTestId('tools-note')).toContainText(
      'Processing tools 99.1.0 are installed.',
    );
    await expect(win.getByTestId('tools-state')).toHaveAttribute('data-state', 'ok');
    await expect(win.getByTestId('tools-offer')).toHaveCount(0);
    await expect.poll(() => runtimeVersion(win)).toBe('99.1.0');
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
  const bytes = fakePackArchive('0.7.0', { platform: PLATFORM });
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

test('Update processing tools is one way in from Create maps and from the Processing drawer, and leads back', async ({
  dataRoot,
  network,
}) => {
  test.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);
  // no processing tools at all; the processing engine is there (named, as in development)
  const archive = await writeArchive(join(dataRoot.base, 'kit'), '0.8.0');
  const app = await launchApp(dataRoot, {
    ...ENV,
    QUADRION_ODM_DIR: ODM_FAKE_DIR,
    QUADRION_ODM_VERSION: '3.6.2',
  });
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await stubDialogAndBin(app, archive);
    await openTinyProject(win);
    const notice = win.getByTestId('tools-notice');
    await expect(notice).toContainText('The processing tools are not installed');

    // the drawer says it itself ("Processing cannot run yet"): the notice does not say it twice
    const drawer = await openProcessing(win);
    const panel = drawer.getByTestId('proc-tools');
    await expect(panel).toContainText('the processing tools are missing or need an update');
    await expect(notice).toHaveCount(0);
    // nor over the Create maps dialog, which has the same button
    await drawer.getByTestId('create-maps').click();
    const wizard = win.getByRole('dialog', { name: 'Create maps from photos' });
    const blocked = wizard.getByTestId('photo-blocked');
    await expect(blocked).toContainText('The processing tools are not installed');
    await expect(notice).toHaveCount(0);

    // the dialog's button: Settings, Processing tools
    await blocked.getByRole('button', { name: 'Update processing tools' }).click();
    await expect(wizard).toHaveCount(0);
    await expect(win.getByRole('heading', { level: 1, name: 'Processing tools' })).toBeVisible();
    await expect(win.getByTestId('tools-state')).toHaveAttribute('data-state', 'missing');
    await win.getByTestId('tools-choose').click();
    const note = win.getByTestId('tools-note');
    await expect(note).toContainText('Processing tools 0.8.0 are installed.');
    await expectFits(win, 'tools-note', 'tools-resume');

    // and back: the dialog opens again, checks this computer again, and is no longer blocked
    await note.getByRole('button', { name: 'Create maps from photos' }).click();
    await expect(wizard).toBeVisible();
    await expect(wizard.getByTestId('photo-blocked')).toHaveCount(0);
    await expect(wizard.getByTestId('photo-drop')).toBeVisible();
    await wizard.getByRole('button', { name: 'Close' }).first().click();
    await expect.poll(() => runtimeVersion(win)).toBe('0.8.0');
    const after = await openProcessing(win);
    await expect(after.getByTestId('proc-tools')).toHaveCount(0);
    await closeProcessing(win);

    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

test('the Processing drawer opens the same page', async ({ dataRoot, network }) => {
  const app = await launchApp(dataRoot, ENV);
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await openTinyProject(win);
    const drawer = await openProcessing(win);
    await drawer
      .getByTestId('proc-tools')
      .getByRole('button', { name: 'Update processing tools' })
      .click();
    await expect(win.getByRole('heading', { level: 1, name: 'Processing tools' })).toBeVisible();
    await expect(win.getByTestId('tools-state')).toContainText('Not installed');
    // nothing was interrupted, so nothing is offered to go back to
    await expect(win.getByTestId('tools-resume')).toHaveCount(0);
    await expectFits(win, 'tools-info', 'tools-choose');
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- the processing engine (ODM)

/** The stand-in for ODM's setup, served over loopback in place of the GitHub download. */
const FAKE_SETUP = join(import.meta.dirname, 'odm-fake', 'fake-setup.mjs');
const SETUP_NAME = 'ODM_Setup_fake.mjs';
/** REQUIRED_FILES (C4) beyond run.bat and VERSION, which the fake setup writes itself. */
const SETUP_FILES = 'winrun.bat;win32env.bat;venv\\Scripts\\python.exe';
/** Screenshots for a person to look at: only with QUADRION_E2E_SHOTS set to a folder. */
const SHOTS = process.env.QUADRION_E2E_SHOTS;

interface EngineFixtures {
  /** The loopback origin that serves the fake setup. */
  setupOrigin: string;
  /** An empty folder stands for another ODM on this computer (QUADRION_ODM_OTHER, tests only). */
  otherOdm: boolean;
}

const engineTest = test.extend<EngineFixtures>({
  otherOdm: [false, { option: true }],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  setupOrigin: async ({}, use) => {
    const bytes = await readFile(FAKE_SETUP);
    const server = createServer((req, res) => {
      if (req.url !== `/${SETUP_NAME}`) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
      });
      res.end(bytes);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address() as AddressInfo;
    try {
      await use(`http://127.0.0.1:${String(port)}`);
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  },
  network: async ({ setupOrigin }, use) => {
    await use(new NetworkGuard([setupOrigin]));
  },
  // each test has its own data root (the fixtures' dataRoot): the pin names the served setup
  appEnv: async ({ dataRoot, setupOrigin, otherOdm }, use) => {
    const bytes = await readFile(FAKE_SETUP);
    const pin = join(dataRoot.base, 'odm-pin.json');
    await writeFile(
      pin,
      JSON.stringify({
        version: '3.6.2',
        url: `${setupOrigin}/${SETUP_NAME}`,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        installedBytes: 1_000_000,
        file: SETUP_NAME,
      }),
    );
    const env: Record<string, string> = {
      ...ENV,
      // no development ODM: the card installs one into the data folder
      QUADRION_ODM_DIR: '',
      QUADRION_ODM_PIN_FILE: pin,
      FAKE_SETUP_FILES: SETUP_FILES,
      AIO_NETWORK_GUARD_ALLOW: setupOrigin,
    };
    if (otherOdm) {
      env.QUADRION_ODM_OTHER = join(dataRoot.base, 'other-odm');
      await mkdir(env.QUADRION_ODM_OTHER, { recursive: true });
    }
    await use(env);
  },
});

/** Settings, Processing tools: the page with the Processing engine card. */
async function openToolsPage(win: Page): Promise<void> {
  await openTinyProject(win);
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Processing tools' })
    .click();
  await expect(win.getByRole('heading', { level: 1, name: 'Processing tools' })).toBeVisible();
  await win.getByTestId('engine').scrollIntoViewIfNeeded();
}

/** The card in both themes, for a person to look at (QUADRION_E2E_SHOTS only). */
async function shootCard(win: Page, card: Locator, name: string): Promise<void> {
  if (!SHOTS) return;
  await card.screenshot({ path: join(SHOTS, `${name}.png`) });
  await win.screenshot({ path: join(SHOTS, `${name}-window.png`) });
  const theme = await win.evaluate(() => document.documentElement.dataset.theme ?? '');
  const other = theme === 'dark' ? 'light' : 'dark';
  await win.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, other);
  await card.screenshot({ path: join(SHOTS, `${name}-${other}.png`) });
  await win.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
}

engineTest.describe('Processing engine', () => {
  engineTest.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);

  engineTest('installs the engine from Settings and removes it again', async ({ win }) => {
    await openToolsPage(win);
    const card = win.getByTestId('engine');
    await expect(card.getByTestId('engine-state')).toHaveAttribute('data-state', 'not-installed');
    await expect(card.getByTestId('engine-about')).toContainText('AGPL-3.0');
    // a computer with an ODM of its own (a developer's) is asked first; CI has none
    const other = await win.evaluate(() =>
      window.aio.invoke('odm:status', {}).then((s) => s.other !== null),
    );
    await card.getByTestId('engine-install').click();
    if (other) await card.getByTestId('engine-replace-yes').click();
    await expect(card.getByTestId('engine-progress')).toBeVisible();
    await shootCard(win, card, 'engine-installing');
    await expect(card.getByTestId('engine-state')).toHaveAttribute('data-state', 'installed', {
      timeout: 30_000,
    });
    await expect(card.getByTestId('engine-version')).toContainText('3.6.2');
    await expectFits(win, card);
    await shootCard(win, card, 'engine-installed');
    const gpu = card.getByTestId('engine-gpu');
    if (await gpu.isEnabled()) {
      await gpu.click();
      await expect(gpu).toHaveAttribute('aria-checked', 'false');
      await expect
        .poll(() =>
          win.evaluate(() => window.aio.invoke('odm:status', {}).then((s) => s.gpu.setting)),
        )
        .toBe('off');
    } else {
      await expect(gpu).toBeDisabled(); // no NVIDIA card here (CI): the switch cannot be used
    }
    await card.getByTestId('engine-remove').click();
    await card.getByTestId('engine-remove-confirm').click();
    await expect(card.getByTestId('engine-state')).toHaveAttribute('data-state', 'not-installed');
    await expectFits(win, card);
  });

  engineTest.describe(() => {
    // the app was started with QUADRION_ODM_OTHER pointing at an empty folder (tests only)
    engineTest.use({ otherOdm: true });

    engineTest('another ODM asks before installing', async ({ win }) => {
      await openToolsPage(win);
      const card = win.getByTestId('engine');
      await card.getByTestId('engine-install').click();
      await expect(card.getByTestId('engine-replace')).toContainText('Installing replaces it');
      await expectFits(win, 'engine-replace', 'engine-replace-yes');
      await card.getByTestId('engine-replace-yes').click();
      await expect(card.getByTestId('engine-state')).toHaveAttribute('data-state', 'installed', {
        timeout: 30_000,
      });
    });
  });
});
