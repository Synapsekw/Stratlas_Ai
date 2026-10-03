/**
 * End to end on the real HCl tank project (1 mesh, 10 point clouds, 76 clips, 11 issues). Runs
 * only on machines that hold the project at E:\Stratlas Data\projects\hcl (or under
 * STRATLAS_HCL_DATA); skipped elsewhere. Read-only: it never edits the project.
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const HCL = join(DATA, 'projects', 'hcl');

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        nowMs: number;
        playing: boolean;
        activeClip: string | null;
        issues: unknown[];
        pause(): void;
      };
    };
  };
}

const test = base.extend<{ app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  app: async ({}, use) => {
    const base = await mkdtemp(join(tmpdir(), 'aio-hcl-'));
    const network = new NetworkGuard();
    const app = await launchApp({
      base,
      root: DATA,
      userData: join(base, 'user'),
      projectId: 'hcl',
      projectDir: HCL,
    });
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
      await rm(base, { recursive: true, force: true });
    }
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

test.skip(!existsSync(join(HCL, 'manifest.json')), `HCl project not found at ${HCL}`);
test.setTimeout(180_000);

const clock = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Inspect).__stratlas.workspace.getState();
    return {
      nowMs: s.nowMs,
      playing: s.playing,
      activeClip: s.activeClip,
      issues: s.issues.length,
    };
  });

test('HCl opens with a drawn 3D scene, plays a clip and lists its 11 issues', async ({ win }) => {
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await win.getByTestId('project-card').filter({ hasText: 'HCl' }).first().click();
  const canvas = win.locator('[data-scene-view] canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await clock(win)).issues, { timeout: 30_000 }).toBe(11);

  // The tank mesh has loaded into the scene ...
  await expect
    .poll(
      () =>
        win.evaluate(() => {
          const stage = (
            window as unknown as {
              __stratlas: { stage(): { scene: { getObjectByName(n: string): unknown } } | null };
            }
          ).__stratlas.stage();
          return stage?.scene.getObjectByName('layer:tank') !== undefined;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  // ... and the canvas shows it with the clouds and overlays: far from a flat colour.
  await expect
    .poll(
      async () => {
        const stats = await sharp(await canvas.screenshot()).stats();
        return Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev));
      },
      { timeout: 45_000, intervals: [1_000] },
    )
    .toBeGreaterThan(12);

  // Clips are grouped by flight; clicking a flight bar plays the clip under the cursor.
  const bar = win.locator('.seg-c.grp').first();
  const box = await bar.boundingBox();
  if (!box) throw new Error('no flight bar in the timeline');
  await bar.click({ position: { x: box.width * 0.4, y: box.height / 2 } });
  const start = await clock(win);
  expect(start.playing).toBe(true);
  expect(start.activeClip).toMatch(/^video-101-/);
  await expect
    .poll(async () => (await clock(win)).nowMs - start.nowMs, { timeout: 20_000 })
    .toBeGreaterThan(1_500);
  await expect
    .poll(() =>
      win.evaluate(
        () =>
          document.querySelector<HTMLVideoElement>('[data-video-window] video')?.currentTime ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas.workspace.getState().pause();
  });

  await win.locator('.nav-item', { hasText: 'Issues' }).first().click();
  await expect(win.locator('.nav-item', { hasText: 'Issues' }).locator('.count')).toHaveText('11');
  await expect(win.getByText('F05', { exact: true }).first()).toBeVisible();

  expect(errors).toEqual([]);
});
