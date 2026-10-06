/**
 * Screenshots for the user guide, one per entry of GUIDE_SHOTS (guideShots.ts), taken in an
 * off-screen window at 1280 x 800 from synthetic data only. Every run checks that each shot can
 * be reached; with STRATLAS_GUIDE_SHOTS=1 the PNGs are written to docs/guide/images (else into
 * the test output folder), where the in-app help and the PDF guide pick them up.
 *
 *   STRATLAS_GUIDE_SHOTS=1 pnpm -F @aio/desktop exec playwright test guide-shots --workers=1
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test, tinyGlb, type DataRoot } from './fixtures';
import { GUIDE_SHOTS, writeGuideSample } from './guideShots';

const IMAGES = join(import.meta.dirname, '../../../docs/guide/images');
const WIDTH = 1280;
const HEIGHT = 800;

async function dataRootFor(withSample: boolean): Promise<DataRoot> {
  const base = await mkdtemp(join(tmpdir(), 'aio-guide-'));
  const root = join(base, 'data');
  const userData = join(base, 'user');
  await mkdir(userData, { recursive: true });
  await mkdir(join(root, 'projects'), { recursive: true });
  await mkdir(join(root, 'packs'), { recursive: true });
  if (withSample) await writeGuideSample(root, tinyGlb());
  return { base, root, userData, projectId: '', projectDir: '' };
}

for (const shot of GUIDE_SHOTS) {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  test(`guide screenshot ${shot.id} (${shot.chapter})`, async ({}, testInfo) => {
    const data = await dataRootFor(shot.project !== null);
    const app = await launchApp(data);
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
      const dir = process.env.STRATLAS_GUIDE_SHOTS === '1' ? IMAGES : testInfo.outputPath();
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
