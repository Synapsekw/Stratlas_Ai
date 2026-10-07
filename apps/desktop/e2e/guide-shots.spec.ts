/**
 * Screenshots for the user guide, one per entry of GUIDE_SHOTS (guideShots.ts), taken in an
 * off-screen window at 1280 x 800 with only the bundled demo projects (synthetic, tools/demo) in
 * the library. Every run checks that each shot can be reached; with QUADRION_GUIDE_SHOTS=1 the
 * PNGs are written to docs/guide/images (else into the test output folder), where the in-app
 * help and the PDF guide pick them up. Skipped when the demo is not built (CI builds it first).
 *
 *   QUADRION_GUIDE_SHOTS=1 pnpm -F @aio/desktop exec playwright test guide-shots --workers=1
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';
import { DEMO_DIR, GUIDE_SHOTS } from './guideShots';

const IMAGES = join(import.meta.dirname, '../../../docs/guide/images');
const WIDTH = 1280;
const HEIGHT = 800;

/**
 * An empty data folder, so the library holds only the demo projects (from QUADRION_DEMO); not
 * created at all for a first start.
 */
async function dataRoot(create: boolean): Promise<DataRoot> {
  const base = await mkdtemp(join(tmpdir(), 'aio-guide-'));
  const root = join(base, 'data');
  const userData = join(base, 'user');
  await mkdir(userData, { recursive: true });
  if (create) {
    await mkdir(join(root, 'projects'), { recursive: true });
    await mkdir(join(root, 'packs'), { recursive: true });
  }
  return { base, root, userData, projectId: '', projectDir: '' };
}

/**
 * The guide shows the default folders and a neutral account name, not this run's temporary
 * folders and the account of the machine that took the shots.
 */
async function showDefaults(win: Page, data: DataRoot): Promise<void> {
  const user = userInfo().username;
  const swaps: [string, string][] = [
    [data.root, 'C:\\Users\\you\\Documents\\Stratlas Data'],
    [data.userData, 'C:\\Users\\you\\AppData\\Roaming\\Quadrion AI'],
    [`account name, ${user}.`, 'account name, you.'],
  ];
  await win.evaluate(
    ({ pairs, user }) => {
      const swap = (s: string) => pairs.reduce((t, [from, to]) => t.split(from).join(to), s);
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode())
        if (n.nodeValue) n.nodeValue = swap(n.nodeValue);
      for (const el of document.querySelectorAll('input')) {
        el.value = swap(el.value);
        if (el.placeholder === user) el.placeholder = 'you';
      }
    },
    { pairs: swaps, user },
  );
}

test.skip(
  !existsSync(join(DEMO_DIR, 'demo.json')),
  `no demo project in ${DEMO_DIR}: run pnpm demo:build --quick`,
);

for (const shot of GUIDE_SHOTS) {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  test(`guide screenshot ${shot.id} (${shot.chapter})`, async ({}, testInfo) => {
    const data = await dataRoot(shot.id !== 'first-start');
    const app = await launchApp(data, { QUADRION_DEMO: DEMO_DIR });
    const network = new NetworkGuard();
    try {
      await network.attach(app);
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h);
        },
        { w: WIDTH, h: HEIGHT },
      );
      if (shot.project) {
        const card = win.getByTestId('project-card').filter({ hasText: shot.project.name });
        await card.click();
        await expect(win.locator('.crumbs')).toContainText(shot.project.name);
      }
      await shot.setup(win);
      // let the 3D view and the thumbnails settle; hide the build stamp (it changes every build)
      await win.addStyleTag({ content: '[data-testid="build-stamp"]{visibility:hidden}' });
      await win.waitForTimeout(1200);
      await showDefaults(win, data);
      const dir = process.env.QUADRION_GUIDE_SHOTS === '1' ? IMAGES : testInfo.outputPath();
      await mkdir(dir, { recursive: true });
      await win.screenshot({
        path: join(dir, `${shot.id}.png`),
        animations: 'disabled',
        scale: 'css',
      });
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
      await rm(data.base, { recursive: true, force: true });
    }
  });
}
