/**
 * Performance budgets.
 *
 * Real projects (PRD NFR: 60 fps in the Al-Zour and HCl workspaces on the reference workstation):
 * flies a recorded camera path (e2e/perf/<project>.path.json) with the perf HUD on and asserts the
 * 95th percentile frame time stays under the budget for this machine: STRATLAS_PERF_P95_MS,
 * default 20 ms (no more than 5 % of frames miss a 60 Hz refresh by more than a few ms). Skipped
 * where the projects are absent. Read-only.
 *
 * Everywhere (CI included): a synthetic project (the 16 000 point COPC fixture, a quad, a
 * 4800 x 2400 ortho image) on the software GPU (SwiftShader), which the app must detect as the Low
 * tier. Startup: launch to an interactive Projects screen within STRATLAS_STARTUP_MS (default
 * 15 s) and project click to the first stage frame within STRATLAS_FIRST_FRAME_MS (default 8 s).
 * Frames: the recorded path (e2e/perf/synthetic.path.json) at a p95 under STRATLAS_PERF_LOW_P95_MS
 * (default 250 ms: generous for a 2 vCPU runner rendering in software, but a 2x regression of the
 * usual 40 to 110 ms trips it). Low tier limits hold (ortho texture scaled to 4096 px, graphics
 * memory under the tier cap), and a lost WebGL context steps down, says so calmly and draws again.
 * Numbers are attached to the test results.
 *
 * Run with --workers=1: the numbers mean nothing with other GPU work running.
 */
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  createDataRoot,
  expect,
  launchApp,
  NetworkGuard,
  SOFTWARE_GPU,
  tinyManifest,
  type DataRoot,
} from './fixtures';

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const BUDGET_MS = Number(process.env.STRATLAS_PERF_P95_MS ?? 20);
const SHOTS = process.env.STRATLAS_SHOTS;

interface View {
  position: [number, number, number];
  target: [number, number, number];
}
interface CameraPath {
  project: string;
  card: string;
  durationMs: number;
  keys: View[];
}
interface Flight {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  fps: number;
  maxPoints: number;
  meanPoints: number;
  calls: number;
  gpuBytes: number;
  loadedPoints: number;
  totalPoints: number;
  renderer: string | null;
  tier: string;
}

const test = base.extend<{ app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  app: async ({}, use) => {
    const tmp = await mkdtemp(join(tmpdir(), 'aio-perf-'));
    const network = new NetworkGuard();
    const app = await launchApp({
      base: tmp,
      root: DATA,
      userData: join(tmp, 'user'),
      projectId: '',
      projectDir: '',
    });
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
      await rm(tmp, { recursive: true, force: true });
    }
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await use(win);
  },
});

test.setTimeout(240_000);

const pathFor = (id: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'perf', `${id}.path.json`), 'utf8'),
  ) as CameraPath;

/** Fly the path inside the page: one view per animation frame, frame times from rAF stamps. */
function fly(win: Page, path: CameraPath): Promise<Flight> {
  return win.evaluate(async (p) => {
    interface Stage {
      restoreView(v: View, animate?: boolean): void;
      perfStats(): { points: number; calls: number; gpuBytes: number };
    }
    interface W {
      __stratlas: {
        stage(): Stage | null;
        graphics(): { getState(): { renderer: string | null; tier: string } };
      };
    }
    const w = window as unknown as W;
    const stage = w.__stratlas.stage();
    if (!stage) throw new Error('no stage');
    const lerp = (a: number[], b: number[], t: number) =>
      a.map((v, i) => v + ((b[i] ?? v) - v) * t);
    const smooth = (t: number) => t * t * (3 - 2 * t);
    const at = (t: number): View => {
      const seg = Math.min(p.keys.length - 2, Math.floor(t * (p.keys.length - 1)));
      const k0 = p.keys[seg];
      const k1 = p.keys[seg + 1];
      if (!k0 || !k1) throw new Error('bad path');
      const u = smooth(t * (p.keys.length - 1) - seg);
      return {
        position: lerp(k0.position, k1.position, u) as View['position'],
        target: lerp(k0.target, k1.target, u) as View['target'],
      };
    };
    const stamps: number[] = [];
    const points: number[] = [];
    await new Promise<void>((done) => {
      let t0 = -1;
      const step = (now: number) => {
        if (t0 < 0) t0 = now;
        const t = Math.min(1, (now - t0) / p.durationMs);
        stamps.push(now);
        points.push(stage.perfStats().points);
        stage.restoreView(at(t), false);
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    const dts = stamps
      .slice(1)
      .map((s, i) => s - (stamps[i] ?? s))
      .sort((a, b) => a - b);
    const pct = (q: number) =>
      dts[Math.min(dts.length - 1, Math.ceil((q / 100) * dts.length) - 1)] ?? 0;
    const mean = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
    const s = stage.perfStats();
    const g = w.__stratlas.graphics().getState();
    return {
      frames: dts.length,
      p50: pct(50),
      p95: pct(95),
      p99: pct(99),
      worst: dts.at(-1) ?? 0,
      fps: 1000 / mean,
      maxPoints: Math.max(...points),
      meanPoints: points.reduce((a, b) => a + b, 0) / Math.max(1, points.length),
      calls: s.calls,
      gpuBytes: s.gpuBytes,
      loadedPoints: 0,
      totalPoints: 0,
      renderer: g.renderer,
      tier: g.tier,
    };
  }, path);
}

interface CountsW {
  __stratlas: { stage(): { perfStats(): { points: number } } | null };
}

for (const id of ['alzour', 'hcl']) {
  test.describe(id, () => {
    test.skip(
      !existsSync(join(DATA, 'projects', id, 'manifest.json')),
      `${id} project not found under ${DATA}`,
    );
    // The workstation budget is for its hardware GPU; with every launch on SwiftShader
    // (STRATLAS_E2E_SWGL=1) the software GPU budget below is the one that applies.
    test.skip(
      process.env.STRATLAS_E2E_SWGL === '1',
      'workstation budget needs the hardware GPU (STRATLAS_E2E_SWGL=1 forces SwiftShader)',
    );
    test(`a recorded fly-through holds p95 frame time under ${String(BUDGET_MS)} ms`, async ({
      win,
    }, testInfo) => {
      const path = pathFor(id);
      await win.getByTestId('project-card').filter({ hasText: path.card }).first().click();
      const canvas = win.locator('[data-scene-view] canvas');
      await expect(canvas).toBeVisible();
      // the first key, then let the clouds stream in before measuring
      await win.evaluate((v) => {
        (
          window as unknown as {
            __stratlas: { stage(): { restoreView(v: unknown, a: boolean): void } | null };
          }
        ).__stratlas
          .stage()
          ?.restoreView(v, false);
      }, path.keys[0]);
      await canvas.click({ position: { x: 5, y: 300 } });
      await win.keyboard.press('Control+Shift+F');
      await expect(win.locator('[data-perf-hud]')).toBeVisible();
      await expect
        .poll(
          () =>
            win.evaluate(
              () => (window as unknown as CountsW).__stratlas.stage()?.perfStats().points ?? 0,
            ),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(100_000);
      await win.waitForTimeout(5000);

      const r = await fly(win, path);
      const line =
        `${id}: ${String(r.frames)} frames, ${r.fps.toFixed(1)} fps, p50 ${r.p50.toFixed(1)} ms, ` +
        `p95 ${r.p95.toFixed(1)} ms, p99 ${r.p99.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms, ` +
        `points max ${(r.maxPoints / 1e6).toFixed(2)} M mean ${(r.meanPoints / 1e6).toFixed(2)} M, ` +
        `draws ${String(r.calls)}, GPU ~${(r.gpuBytes / 2 ** 30).toFixed(2)} GB, ${r.tier} (${r.renderer ?? 'unknown GPU'})`;
      process.stdout.write(`${line}\n`);
      await testInfo.attach(`${id}-perf.json`, { body: JSON.stringify(r, null, 2) });
      if (SHOTS) {
        writeFileSync(join(SHOTS, `perf-${id}.json`), JSON.stringify(r, null, 2));
        await win.screenshot({ path: join(SHOTS, `perf-${id}.png`) });
      }
      expect(r.frames).toBeGreaterThan((path.durationMs / 1000) * 20);
      expect(r.p95, line).toBeLessThan(BUDGET_MS);
    });
  });
}

/* ------------------------------------------------------------------ synthetic, software GPU */

const STARTUP_MS = Number(process.env.STRATLAS_STARTUP_MS ?? 15_000);
const FIRST_FRAME_MS = Number(process.env.STRATLAS_FIRST_FRAME_MS ?? 8000);
const LOW_P95_MS = Number(process.env.STRATLAS_PERF_LOW_P95_MS ?? 250);
const COPC = join(import.meta.dirname, '../../../packages/pointcloud/test-data/synthetic.copc.laz');
/** Over the Low tier's 4096 px texture limit, so the ortho is scaled down on load. */
const ORTHO = [4800, 2400] as const;

/** The tiny project plus the COPC fixture and a large plain ortho image. */
async function syntheticRoot(): Promise<DataRoot> {
  const root = await createDataRoot();
  const dir = root.projectDir;
  await mkdir(join(dir, 'clouds'), { recursive: true });
  await mkdir(join(dir, 'rasters'), { recursive: true });
  await copyFile(COPC, join(dir, 'clouds', 'synthetic.copc.laz'));
  await sharp({
    create: { width: ORTHO[0], height: ORTHO[1], channels: 3, background: '#6b7a5a' },
  })
    .jpeg({ quality: 70 })
    .toFile(join(dir, 'rasters', 'ortho.jpg'));
  const base = tinyManifest();
  const manifest: ProjectManifestInput = {
    ...base,
    layers: [
      ...base.layers,
      {
        kind: 'pointcloud',
        id: 'synthetic',
        name: 'Synthetic COPC cloud',
        src: { path: 'clouds/synthetic.copc.laz' },
        format: 'copc',
        pointCount: 16000,
      },
      {
        kind: 'raster',
        id: 'ortho',
        name: 'Synthetic ortho',
        src: { path: 'rasters/ortho.jpg' },
        role: 'ortho',
        format: 'image',
        corners: { tl: [-20, 0.05, -60], tr: [60, 0.05, -60], bl: [-20, 0.05, -20] },
      },
    ],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest), null, 2),
  );
  return root;
}

interface SynthW {
  __stratlas: {
    stage(): {
      perfStats(): { points: number; calls: number; gpuBytes: number };
      restoreView(v: View, animate?: boolean): void;
      renderer: { getContext(): WebGL2RenderingContext };
      scene: { traverse(cb: (o: unknown) => void): void };
    } | null;
    memory(): Promise<{
      tier: string;
      renderer: string | null;
      pressure: number;
      pointCap: number;
      gpuCap: number;
      gpuBytes: number | null;
      heapUsed: number | null;
    }>;
  };
}

/** Launch on the software GPU against `root`; the caller closes it. */
async function launchSoftware(root: DataRoot) {
  const network = new NetworkGuard();
  const app = await launchApp(root, {}, SOFTWARE_GPU);
  await network.attach(app);
  return { app, network };
}

base.describe('synthetic project on the software GPU (Low tier)', () => {
  base.describe.configure({ mode: 'serial' });
  base.setTimeout(180_000);

  base(
    `startup: Projects within ${String(STARTUP_MS)} ms, first stage frame within ${String(FIRST_FRAME_MS)} ms`,
    async () => {
      const testInfo = base.info();
      const root = await syntheticRoot();
      const t0 = Date.now();
      const { app, network } = await launchSoftware(root);
      try {
        const win = await app.firstWindow();
        const card = win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' });
        await expect(card.first()).toBeEnabled({ timeout: 60_000 });
        const projects = Date.now() - t0;
        const t1 = Date.now();
        await card.first().click();
        await expect
          .poll(
            () =>
              win.evaluate(
                () =>
                  ((window as unknown as SynthW).__stratlas.stage()?.perfStats().calls ?? 0) > 0,
              ),
            { timeout: 60_000, intervals: [50] },
          )
          .toBe(true);
        const firstFrame = Date.now() - t1;
        await expect
          .poll(
            () =>
              win.evaluate(
                () => (window as unknown as SynthW).__stratlas.stage()?.perfStats().points ?? 0,
              ),
            { timeout: 60_000, intervals: [50] },
          )
          .toBeGreaterThan(0);
        const firstPoints = Date.now() - t1;
        const numbers = { projects, firstFrame, firstPoints, STARTUP_MS, FIRST_FRAME_MS };
        process.stdout.write(
          `startup: Projects ${String(projects)} ms, first frame ${String(firstFrame)} ms, ` +
            `first points ${String(firstPoints)} ms\n`,
        );
        await testInfo.attach('startup.json', { body: JSON.stringify(numbers, null, 2) });
        expect(projects, 'launch to an interactive Projects screen').toBeLessThan(STARTUP_MS);
        expect(firstFrame, 'project click to the first stage frame').toBeLessThan(FIRST_FRAME_MS);
        expect(await network.outbound(), 'the app made network requests').toEqual([]);
      } finally {
        await app.close();
        await rm(root.base, { recursive: true, force: true });
      }
    },
  );

  base(
    `the recorded path holds p95 under ${String(LOW_P95_MS)} ms within the Low tier limits, and a lost context recovers`,
    async () => {
      const testInfo = base.info();
      const root = await syntheticRoot();
      const { app, network } = await launchSoftware(root);
      try {
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
        });
        const path = pathFor('synthetic');
        const [k0, k1] = path.keys;
        if (!k0 || !k1) throw new Error('synthetic path needs two keys');
        await win.getByTestId('project-card').filter({ hasText: path.card }).first().click();
        const canvas = win.locator('[data-scene-view] canvas');
        await expect(canvas).toBeVisible();
        await win.evaluate((v) => {
          (window as unknown as SynthW).__stratlas.stage()?.restoreView(v, false);
        }, k0);
        await canvas.click({ position: { x: 5, y: 300 } });
        await win.keyboard.press('Control+Shift+F');
        await expect(win.locator('[data-perf-hud]')).toBeVisible();
        const points = () =>
          win.evaluate(
            () => (window as unknown as SynthW).__stratlas.stage()?.perfStats().points ?? 0,
          );
        await expect.poll(points, { timeout: 60_000 }).toBe(16000);
        // the ortho texture, scaled to the Low tier's limit on load
        const orthoWidth = () =>
          win.evaluate(() => {
            let w = 0;
            (window as unknown as SynthW).__stratlas.stage()?.scene.traverse((o) => {
              const m = o as {
                userData: { aioLayer?: string };
                material?: { map?: { image?: { width?: number } } };
              };
              if (m.userData.aioLayer === 'ortho') w = m.material?.map?.image?.width ?? w;
            });
            return w;
          });
        await expect.poll(orthoWidth, { timeout: 30_000 }).toBeGreaterThan(0);
        await win.waitForTimeout(1500);

        const r = await fly(win, path);
        const mem = await win.evaluate(() => (window as unknown as SynthW).__stratlas.memory());
        const line =
          `synthetic (software GPU): ${String(r.frames)} frames, ${r.fps.toFixed(1)} fps, ` +
          `p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, p99 ${r.p99.toFixed(1)} ms, ` +
          `GPU ~${((mem.gpuBytes ?? 0) / 2 ** 20).toFixed(0)} MB of ${(mem.gpuCap / 2 ** 20).toFixed(0)} MB, ` +
          `${r.tier} (${r.renderer ?? 'unknown GPU'})`;
        process.stdout.write(`${line}\n`);
        await testInfo.attach('synthetic-perf.json', {
          body: JSON.stringify({ ...r, memory: mem, budgetMs: LOW_P95_MS }, null, 2),
        });
        expect(r.tier, 'SwiftShader runs on the Low tier').toBe('low');
        expect(await orthoWidth()).toBe(4096);
        expect(mem.gpuBytes ?? 0).toBeLessThan(mem.gpuCap);
        expect(mem.pressure).toBe(0);
        expect(r.frames).toBeGreaterThan(8);
        expect(r.p95, line).toBeLessThan(LOW_P95_MS);

        // memory pressure: the context goes, the tier steps down with a calm notice, and the
        // restored context draws every point again from the CPU copies
        await win.evaluate(() => {
          const gl = (window as unknown as SynthW).__stratlas.stage()?.renderer.getContext();
          (window as unknown as { __lose?: WEBGL_lose_context | null }).__lose =
            gl?.getExtension('WEBGL_lose_context') ?? null;
          (window as unknown as { __lose?: WEBGL_lose_context | null }).__lose?.loseContext();
        });
        const notice = win.getByTestId('graphics-notice');
        await expect(notice).toBeVisible();
        await expect(notice).toContainText('graphics card reset');
        const after = await win.evaluate(() => (window as unknown as SynthW).__stratlas.memory());
        expect(after.pressure).toBe(1);
        expect(after.pointCap).toBe(1_000_000);
        await win.evaluate(() => {
          (window as unknown as { __lose?: WEBGL_lose_context | null }).__lose?.restoreContext();
        });
        await win.evaluate((v) => {
          (window as unknown as SynthW).__stratlas.stage()?.restoreView(v, false);
        }, k1);
        await expect.poll(points, { timeout: 30_000 }).toBe(16000);
        await notice.getByRole('button', { name: 'Dismiss' }).click();
        await expect(notice).toBeHidden();
        if (SHOTS) await win.screenshot({ path: join(SHOTS, 'perf-synthetic.png') });
        expect(await network.outbound(), 'the app made network requests').toEqual([]);
      } finally {
        await app.close();
        await rm(root.base, { recursive: true, force: true });
      }
    },
  );
});
