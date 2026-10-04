/**
 * Profiling companion of perf.spec.ts (local investigation only): flies the same recorded path
 * with a Chrome performance trace (CDP), per-frame WebGL upload counters and long animation frame
 * attribution, and writes them to STRATLAS_TRACE_DIR. Skipped unless that variable is set.
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp } from './fixtures';

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const OUT = process.env.STRATLAS_TRACE_DIR ?? '';
const ID = process.env.STRATLAS_TRACE_PROJECT ?? 'alzour';
const CPU = process.env.STRATLAS_TRACE_CPU !== '0';

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

const test = base.extend<{ app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  app: async ({}, use) => {
    const tmp = await mkdtemp(join(tmpdir(), 'aio-perf-'));
    const app = await launchApp({
      base: tmp,
      root: DATA,
      userData: join(tmp, 'user'),
      projectId: '',
      projectDir: '',
    });
    try {
      await use(app);
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

test.setTimeout(300_000);
test.skip(!OUT, 'STRATLAS_TRACE_DIR not set');
test.skip(!existsSync(join(DATA, 'projects', ID, 'manifest.json')), `${ID} not found`);

test(`trace the ${ID} fly-through`, async ({ win }) => {
  const path = JSON.parse(
    readFileSync(join(import.meta.dirname, 'perf', `${ID}.path.json`), 'utf8'),
  ) as CameraPath;
  await win.getByTestId('project-card').filter({ hasText: path.card }).first().click();
  const canvas = win.locator('[data-scene-view] canvas');
  await expect(canvas).toBeVisible();
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
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            (
              window as unknown as {
                __stratlas: { stage(): { perfStats(): { points: number } } | null };
              }
            ).__stratlas
              .stage()
              ?.perfStats().points ?? 0,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(100_000);
  await win.waitForTimeout(5000);

  // per-frame WebGL counters
  await win.evaluate(() => {
    const g = window as unknown as Record<string, unknown>;
    const c = { bytes: 0, uploads: 0, uploadMs: 0, deletes: 0, creates: 0, uniforms: 0 };
    g.__glc = c;
    const P = WebGL2RenderingContext.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const wrap = (name: string, f: (args: unknown[], ms: number) => void) => {
      const orig = P[name];
      if (!orig) return;
      P[name] = function (this: unknown, ...args: unknown[]) {
        const t = performance.now();
        const r = orig.apply(this, args);
        f(args, performance.now() - t);
        return r;
      };
    };
    const size = (a: unknown) =>
      typeof a === 'object' && a && 'byteLength' in a ? (a as ArrayBufferView).byteLength : 0;
    wrap('bufferData', (a, ms) => {
      c.bytes += size(a[1]);
      c.uploads++;
      c.uploadMs += ms;
    });
    wrap('bufferSubData', (a, ms) => {
      c.bytes += size(a[2]);
      c.uploads++;
      c.uploadMs += ms;
    });
    wrap('deleteBuffer', () => {
      c.deletes++;
    });
    wrap('createBuffer', () => {
      c.creates++;
    });
    wrap('uniform3fv', () => {
      c.uniforms++;
    });
    const loaf: unknown[] = [];
    g.__loaf = loaf;
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) loaf.push(e.toJSON());
      }).observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      /* not supported */
    }
  });

  const cdp = await win.context().newCDPSession(win);
  const events: unknown[] = [];
  cdp.on('Tracing.dataCollected', (e: { value: unknown[] }) => {
    events.push(...e.value);
  });
  const categories = [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'v8',
    'v8.execute',
    'disabled-by-default-v8.gc',
    'blink.user_timing',
    'gpu',
    'toplevel',
    'loading',
  ];
  if (CPU) categories.push('disabled-by-default-v8.cpu_profiler');
  await cdp.send('Tracing.start', {
    traceConfig: { includedCategories: categories, recordMode: 'recordContinuously' },
    transferMode: 'ReportEvents',
  });

  const frames = await win.evaluate(async (p) => {
    interface Stage {
      restoreView(v: View, animate?: boolean): void;
      perfStats(): { points: number; calls: number };
    }
    const w = window as unknown as {
      __stratlas: { stage(): Stage | null };
      __glc: Record<string, number>;
    };
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
    const rows: Record<string, number>[] = [];
    await new Promise<void>((done) => {
      let t0 = -1;
      const step = (now: number) => {
        if (t0 < 0) t0 = now;
        const t = Math.min(1, (now - t0) / p.durationMs);
        const s = stage.perfStats();
        rows.push({ now, points: s.points, calls: s.calls, ...w.__glc });
        for (const k of Object.keys(w.__glc)) w.__glc[k] = 0;
        performance.mark(`fly:${rows.length}`);
        stage.restoreView(at(t), false);
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    return rows;
  }, path);

  const done = new Promise<void>((r) =>
    cdp.once('Tracing.tracingComplete', () => {
      r();
    }),
  );
  await cdp.send('Tracing.end');
  await done;
  const loaf = await win.evaluate(() => (window as unknown as { __loaf: unknown[] }).__loaf);
  writeFileSync(join(OUT, `${ID}-trace.json`), JSON.stringify({ traceEvents: events }));
  writeFileSync(join(OUT, `${ID}-frames.json`), JSON.stringify(frames));
  writeFileSync(join(OUT, `${ID}-loaf.json`), JSON.stringify(loaf));
  const dts = frames.slice(1).map((f, i) => (f.now ?? 0) - (frames[i]?.now ?? 0));
  const sorted = [...dts].sort((a, b) => a - b);
  process.stdout.write(
    `${ID}: ${String(dts.length)} frames p50 ${String(sorted[Math.floor(sorted.length * 0.5)])} p95 ${String(sorted[Math.floor(sorted.length * 0.95)])} worst ${String(sorted.at(-1))}\n`,
  );
});
