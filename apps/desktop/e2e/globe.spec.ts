import type { ElectronApplication, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

/** The app's CSP as main sets it (src/main/index.ts `CSP`), read from the source. */
function appCsp(): string {
  const src = readFileSync(join(import.meta.dirname, '../src/main/index.ts'), 'utf8');
  const block = /const CSP = \[([\s\S]*?)\]\.join/.exec(src)?.[1] ?? '';
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join('; ');
}

/** The Globe's CesiumWidget, through the inspection hook on its element. */
async function globeState(win: Page) {
  return win.evaluate(() => {
    const el = document.querySelector('[data-testid="globe-canvas"]');
    const w = (el as { __aioGlobe?: Record<string, never> } | null)?.__aioGlobe as
      | {
          scene: {
            globe: { tilesLoaded: boolean };
            imageryLayers: { length: number };
            frameState: { frameNumber: number };
          };
        }
      | undefined;
    if (!w) return null;
    return {
      tilesLoaded: w.scene.globe.tilesLoaded,
      layers: w.scene.imageryLayers.length,
      frame: w.scene.frameState.frameNumber,
    };
  });
}

const memMiB = (app: ElectronApplication) =>
  app.evaluate(({ app: a }) =>
    Math.round(a.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024),
  );

test('spike: the Globe renders offline under the app CSP', async ({ app, win, network }) => {
  const problems: string[] = [];
  win.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(text))
      problems.push(text);
  });
  win.on('pageerror', (e) => problems.push(String(e)));
  await expect(win.getByRole('button', { name: 'Globe' })).toBeVisible();
  await win.waitForTimeout(3000);
  const probe = await win.evaluate((policy) => {
    const before = (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- probes the CSP
        (new Function('return 1') as () => number)();
        return 'eval allowed';
      } catch {
        return 'eval refused';
      }
    })();
    // Enforce the app CSP on this page as a meta policy (the window loads from file://, where
    // main's response-header CSP does not reach), so the Globe runs under it.
    const meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = policy;
    document.head.prepend(meta);
    const w = window as unknown as { __workers: string[]; Worker: typeof Worker };
    w.__workers = [];
    const W = w.Worker;
    w.Worker = class extends W {
      constructor(u: string | URL, o?: WorkerOptions) {
        super(u, o);
        w.__workers.push(String(u));
      }
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- probes the CSP
      (new Function('return 1') as () => number)();
      return `${before}; with the meta CSP: eval allowed`;
    } catch {
      return `${before}; with the meta CSP: eval refused`;
    }
  }, appCsp());
  // the probe's own eval refusal is the one CSP report expected
  problems.length = 0;
  const mem0 = await memMiB(app);
  const t0 = Date.now();
  await win.getByRole('button', { name: 'Globe' }).click();
  await expect(win.getByTestId('globe-canvas').locator('canvas')).toBeVisible();
  await expect
    .poll(async () => (await globeState(win))?.tilesLoaded, { timeout: 30_000 })
    .toBe(true);
  const ready = Date.now() - t0;
  const mem1 = await memMiB(app);
  const workers = await win.evaluate(() =>
    (window as unknown as { __workers: string[] }).__workers.map((u) => u.replace(/^.*\//, '')),
  );
  const state = await globeState(win);
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).click();
  await win.waitForTimeout(3000);
  const mem2 = await memMiB(app);
  // eslint-disable-next-line no-console -- spike measurement
  console.log(
    `globe spike: ${probe}; ready in ${String(ready)} ms; working set ${String(mem0)} MiB, Globe open ${String(mem1)} MiB, closed ${String(mem2)} MiB; workers ${workers.join(', ')}`,
    state,
  );
  expect(probe).toContain('with the meta CSP: eval refused');
  expect(workers.length).toBeGreaterThan(0);
  expect(problems).toEqual([]);
  expect(await network.outbound()).toEqual([]);
});
