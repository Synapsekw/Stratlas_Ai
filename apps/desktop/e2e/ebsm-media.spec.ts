/**
 * The Media screen on the real EBSM flare project (299 photos of 2560 px). Runs only where the
 * real data holds projects/ebsm (realData.ts); skipped elsewhere. Each test runs on a temporary
 * copy of the project (@realdata); generated thumbnails go to the throwaway profile.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, realDataTest } from './fixtures';
import {
  copyRealProjects,
  hasRealProject,
  missingRealProject,
  onlyPaths,
  realProjectDir,
} from './realData';

const EBSM = realProjectDir('ebsm');
/** Media must answer input within this many ms of opening (first run, cold thumbnail cache). */
const BUDGET_MS = Number(process.env.QUADRION_MEDIA_BUDGET_MS ?? 3_000);

const test = realDataTest(['ebsm'], { size: [1440, 900] });

test.skip(!hasRealProject('ebsm'), missingRealProject('ebsm'));
test.setTimeout(180_000);

interface Probe {
  longTasks: number[];
  gaps: number[];
  stop: boolean;
  /** In-page times (performance.now): the click, the first frame with the photo grid, the
   * first frame with the first 8 tiles' pictures loaded. */
  clickAt?: number;
  gridAt?: number;
  thumbsAt?: number;
}

/**
 * Long tasks, frame gaps and Media timings measured inside the renderer from now on, so the
 * numbers do not include Playwright's own round trips.
 */
async function startProbe(win: Page): Promise<void> {
  await win.evaluate(() => {
    const p: Probe = { longTasks: [], gaps: [], stop: false };
    (window as unknown as { __probe: Probe }).__probe = p;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) p.longTasks.push(e.duration);
    }).observe({ type: 'longtask', buffered: false });
    document.addEventListener(
      'click',
      () => {
        p.clickAt ??= performance.now();
      },
      { capture: true, once: true },
    );
    let last = performance.now();
    const tick = (t: number) => {
      p.gaps.push(t - last);
      last = t;
      if (p.clickAt !== undefined && p.gridAt === undefined) {
        if (document.querySelector('.media .m-card.sq')) p.gridAt = t;
      }
      if (p.gridAt !== undefined && p.thumbsAt === undefined) {
        const imgs = [...document.querySelectorAll<HTMLImageElement>('.media .m-grid img')];
        if (imgs.length >= 8 && imgs.slice(0, 8).every((i) => i.complete && i.naturalWidth > 0))
          p.thumbsAt = t;
      }
      if (!p.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Wait for the first tiles to show their pictures; ms from the click, measured in the page. */
async function waitForTiles(win: Page): Promise<{ gridMs: number; tilesMs: number }> {
  await expect
    .poll(
      () =>
        win.evaluate(
          () => (window as unknown as { __probe: Probe }).__probe.thumbsAt !== undefined,
        ),
      { timeout: 60_000, intervals: [100] },
    )
    .toBe(true);
  return win.evaluate(() => {
    const p = (window as unknown as { __probe: Probe }).__probe;
    const click = p.clickAt ?? 0;
    return {
      gridMs: Math.max(0, Math.round((p.gridAt ?? 0) - click)),
      tilesMs: Math.max(0, Math.round((p.thumbsAt ?? 0) - click)),
    };
  });
}

async function readProbe(win: Page) {
  return win.evaluate(() => {
    const p = (window as unknown as { __probe: Probe }).__probe;
    p.stop = true;
    const imgs = [...document.querySelectorAll<HTMLImageElement>('.media .m-grid img')];
    const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0);
    return {
      longTasks: p.longTasks.length,
      longTaskMs: Math.round(p.longTasks.reduce((a, b) => a + b, 0)),
      worstLongTaskMs: Math.round(Math.max(0, ...p.longTasks)),
      worstFrameGapMs: Math.round(Math.max(0, ...p.gaps)),
      imgElements: imgs.length,
      imgsLoaded: loaded.length,
      decodedMB: Math.round(
        loaded.reduce((a, i) => a + i.naturalWidth * i.naturalHeight * 4, 0) / 1e6,
      ),
      maxNaturalWidth: Math.max(0, ...loaded.map((i) => i.naturalWidth)),
    };
  });
}

async function memoryMB(app: ElectronApplication) {
  return app.evaluate(({ app: a }) => {
    const m = a.getAppMetrics();
    const kb = (type: string) =>
      m.filter((p) => p.type === type).reduce((s, p) => s + p.memory.workingSetSize, 0);
    return {
      renderer: Math.round(kb('Tab') / 1024),
      gpu: Math.round(kb('GPU') / 1024),
      browser: Math.round(kb('Browser') / 1024),
    };
  });
}

/** Round trip of a click through the renderer: how long input waits behind other work. */
async function inputLatency(win: Page): Promise<number> {
  const t0 = Date.now();
  await win.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => {
          r();
        });
      }),
  );
  return Date.now() - t0;
}

test('@realdata EBSM Media opens fast, shows small thumbnails and stays responsive', async ({
  app,
  win,
}) => {
  await win.getByTestId('project-card').filter({ hasText: 'EBSM' }).first().click();
  await expect(win.locator('.nav-item', { hasText: 'Media' }).first()).toBeVisible();
  // Let the project (3D scene) settle before measuring the Media screen itself.
  await win.waitForTimeout(4_000);
  const memBefore = await memoryMB(app);
  await startProbe(win);

  await win.locator('.nav-item', { hasText: 'Media' }).first().click();
  // Interactive: the first tiles have drawn and input is answered promptly.
  const { gridMs, tilesMs } = await waitForTiles(win);
  const latency = await inputLatency(win);

  // Scroll through the whole grid, then let it settle.
  const scroller = win.locator('.media-main');
  for (let i = 0; i < 12; i++) {
    await scroller.evaluate((el) => {
      el.scrollBy(0, 700);
    });
    await win.waitForTimeout(150);
  }
  await win.waitForTimeout(2_000);
  const scrollLatency = await inputLatency(win);
  const probe = await readProbe(win);
  const memAfter = await memoryMB(app);

  // Opening a photo still works.
  await win.locator('.media .m-card.sq').first().click();
  await expect(win.locator('.media-viewer')).toBeVisible();

  const report = {
    gridMs,
    tilesMs,
    latency,
    scrollLatency,
    ...probe,
    memBefore,
    memAfter,
  };
  console.warn(`EBSM Media: ${JSON.stringify(report)}`);

  expect(tilesMs).toBeLessThan(BUDGET_MS);
  expect(probe.worstLongTaskMs).toBeLessThan(200);
  expect(probe.maxNaturalWidth).toBeLessThanOrEqual(640);
});

/** Photos the second test copies into a project without thumbnails. */
const COLD_PHOTOS = 36;

/** Every file under `dir`, relative, sorted. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name).slice(dir.length + 1));
  }
  return out.sort();
}

test('@realdata photos without thumbnails get small ones made off the main thread and cached', async () => {
  // A copy of some EBSM photos without the project's thumbs/ folder (temp data root).
  const src = JSON.parse(readFileSync(join(EBSM, 'manifest.json'), 'utf8')) as {
    layers: { kind: string; items?: { src: { path: string } }[] }[];
  } & Record<string, unknown>;
  const photos = src.layers.find((l) => l.kind === 'photos');
  const items = (photos?.items ?? []).slice(0, COLD_PHOTOS);
  const data = await copyRealProjects(['ebsm'], {
    rename: { ebsm: 'ebsm-cold' },
    include: onlyPaths(['manifest.json', ...items.map((it) => it.src.path)]),
    manifest: (m) => ({
      ...m,
      id: 'ebsm-cold',
      name: 'EBSM cold thumbnails',
      layers: [{ ...photos, items }],
    }),
  });
  const dir = data.projectDir;
  const userData = data.userData;
  await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues: [] }));
  const before = await tree(dir);

  const open = async () => {
    const network = new NetworkGuard();
    const app = await launchApp(data);
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByTestId('project-card').filter({ hasText: 'EBSM cold' }).first().click();
    // Let the project (3D scene) settle first, as above: on a software GPU its first frames are
    // long tasks of their own, and the probe measures the Media screen.
    await expect(win.locator('.nav-item', { hasText: 'Media' }).first()).toBeVisible();
    await win.waitForTimeout(4_000);
    await startProbe(win);
    await win.locator('.nav-item', { hasText: 'Media' }).first().click();
    const ms = (await waitForTiles(win)).tilesMs;
    await win.waitForTimeout(1_500);
    const probe = await readProbe(win);
    const srcs = await win.evaluate(() =>
      [...document.querySelectorAll<HTMLImageElement>('.media .m-grid img')].map((i) => i.src),
    );
    expect(await network.outbound()).toEqual([]);
    await app.close();
    return { ms, probe, srcs };
  };

  try {
    const cold = await open();
    console.warn(`EBSM Media, cold thumbnails: ${JSON.stringify({ ms: cold.ms, ...cold.probe })}`);
    expect(cold.ms).toBeLessThan(BUDGET_MS * 2);
    expect(cold.probe.maxNaturalWidth).toBeLessThanOrEqual(320);
    expect(cold.probe.worstLongTaskMs).toBeLessThan(200);
    // Thumbnails went to the profile's cache; the project folder is unchanged.
    const cached = await tree(join(userData, 'cache', 'thumbs'));
    expect(cached.length).toBeGreaterThanOrEqual(8);
    expect(await tree(dir)).toEqual(before);

    // Next time they come from the cache, made by nobody.
    const warm = await open();
    console.warn(
      `EBSM Media, cached thumbnails: ${JSON.stringify({ ms: warm.ms, ...warm.probe })}`,
    );
    expect(warm.srcs.slice(0, 8).every((s) => s.startsWith('aio://thumb/'))).toBe(true);
    expect(warm.probe.maxNaturalWidth).toBeLessThanOrEqual(320);
  } finally {
    await data.dispose();
  }
});
