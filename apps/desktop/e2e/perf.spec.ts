/**
 * Performance on the real projects (PRD NFR: 60 fps in the Al-Zour and HCl workspaces on the
 * reference workstation). Flies a recorded camera path (e2e/perf/<project>.path.json) with the
 * perf HUD on and asserts the 95th percentile frame time stays under the budget for this machine:
 * STRATLAS_PERF_P95_MS, default 20 ms (no more than 5 % of frames miss a 60 Hz refresh by more
 * than a few ms). Skipped where the projects are absent. Read-only. Run with --workers=1: the
 * numbers mean nothing with other GPU work running.
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard } from './fixtures';

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
