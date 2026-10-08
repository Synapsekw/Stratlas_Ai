/**
 * Soak (1.0 checklist, stability): a long scripted session that opens the three demo projects in
 * turn, again and again, and checks that memory and open handles stay flat. After a warm-up, the
 * median of the last cycles may exceed the median of the first measured cycles by at most 10 %
 * (plus a small absolute allowance for noise) for: the main process heap, the renderer heap,
 * and the main process's active handles and requests; and by 20 % for the working set of all app
 * processes (see the checks below).
 * The renderer allowance is small on purpose: T8 found 6 MB of renderer heap kept per project
 * switch (34 MB to 516 MB over 80 cycles: each closed 3D view and its renderer stayed alive, and
 * with them the closed workspace's DOM and maps), which this must catch; fixed, it stays near
 * 40 MB.
 *
 * Nightly, not per merge: runs with QUADRION_SOAK=1. QUADRION_SOAK_CYCLES sets the number of
 * open cycles (default 80, the T8 repro; the 1.0 checklist run sets 200). Needs the demo
 * (`pnpm demo:build --quick`).
 * A JSON report of every sample goes to the test output folder (soak.json).
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DEMO = process.env.QUADRION_E2E_DEMO ?? join(import.meta.dirname, '..', 'demo');
const CYCLES = Number(process.env.QUADRION_SOAK_CYCLES ?? 80);
const PROJECTS = ['Demo tank farm', 'Demo access road', 'Demo change site (2 dates)'];
/** Cycles before the baseline: caches, shaders and the demo working copies fill up first. */
const WARMUP = Math.max(5, Math.round(CYCLES * 0.25));
const WINDOW = Math.max(3, Math.round(CYCLES * 0.1));
const GROWTH = 0.1;
const MB = 1024 * 1024;

interface Sample {
  cycle: number;
  mainHeap: number;
  rendererHeap: number;
  workingSet: number;
  handles: number;
  /** Working set by process type (Browser, GPU, Tab, Utility), for finding a growth. */
  byType: Record<string, number>;
}

const test = base.extend<{ app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  app: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-soak-'));
    const network = new NetworkGuard();
    const app = await launchApp(
      {
        base: dir,
        root: join(dir, 'data'),
        userData: join(dir, 'user'),
        projectId: '',
        projectDir: '',
      },
      { QUADRION_DEMO: DEMO },
      ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
    );
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

test.skip(process.env.QUADRION_SOAK !== '1', 'nightly soak: set QUADRION_SOAK=1');
test.skip(!existsSync(join(DEMO, 'demo.json')), `no demo in ${DEMO}: pnpm demo:build --quick`);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

async function measure(app: ElectronApplication, win: Page, cycle: number): Promise<Sample> {
  const rendererHeap = await win.evaluate(() => {
    const w = window as unknown as {
      gc?: () => void;
      performance: { memory?: { usedJSHeapSize: number } };
    };
    w.gc?.();
    return w.performance.memory?.usedJSHeapSize ?? 0;
  });
  const main = await app.evaluate(({ app: electronApp }) => {
    (globalThis as { gc?: () => void }).gc?.();
    const byType: Record<string, number> = {};
    let workingSet = 0;
    for (const m of electronApp.getAppMetrics()) {
      const bytes = m.memory.workingSetSize * 1024;
      workingSet += bytes;
      byType[m.type] = (byType[m.type] ?? 0) + bytes;
    }
    return {
      mainHeap: process.memoryUsage().heapUsed,
      workingSet,
      byType,
      handles: process.getActiveResourcesInfo().length,
    };
  });
  return { cycle, rendererHeap, ...main };
}

test(`${String(CYCLES)} open cycles across the demos keep memory and handles flat`, async ({
  app,
  win,
}, testInfo) => {
  test.setTimeout(Math.max(120_000, CYCLES * 3 * 15_000));
  const samples: Sample[] = [];
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    for (const name of PROJECTS) {
      await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
      await win.getByTestId('project-card').filter({ hasText: name }).first().click();
      await expect
        .poll(
          () =>
            win.evaluate(
              () =>
                (
                  window as unknown as {
                    __stratlas: {
                      workspace: { getState(): { project: { manifest: { name: string } } | null } };
                    };
                  }
                ).__stratlas.workspace.getState().project?.manifest.name ?? null,
            ),
          { timeout: 60_000 },
        )
        .toBe(name);
      // The stage shows the 3D view or the map, whichever the project was left on.
      await expect(win.getByRole('heading', { name: 'Scene', level: 1 })).toBeVisible({
        timeout: 60_000,
      });
    }
    samples.push(await measure(app, win, cycle));
  }
  const report = testInfo.outputPath('soak.json');
  await writeFile(report, JSON.stringify({ cycles: CYCLES, samples }, null, 1));
  await testInfo.attach('soak.json', { path: report, contentType: 'application/json' });

  const first = samples.slice(WARMUP, WARMUP + WINDOW);
  const last = samples.slice(-WINDOW);
  // The working set gets twice the growth: it includes Chromium's native memory, which keeps
  // filling for about 80 opens and then grows under 1 MB per open while every JS and Blink object
  // count stays flat (each open makes a new WebGL context and compiles its shaders again), and the
  // GPU process, whose caches rise and drop by 70 MB. The heaps and handles keep 10 %.
  const checks: [keyof Omit<Sample, 'cycle' | 'byType'>, number, number][] = [
    ['mainHeap', 8 * MB, GROWTH],
    ['rendererHeap', 4 * MB, GROWTH],
    ['workingSet', 64 * MB, 2 * GROWTH],
    ['handles', 5, GROWTH],
  ];
  for (const [key, slack, growth] of checks) {
    const before = median(first.map((s) => s[key]));
    const after = median(last.map((s) => s[key]));
    expect(after, `${key}: ${String(before)} then ${String(after)}`).toBeLessThanOrEqual(
      before * (1 + growth) + slack,
    );
  }
});
