/**
 * A first start on a clean machine (M7 review focus): no data folder, no map packs, no pipeline
 * pack, no network. The welcome explains each missing piece and still opens the bundled demo
 * project, as a working copy in the profile, never writing the bundled folder or the data folder.
 *
 * Uses the demo built by `node tools/demo/build-demo.mjs` (`--quick` is enough) in
 * apps/desktop/demo, or QUADRION_E2E_DEMO; skipped when there is none (CI builds it first).
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DEMO = process.env.QUADRION_E2E_DEMO ?? join(import.meta.dirname, '..', 'demo');
/** Optional folder for screenshots of the welcome and both demo projects (user guide, Store). */
const SHOTS = process.env.QUADRION_E2E_SHOTS;
const shot = async (win: Page, name: string) => {
  if (!SHOTS) return;
  await win.waitForTimeout(2500);
  await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        project: { root: string; manifest: { id: string; layers: { kind: string }[] } } | null;
        issues: { code: string; sightings: { on: string }[] }[];
      };
    };
    volumetric: { getState(): { status: string } };
  };
}

const test = base.extend<{ base: string; app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  base: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-first-start-'));
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
  app: async ({ base: dir }, use) => {
    const network = new NetworkGuard();
    const app = await launchApp(
      {
        base: dir,
        // a data folder that does not exist yet
        root: join(dir, 'Stratlas Data'),
        userData: join(dir, 'user'),
        projectId: '',
        projectDir: '',
      },
      // no pipeline pack: neither a development Python nor a pack folder
      { QUADRION_DEMO: DEMO, QUADRION_PIPELINE_PYTHON: '', QUADRION_PIPELINE_PACK: '' },
    );
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
    }
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

test.skip(
  !existsSync(join(DEMO, 'demo.json')),
  `no demo project in ${DEMO}: run node tools/demo/build-demo.mjs --quick`,
);

test('a clean first start explains what is missing and opens the demo project', async ({
  win,
  base: dir,
}) => {
  test.setTimeout(120_000);
  const welcome = win.getByTestId('first-start');
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText('Open the demo project');

  // each missing piece, in words
  const row = (id: string) => win.getByTestId(`setup-${id}`);
  await expect(row('data')).toHaveAttribute('data-state', 'warn');
  await expect(row('data')).toContainText('Not created yet');
  await expect(row('data')).toContainText(join(dir, 'Stratlas Data'));
  await expect(row('maps')).toContainText('No map pack installed');
  await expect(row('maps')).toContainText('own orthomosaics');
  await expect(row('pipeline')).toContainText('Not installed');
  await expect(row('pipeline')).toContainText('work without it');
  await expect(row('network')).toContainText('Not needed');

  // the demo projects in the library, marked as demos: the 0.7.0 two and the M8 change demo
  const cards = win.getByTestId('project-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.filter({ hasText: '2 dates' })).toHaveCount(1);
  await expect(cards.first()).toContainText('Demo');

  await shot(win, 'first-start');

  await win.getByTestId('open-demo').click();
  const inspect = () =>
    win.evaluate(() => {
      const s = (window as unknown as Inspect).__stratlas;
      const w = s.workspace.getState();
      return {
        root: w.project?.root ?? null,
        id: w.project?.manifest.id ?? null,
        kinds: [...new Set(w.project?.manifest.layers.map((l) => l.kind) ?? [])].sort(),
        issues: w.issues.map((i) => i.code),
        onVideo: w.issues.filter((i) => i.sightings.some((x) => x.on === 'video')).length,
        volumes: s.volumetric.getState().status,
      };
    });
  await expect.poll(async () => (await inspect()).id, { timeout: 60_000 }).toBe('demo-tank-farm');
  await expect.poll(async () => (await inspect()).volumes, { timeout: 60_000 }).toBe('ready');
  const opened = await inspect();
  // the working copy in the profile, not the bundled folder
  expect(opened.root).toBe(join(dir, 'user', 'demo', 'demo-tank-farm'));
  expect(opened.kinds).toEqual(['mesh', 'photos', 'pointcloud', 'raster', 'video']);
  expect(opened.issues).toEqual(['F01', 'F02', 'F03', 'F04', 'F05', 'F06']);
  expect(opened.onVideo).toBeGreaterThan(0);
  await shot(win, 'demo-tank-farm');

  // nothing was written into the data folder or the bundled demo
  expect(existsSync(join(dir, 'Stratlas Data'))).toBe(false);
  const bundled = JSON.parse(
    await readFile(join(DEMO, 'demo-tank-farm', 'issues.json'), 'utf8'),
  ) as {
    issues: unknown[];
  };
  expect(bundled.issues).toHaveLength(6);

  // the road demo opens in the road workspace
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'Demo access road' }).click();
  await expect.poll(async () => (await inspect()).id, { timeout: 60_000 }).toBe('demo-access-road');
  await expect(win.getByTestId('defect-count')).toHaveText('14 of 14 defects', { timeout: 60_000 });
  // no map pack: the map still runs with the project's own ortho and overlays
  await expect(win.getByTestId('map-no-packs').first()).toBeVisible();
  await shot(win, 'demo-access-road');
});
