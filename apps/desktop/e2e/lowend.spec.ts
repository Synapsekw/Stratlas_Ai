/**
 * A low-end machine, simulated: every real project opened on the software GPU (SwiftShader, which
 * the app detects as integrated graphics and runs on the Low tier), optionally with a smaller
 * reported memory (STRATLAS_SYSTEM_MEMORY_GB, default 8) and a JavaScript heap cap
 * (STRATLAS_LOWEND_HEAP_MB). Each project opens, streams for a while and orbits; the renderer must
 * not crash, the tier must be Low, and graphics memory must stay within the tier's limit (or the
 * memory pressure path must have stepped down). Prints and attaches the numbers. Outside CI only
 * (needs the real projects; skipped where absent). Read-only.
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, SOFTWARE_GPU } from './fixtures';

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const SHOTS = process.env.STRATLAS_SHOTS;
const MEMORY_GB = process.env.STRATLAS_SYSTEM_MEMORY_GB ?? '8';
const HEAP_MB = process.env.STRATLAS_LOWEND_HEAP_MB;

interface Report {
  renderer: string | null;
  tier: string;
  detected: string;
  limits: string[];
  pressure: number;
  pointCap: number;
  gpuCap: number;
  gpuBytes: number | null;
  heapUsed: number | null;
  heapLimit: number | null;
  processPrivate: number | null;
  contextLost: boolean;
  systemMemory: number | null;
  maxTextureSize: number | null;
}
interface Stats {
  points: number;
  calls: number;
  gpuBytes: number;
}
interface W {
  __stratlas: {
    stage(): {
      saveView(): { position: number[]; target: number[] };
      restoreView(v: { position: number[]; target: number[] }, animate?: boolean): void;
      perfStats(): Stats;
    } | null;
    memory(): Promise<Report>;
  };
}

const test = base.extend<{ app: ElectronApplication; win: Page; crashed: { value: boolean } }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  crashed: async ({}, use) => {
    await use({ value: false });
  },
  app: async ({ crashed }, use) => {
    const tmp = await mkdtemp(join(tmpdir(), 'aio-lowend-'));
    const network = new NetworkGuard();
    const args = [...SOFTWARE_GPU];
    if (HEAP_MB) args.push(`--js-flags=--max-old-space-size=${HEAP_MB}`);
    const app = await launchApp(
      { base: tmp, root: DATA, userData: join(tmp, 'user'), projectId: '', projectDir: '' },
      { STRATLAS_SYSTEM_MEMORY_GB: MEMORY_GB },
      args,
    );
    await network.attach(app);
    app.on('window', (p) => {
      p.on('crash', () => {
        crashed.value = true;
      });
    });
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
      await rm(tmp, { recursive: true, force: true });
    }
  },
  win: async ({ app, crashed }, use) => {
    const win = await app.firstWindow();
    win.on('crash', () => {
      crashed.value = true;
    });
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await use(win);
  },
});

test.skip(!!process.env.CI, 'real projects are not on CI');
test.setTimeout(300_000);

/** Orbit once around the view's target while closing in to 40 %, one view per frame. */
function orbit(win: Page, ms: number) {
  return win.evaluate(async (dur) => {
    const stage = (window as unknown as W).__stratlas.stage();
    if (!stage) throw new Error('no stage');
    const v0 = stage.saveView();
    const [tx, ty, tz] = v0.target as [number, number, number];
    const [px, py, pz] = v0.position as [number, number, number];
    const r0 = Math.hypot(px - tx, pz - tz);
    const a0 = Math.atan2(pz - tz, px - tx);
    const stamps: number[] = [];
    let maxPoints = 0;
    await new Promise<void>((done) => {
      let t0 = -1;
      const step = (now: number) => {
        if (t0 < 0) t0 = now;
        const t = Math.min(1, (now - t0) / dur);
        stamps.push(now);
        maxPoints = Math.max(maxPoints, stage.perfStats().points);
        const k = 1 - 0.6 * Math.sin(Math.PI * t);
        const a = a0 + t * Math.PI * 2;
        stage.restoreView(
          {
            position: [tx + Math.cos(a) * r0 * k, ty + (py - ty) * k, tz + Math.sin(a) * r0 * k],
            target: [tx, ty, tz],
          },
          false,
        );
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    stage.restoreView(v0, false);
    const dts = stamps
      .slice(1)
      .map((s, i) => s - (stamps[i] ?? s))
      .sort((a, b) => a - b);
    const pct = (q: number) =>
      dts[Math.min(dts.length - 1, Math.ceil((q / 100) * dts.length) - 1)] ?? 0;
    return { frames: dts.length, p50: pct(50), p95: pct(95), worst: dts.at(-1) ?? 0, maxPoints };
  }, ms);
}

const projectIds = ['alzour', 'hcl', 'ebsm', 'damac', 'masafi', 'ringroad'];

for (const id of projectIds) {
  const manifest = join(DATA, 'projects', id, 'manifest.json');
  const name = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name
    : id;
  test(`${id} opens on the Low tier of a software GPU without crashing or overrunning memory`, async ({
    win,
    crashed,
  }, testInfo) => {
    test.skip(!existsSync(manifest), `${id} project not found under ${DATA}`);
    const t0 = Date.now();
    await win.getByTestId('project-card').filter({ hasText: name }).first().click();
    const canvas = win.locator('[data-scene-view] canvas').first();
    await expect(canvas).toBeAttached({ timeout: 60_000 });
    await win.waitForTimeout(3000);
    // the road workspace opens on the map: 1 shows the 3D view
    if (!(await canvas.isVisible())) await win.keyboard.press('1');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => win.evaluate(() => (window as unknown as W).__stratlas.stage() !== null))
      .toBe(true);
    const opened = Date.now() - t0;
    await canvas.click({ position: { x: 5, y: 300 } });
    await win.keyboard.press('Control+Shift+F');
    // stream: models, clouds and ortho tiles load around the home view
    await win.waitForTimeout(20_000);
    const fly = await orbit(win, 12_000);
    await win.waitForTimeout(4000);
    const r = await win.evaluate(() => (window as unknown as W).__stratlas.memory());
    const stats = await win.evaluate(
      () => (window as unknown as W).__stratlas.stage()?.perfStats() ?? null,
    );
    const gb = (n: number | null) => (n === null ? 'n/a' : `${(n / 2 ** 30).toFixed(2)} GB`);
    const line =
      `${id}: open ${String(opened)} ms, ${String(fly.frames)} frames p50 ${fly.p50.toFixed(0)} ms ` +
      `p95 ${fly.p95.toFixed(0)} ms worst ${fly.worst.toFixed(0)} ms, points max ` +
      `${(fly.maxPoints / 1e6).toFixed(2)} M (cap ${(r.pointCap / 1e6).toFixed(1)} M), GPU ~${gb(r.gpuBytes)} ` +
      `of ${gb(r.gpuCap)}, heap ${gb(r.heapUsed)} of ${gb(r.heapLimit)}, renderer private ` +
      `${gb(r.processPrivate)}, tier ${r.tier} (detected ${r.detected}, pressure ${String(r.pressure)}), ` +
      `${r.renderer ?? 'unknown GPU'}, ${String(r.maxTextureSize)} px, ${gb(r.systemMemory)} RAM`;
    process.stdout.write(`${line}\n`);
    const body = { id, opened, fly, report: r, stats };
    await testInfo.attach(`${id}-lowend.json`, { body: JSON.stringify(body, null, 2) });
    if (SHOTS) {
      writeFileSync(join(SHOTS, `lowend-${id}.json`), JSON.stringify(body, null, 2));
      await win.screenshot({ path: join(SHOTS, `lowend-${id}.png`) });
    }
    expect(crashed.value, 'the renderer crashed').toBe(false);
    expect(r.contextLost).toBe(false);
    expect(r.tier).toBe('low');
    expect(fly.maxPoints).toBeLessThanOrEqual(r.pointCap * 1.1);
    // within the tier's graphics memory, or the pressure path stepped down to get there
    if (r.gpuBytes !== null && r.gpuBytes > r.gpuCap) expect(r.pressure).toBeGreaterThan(0);

    // the GPU resets mid-session: the app steps down, says so, and draws the project again
    interface Lose {
      __lose?: WEBGL_lose_context | null;
      __stratlas: { stage(): { renderer: { getContext(): WebGL2RenderingContext } } | null };
    }
    await win.evaluate(() => {
      const w = window as unknown as Lose;
      w.__lose =
        w.__stratlas.stage()?.renderer.getContext().getExtension('WEBGL_lose_context') ?? null;
      w.__lose?.loseContext();
    });
    await expect(win.getByTestId('graphics-notice')).toBeVisible();
    await win.evaluate(() => {
      (window as unknown as Lose).__lose?.restoreContext();
    });
    await win.waitForTimeout(8000);
    const back = await win.evaluate(() => (window as unknown as W).__stratlas.memory());
    const drawn = await win.evaluate(
      () => (window as unknown as W).__stratlas.stage()?.perfStats() ?? null,
    );
    process.stdout.write(
      `${id} after a context reset: points ${String(drawn?.points)}, draws ${String(drawn?.calls)}, ` +
        `point cap ${(back.pointCap / 1e6).toFixed(1)} M, pressure ${String(back.pressure)}\n`,
    );
    expect(crashed.value, 'the renderer crashed after the context reset').toBe(false);
    expect(back.contextLost).toBe(false);
    expect(back.pressure).toBe(r.pressure + 1);
    expect(drawn?.calls ?? 0).toBeGreaterThan(0);
    if (fly.maxPoints > 0) expect(drawn?.points ?? 0).toBeGreaterThan(0);
  });
}
