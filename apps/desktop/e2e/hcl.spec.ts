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

interface StageInspect {
  __stratlas: {
    workspace: {
      getState(): {
        playing: boolean;
        hidden: Record<string, true>;
        project: { manifest: { layers: { id: string; kind: string }[] } } | null;
        setTime(t: number): void;
        setActiveClip(id: string): void;
        play(): void;
        pause(): void;
      };
    };
    stage(): {
      labelMode: string;
      section: { enabled: boolean };
      saveView(): { position: number[]; target: number[] };
      scene: { getObjectByName(n: string): { children: { count?: number }[] } | undefined };
    } | null;
  };
}

/** Run a probe in the renderer with the app's inspection hook typed. */
async function inspect<T>(win: Page, fn: (w: StageInspect) => T): Promise<T> {
  const handle = await win.evaluateHandle(() => window);
  try {
    return await win.evaluate(fn as unknown as (w: Window) => T, handle);
  } finally {
    await handle.dispose();
  }
}

async function openHcl(app: ElectronApplication, win: Page, width = 1440, height = 900) {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(w ?? 1440, h ?? 900);
    },
    [width, height],
  );
  await win.getByTestId('project-card').filter({ hasText: 'HCl' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  await expect
    .poll(
      () =>
        inspect(
          win,
          (w) => w.__stratlas.stage()?.scene.getObjectByName('layer:tank') !== undefined,
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
}

/** Rows the stage toolbar's items sit on (by their vertical centres). */
const toolbarRows = (win: Page) =>
  win.evaluate(() => {
    const mids = [...document.querySelectorAll('.stbar > :not(.stbar-sp)')].map((e) => {
      const r = e.getBoundingClientRect();
      return Math.round((r.top + r.bottom) / 2 / 8);
    });
    return new Set(mids).size;
  });

test('stage polish: one-row toolbar, label modes, annotate tools on demand, camera memory', async ({
  app,
  win,
}) => {
  await openHcl(app, win);

  // The toolbar fits one row at 1440 px without an overflow menu.
  await expect.poll(() => toolbarRows(win)).toBe(1);
  await expect(win.getByRole('button', { name: 'More tools' })).toHaveCount(0);

  // Key labels by default: a few group callouts, not every component.
  const callouts = () => win.locator('[data-callout]').count();
  await expect.poll(() => inspect(win, (w) => w.__stratlas.stage()?.labelMode)).toBe('key');
  await expect.poll(callouts).toBeGreaterThan(2);
  expect(await callouts()).toBeLessThanOrEqual(12);
  await win.keyboard.press('l');
  await expect.poll(callouts).toBeGreaterThan(40);
  await win.keyboard.press('l');
  await expect.poll(callouts).toBe(0);
  await win.keyboard.press('l');

  // The annotation tools show only in Annotate mode.
  await expect(win.locator('.ann-subbar')).toHaveCount(0);
  await win.keyboard.press('a');
  await expect(win.locator('.ann-subbar').getByRole('button', { name: 'Pin' })).toBeVisible();
  await win.keyboard.press('a');
  await expect(win.locator('.ann-subbar')).toHaveCount(0);

  // Space plays and pauses even right after clicking a stage tool.
  await win.getByRole('button', { name: 'Measure a distance' }).click();
  await win.keyboard.press('Space');
  await expect.poll(async () => (await clock(win)).playing).toBe(true);
  await win.keyboard.press('Space');
  await expect.poll(async () => (await clock(win)).playing).toBe(false);
  await win.keyboard.press('Escape');

  // The map's zoom buttons sit clear of the right panel toggle.
  await win.keyboard.press('2');
  const zoom = win.locator('.maplibregl-ctrl-top-right');
  await expect(zoom).toBeVisible({ timeout: 15_000 });
  const z = await zoom.boundingBox();
  const t = await win.getByRole('button', { name: /right panel/ }).boundingBox();
  if (!z || !t) throw new Error('no zoom control or panel toggle');
  expect(z.y >= t.y + t.height || t.y >= z.y + z.height || z.x >= t.x + t.width).toBe(true);
  await win.keyboard.press('1');

  // Leaving the scene and coming back keeps the camera.
  await win.keyboard.press('h');
  await win.waitForTimeout(1500);
  const canvas = await win.locator('[data-scene-view] canvas').boundingBox();
  if (!canvas) throw new Error('no canvas');
  await win.mouse.move(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.4);
  await win.mouse.down();
  await win.mouse.move(canvas.x + canvas.width * 0.45, canvas.y + canvas.height * 0.35, {
    steps: 8,
  });
  await win.mouse.up();
  await win.waitForTimeout(1500);
  const before = await inspect(win, (w) => w.__stratlas.stage()?.saveView());
  await win.locator('.nav-item', { hasText: 'Issues' }).first().click();
  await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
  await expect.poll(() => inspect(win, (w) => w.__stratlas.stage() !== null)).toBe(true);
  await win.waitForTimeout(3000);
  const after = await inspect(win, (w) => w.__stratlas.stage()?.saveView());
  if (!before || !after) throw new Error('no view');
  for (let i = 0; i < 3; i++) expect(after.position[i]).toBeCloseTo(before.position[i] ?? 0, 0);

  // At 1100 px the toolbar still fits one row, with the rest under More.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800);
  });
  await expect(win.getByRole('button', { name: 'More tools' })).toBeVisible();
  await expect.poll(() => toolbarRows(win)).toBe(1);
});

test('playing inside the tank cuts it open; photos and flights reach Media', async ({
  app,
  win,
}) => {
  await openHcl(app, win);
  // 257 posed photos drawn as frustums
  await expect
    .poll(() =>
      inspect(
        win,
        (w) => w.__stratlas.stage()?.scene.getObjectByName('photos:photos')?.children[2]?.count,
      ),
    )
    .toBe(257);

  // Flight 101, clip 3: the drone is inside the tank.
  const bar = win.locator('.seg-c.grp').first();
  const box = await bar.boundingBox();
  if (!box) throw new Error('no flight bar');
  await bar.click({ position: { x: box.width * 0.4, y: box.height / 2 } });
  await expect
    .poll(() => inspect(win, (w) => w.__stratlas.stage()?.section.enabled), { timeout: 20_000 })
    .toBe(true);
  await expect(win.getByText('Cut open at the drone', { exact: false })).toBeVisible();
  const cloudsHidden = await inspect(win, (w) => {
    const s = w.__stratlas.workspace.getState();
    return (s.project?.manifest.layers ?? [])
      .filter((l) => l.kind === 'pointcloud')
      .every((l) => s.hidden[l.id]);
  });
  expect(cloudsHidden).toBe(true);
  // Close restores the section and the clouds.
  await win.locator('.ss-cut').getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => inspect(win, (w) => w.__stratlas.stage()?.section.enabled)).toBe(false);
  await win.keyboard.press('Space');

  // Media groups the 76 clips into 10 flights.
  await win.locator('.nav-item', { hasText: 'Media' }).first().click();
  await expect(win.locator('.m-flight')).toHaveCount(10);
  await expect(win.locator('#m-flight-clips .m-card')).toHaveCount(7);
});
