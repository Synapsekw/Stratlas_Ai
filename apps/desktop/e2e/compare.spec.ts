/**
 * Comparing two survey dates in the split: two 3D views (one stage each, one capture each), two
 * maps or two orthos, with linked views and selection. A synthetic two-date project always runs;
 * Masafi (two real surveys) and Al-Zour (one survey plus a synthetic second date) run where the
 * projects are present, copied to a temporary data root through realData.ts (@realdata; nothing
 * is written under the real data).
 * Screenshots go to QUADRION_SHOTS when set. Run with --workers=1: the fps numbers mean nothing
 * with other GPU work running.
 */
import { test as base, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  launchApp,
  NetworkGuard,
  test as fixtures,
  tinyGlb,
  tinyManifest,
} from './fixtures';
import { copyRealData, hasRealData, missingRealProject, realProjectDir } from './realData';

const ALZOUR = realProjectDir('alzour');
const SHOTS = process.env.QUADRION_SHOTS;

type V3 = [number, number, number];
interface View {
  position: V3;
  target: V3;
}
interface Obj {
  name: string;
  visible: boolean;
  parent: Obj | null;
  getObjectByName(n: string): Obj | undefined;
}
interface PerfStats {
  fps: number;
  p50: number;
  p95: number;
  points: number;
  calls: number;
  triangles: number;
  gpuBytes: number;
}
interface StageLike {
  scene: Obj;
  saveView(): View;
  restoreView(v: View, animate?: boolean): void;
  setPerfOverlay(on: boolean): void;
  perfStats(): PerfStats;
  renderer: {
    domElement: HTMLCanvasElement;
    info: { memory: { geometries: number; textures: number } };
  };
  highlight?: { selected: Obj | null };
}
interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        selection: { kind: string; id: string; layer?: string } | null;
        select(s: { kind: string; id: string; layer?: string } | null): void;
      };
    };
    stage(): StageLike | null;
    volumetric: { getState(): { status: string; selected: string | null; epoch: string } };
    graphics(): {
      getState(): { renderer: string | null; tier: string; setOverride(t: string | null): void };
    };
    compare(): {
      second: StageLike | null;
      link: { linked: boolean } | null;
      maps: [{ map: MapLike } | null, { map: MapLike } | null];
      models: { held: Record<string, number>; loads: number; hits: number };
      gpuLimit: number;
    };
  };
}
interface MapLike {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  jumpTo(v: { center: [number, number]; zoom: number }): void;
}

/** Run a probe in the renderer with the inspection hook typed (sent as a function, no eval). */
async function inspect<T, A>(
  win: Page,
  probe: (x: { w: Inspect; a: A }) => T | Promise<T>,
  arg: A,
): Promise<T> {
  const w = await win.evaluateHandle(() => window);
  try {
    const fn = probe as unknown as (x: { w: Window; a: unknown }) => T | Promise<T>;
    return await win.evaluate(fn, { w, a: arg });
  } finally {
    await w.dispose();
  }
}

/**
 * CI runners draw with a software GPU, detected as the Low tier, where Compare dates offers two
 * maps (or the swipe) instead of two 3D views by design. Tests of the two 3D views pin Medium.
 */
async function pinTwoViewTier(win: Page): Promise<void> {
  await inspect(
    win,
    ({ w }) => {
      const g = w.__stratlas.graphics().getState();
      if (g.tier === 'low') g.setOverride('medium');
    },
    null,
  );
}

async function shot(win: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  // no tooltip from the last button pressed
  await win.mouse.move(1, 1);
  await win.waitForTimeout(300);
  await win.screenshot({ path: join(SHOTS, `compare-${name}.png`) });
}

/** Which of these layers each 3D view has, and whether each shows. */
function layerState(win: Page, ids: string[]) {
  return inspect(
    win,
    ({ w, a }) => {
      const shown = (o: Obj | undefined) => {
        if (!o) return 'absent';
        for (let p: Obj | null = o; p; p = p.parent) if (!p.visible) return 'hidden';
        return 'shown';
      };
      const main = w.__stratlas.stage();
      const second = w.__stratlas.compare().second;
      return {
        main: Object.fromEntries(
          a.map((id) => [id, shown(main?.scene.getObjectByName(`layer:${id}`))]),
        ),
        second: Object.fromEntries(
          a.map((id) => [id, shown(second?.scene.getObjectByName(`layer:${id}`))]),
        ),
      };
    },
    ids,
  );
}

function views(win: Page) {
  return inspect(
    win,
    ({ w }) => ({
      main: w.__stratlas.stage()?.saveView() ?? null,
      second: w.__stratlas.compare().second?.saveView() ?? null,
    }),
    null,
  );
}

const close = (a: View | null, b: View | null, eps = 1e-3) =>
  !!a &&
  !!b &&
  a.position.every((v, i) => Math.abs(v - (b.position[i] ?? 0)) < eps) &&
  a.target.every((v, i) => Math.abs(v - (b.target[i] ?? 0)) < eps);

/** Drag across a canvas (orbit). */
async function orbit(win: Page, selector: string, dx: number) {
  const box = await win.locator(selector).boundingBox();
  if (!box) throw new Error(`no ${selector}`);
  // away from the centre, where the selected pile's callout sits
  const x = box.x + box.width * 0.3;
  const y = box.y + box.height * 0.75;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + dx, y + dx / 4, { steps: 10 });
  await win.mouse.up();
  // let the damped orbit settle: it glides one step per frame, for seconds on a software GPU
  await settled(win);
}

/** Wait until neither camera moves any more. */
async function settled(win: Page): Promise<void> {
  const same = (a: View | null, b: View | null) => (a === null && b === null) || close(a, b);
  await expect
    .poll(
      async () => {
        const a = await views(win);
        await win.waitForTimeout(400);
        const b = await views(win);
        return same(a.main, b.main) && same(a.second, b.second);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/* ----------------------------------------------------------------------- synthetic project */

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

fixtures(
  'a synthetic two-date project compares two 3D views; one date offers nothing',
  async ({ win, dataRoot }) => {
    // a second project next to the one-capture tiny project: a common site and a model per date
    const dir = join(dataRoot.root, 'projects', 'e2e-dates');
    await mkdir(join(dir, 'models'), { recursive: true });
    for (const f of ['site', 'model-2026-01-01', 'model-2026-06-01'])
      await writeFile(join(dir, 'models', `${f}.glb`), tinyGlb());
    const mesh = (id: string, name: string, at: number) => ({
      kind: 'mesh',
      id,
      name,
      visible: true,
      src: { path: `models/${id}.glb` },
      transform: [...IDENTITY.slice(0, 12), at, 0, 0, 1],
    });
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        ...tinyManifest(),
        id: 'e2e-dates',
        name: 'E2E two dates',
        captures: [
          { id: 'jan', label: 'January flight', date: '2026-01-01' },
          { id: 'jun', label: 'June flight', date: '2026-06-01' },
        ],
        layers: [
          mesh('site', 'Site', 0),
          mesh('model-2026-01-01', 'Model 1 Jan 2026', 2),
          mesh('model-2026-06-01', 'Model 1 Jun 2026', 4),
        ],
      }),
    );
    await writeFile(
      join(dir, 'issues.json'),
      JSON.stringify({ schema: 'aio.issues/1', issues: [] }),
    );

    // one capture: no comparison offered
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
    await expect(win.getByTestId('compare-dates')).toHaveCount(0);
    await win.keyboard.press('3');
    const right = win.getByTestId('pane-chooser-right').locator('select').first();
    await expect(right.locator('option[value="3d"]')).toBeDisabled();
    await expect(win.getByTestId('pane-date-left')).toHaveCount(0);

    // two dates: compare
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
    await win.getByTestId('project-card').filter({ hasText: 'E2E two dates' }).first().click();
    await expect(win.locator('[data-scene-view=""] canvas')).toBeVisible();
    await pinTwoViewTier(win);
    await win.getByTestId('compare-dates').click();
    await expect(win.locator('[data-scene-view] canvas')).toHaveCount(2);
    await expect(win.getByTestId('pane-date-left')).toHaveValue('jan');
    await expect(win.getByTestId('pane-date-right')).toHaveValue('jun');
    await expect(win.getByTestId('pane-date-left').locator('option:checked')).toHaveText(
      '1 Jan 2026',
    );

    const ids = ['site', 'model-2026-01-01', 'model-2026-06-01'];
    await expect
      .poll(() => layerState(win, ids))
      .toEqual({
        main: { site: 'shown', 'model-2026-01-01': 'shown', 'model-2026-06-01': 'hidden' },
        second: { site: 'shown', 'model-2026-01-01': 'absent', 'model-2026-06-01': 'shown' },
      });
    // the site model is parsed once for both views; each date's model once
    const models = await inspect(win, ({ w }) => w.__stratlas.compare().models, null);
    const siteKey = Object.keys(models.held).find((k) => k.includes('site.glb'));
    expect(siteKey && models.held[siteKey]).toBe(2);
    expect(models.hits).toBeGreaterThanOrEqual(2);

    // linked camera: a move on the main view moves the second
    await inspect(
      win,
      ({ w }) => {
        w.__stratlas.stage()?.restoreView({ position: [8, 6, 8], target: [2, 0, -0.5] });
      },
      null,
    );
    await expect
      .poll(async () => {
        const v = await views(win);
        return close(v.main, v.second);
      })
      .toBe(true);

    // the right side picks the left date: they swap
    await win.getByTestId('pane-date-right').selectOption('jan');
    await expect(win.getByTestId('pane-date-left')).toHaveValue('jun');
    await expect
      .poll(() => layerState(win, ids))
      .toEqual({
        main: { site: 'shown', 'model-2026-01-01': 'hidden', 'model-2026-06-01': 'shown' },
        second: { site: 'shown', 'model-2026-01-01': 'shown', 'model-2026-06-01': 'absent' },
      });

    // leaving the comparison: one 3D view, every date as the layer tree says
    await pinTwoViewTier(win);
    await win.getByTestId('compare-dates').click();
    await expect(win.locator('[data-scene-view] canvas')).toHaveCount(1);
    await expect
      .poll(() => layerState(win, ids))
      .toMatchObject({ main: { 'model-2026-01-01': 'shown', 'model-2026-06-01': 'shown' } });
    // the shared models of the second view are released
    await expect
      .poll(() => inspect(win, ({ w }) => w.__stratlas.compare().models.held, null))
      .toMatchObject({ [siteKey ?? 'site']: 1 });
  },
);

/* ----------------------------------------------------------------------- real projects */

interface Root {
  dir: string;
  data: string;
}

const real = base.extend<{ root: Root; app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  root: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-compare-'));
    const data = join(dir, 'data');
    await mkdir(join(data, 'projects'), { recursive: true });
    await mkdir(join(data, 'packs'), { recursive: true });
    // the world pack: the maps start (dark basemap), the orthos draw over it
    for (const f of ['world.pmtiles', 'world.json'])
      await copyRealData(['packs', f], join(data, 'packs', f));
    await use({ dir, data });
    await rm(dir, { recursive: true, force: true });
  },
  app: async ({ root }, use) => {
    const network = new NetworkGuard();
    const app = await launchApp({
      base: root.dir,
      root: root.data,
      userData: join(root.dir, 'user'),
      projectId: '',
      projectDir: '',
    });
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
    }
  },
  win: async ({ app }, use) => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 960);
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

interface Measure {
  views: number;
  fps: number;
  p50: number;
  p95: number;
  frames: number;
  gpuBytes: number[];
  geometries: number[];
  textures: number[];
  calls: number[];
  points: number[];
  processMB: { gpu: number; renderer: number; total: number };
}

/** Orbit the main view for `ms` (the link moves the second) and read the frame times. */
async function measure(app: ElectronApplication, win: Page, ms: number): Promise<Measure> {
  const r = await inspect(
    win,
    async ({ w, a }) => {
      const main = w.__stratlas.stage();
      if (!main) throw new Error('no stage');
      const second = w.__stratlas.compare().second;
      const stages = second ? [main, second] : [main];
      for (const s of stages) s.setPerfOverlay(true);
      const start = main.saveView();
      const [tx, , tz] = start.target;
      const dx = start.position[0] - tx;
      const dz = start.position[2] - tz;
      const radius = Math.hypot(dx, dz);
      const a0 = Math.atan2(dz, dx);
      const stamps: number[] = [];
      await new Promise<void>((done) => {
        let t0 = -1;
        const step = (now: number) => {
          if (t0 < 0) t0 = now;
          const t = Math.min(1, (now - t0) / a);
          stamps.push(now);
          const ang = a0 + t * Math.PI * 2;
          main.restoreView(
            {
              position: [
                tx + Math.cos(ang) * radius,
                start.position[1],
                tz + Math.sin(ang) * radius,
              ],
              target: start.target,
            },
            false,
          );
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      const dts = stamps
        .slice(1)
        .map((s, i) => s - (stamps[i] ?? s))
        .sort((x, y) => x - y);
      const pct = (q: number) =>
        dts[Math.min(dts.length - 1, Math.ceil((q / 100) * dts.length) - 1)] ?? 0;
      const mean = dts.reduce((x, y) => x + y, 0) / Math.max(1, dts.length);
      const stats = stages.map((s) => s.perfStats());
      const out = {
        views: stages.length,
        fps: 1000 / mean,
        p50: pct(50),
        p95: pct(95),
        frames: dts.length,
        gpuBytes: stats.map((s) => s.gpuBytes),
        calls: stats.map((s) => s.calls),
        points: stats.map((s) => s.points),
        geometries: stages.map((s) => s.renderer.info.memory.geometries),
        textures: stages.map((s) => s.renderer.info.memory.textures),
      };
      for (const s of stages) s.setPerfOverlay(false);
      return out;
    },
    ms,
  );
  const metrics = await app.evaluate(({ app: a }) =>
    a.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize })),
  );
  const mb = (t?: string) =>
    Math.round(metrics.filter((m) => !t || m.type === t).reduce((x, m) => x + m.kb, 0) / 1024);
  return { ...r, processMB: { gpu: mb('GPU'), renderer: mb('Tab'), total: mb() } };
}

async function report(testInfo: TestInfo, name: string, data: unknown) {
  const text = JSON.stringify(data, null, 2);
  process.stdout.write(`${name}\n${text}\n`);
  await testInfo.attach(name, { body: text, contentType: 'application/json' });
  if (SHOTS) await writeFile(join(SHOTS, `compare-${name}.json`), text);
}

real.describe('@realdata Masafi', () => {
  real.skip(!hasRealData('projects', 'masafi', 'volumes.json'), missingRealProject('masafi'));
  real.setTimeout(300_000);

  real(
    'two 3D views of the two surveys, linked camera and pile selection',
    async ({ app, win, root }, testInfo) => {
      // without the edits saved while testing the real project
      await copyRealData(['projects', 'masafi'], join(root.data, 'projects', 'masafi'), {
        include: (rel) => rel !== 'edits',
      });
      const errors: string[] = [];
      win.on('pageerror', (e) => errors.push(e.message));
      await win.reload();
      await win.getByTestId('project-card').filter({ hasText: 'Masafi' }).first().click();
      await expect(win.getByTestId('vol-register')).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => inspect(win, ({ w }) => w.__stratlas.volumetric.getState().status, null), {
          timeout: 30_000,
        })
        .toBe('ready');
      const ids = [
        'terrain-2020-12-31',
        'terrain-2021-01-10',
        'ortho-2020-12-31',
        'ortho-2021-01-10',
      ];
      await expect
        .poll(() => layerState(win, ids), { timeout: 30_000 })
        .toMatchObject({ main: { 'terrain-2021-01-10': 'shown' } });
      await win.waitForTimeout(1500);
      const single = await measure(app, win, 6000);

      // Compare dates: 31 Dec 2020 on the left, 10 Jan 2021 on the right
      await pinTwoViewTier(win);
      await win.getByTestId('compare-dates').click();
      await expect(win.locator('[data-scene-view] canvas')).toHaveCount(2);
      await expect(win.getByTestId('pane-date-left')).toHaveValue('survey-2020-12-31');
      await expect(win.getByTestId('pane-date-right')).toHaveValue('survey-2021-01-10');
      await expect(win.getByTestId('pane-date-left').locator('option:checked')).toHaveText(
        '31 Dec 2020',
      );
      // each view shows its survey's terrain; the second never loads the other date. Neither
      // draws the flat ortho in 3D: the terrain mesh carries the same photo (the map shows it)
      await expect
        .poll(() => layerState(win, ids), { timeout: 60_000 })
        .toEqual({
          main: {
            'terrain-2020-12-31': 'shown',
            'terrain-2021-01-10': 'hidden',
            'ortho-2020-12-31': 'hidden',
            'ortho-2021-01-10': 'hidden',
          },
          second: {
            'terrain-2020-12-31': 'absent',
            'terrain-2021-01-10': 'shown',
            'ortho-2020-12-31': 'absent',
            'ortho-2021-01-10': 'hidden',
          },
        });
      // the volumes panel follows the left date
      expect(await inspect(win, ({ w }) => w.__stratlas.volumetric.getState().epoch, null)).toBe(
        'e1',
      );
      // the 10 Jan terrain was parsed once: the main view holds it (hidden), the second shares it
      const models = await inspect(win, ({ w }) => w.__stratlas.compare().models, null);
      const key = Object.keys(models.held).find((k) => k.includes('terrain-2021-01-10'));
      expect(key && models.held[key]).toBe(2);
      await win.waitForTimeout(2500);
      await shot(win, 'masafi-3d');

      // linked camera: orbit the right view, the left follows
      const before = await views(win);
      expect(close(before.main, before.second)).toBe(true);
      await orbit(win, '[data-scene-view="compare"] canvas', 160);
      const after = await views(win);
      expect(close(after.main, before.main)).toBe(false);
      expect(close(after.main, after.second, 0.05)).toBe(true);

      // linked selection: a pile picked on the right is outlined on both dates
      const centre = await inspect(
        win,
        ({ w }) => {
          const s = w.__stratlas.compare().second;
          const node = s?.scene.getObjectByName('P05_e2') as
            | (Obj & {
                traverse(cb: (o: unknown) => void): void;
              })
            | undefined;
          if (!s || !node) return null;
          // set inside the traversal callback (TypeScript cannot see that)
          const found: { c: V3 | null } = { c: null };
          node.traverse((o) => {
            const m = o as {
              geometry?: {
                boundingSphere: {
                  center: {
                    clone(): { applyMatrix4(m: unknown): { x: number; y: number; z: number } };
                  };
                } | null;
                computeBoundingSphere(): void;
              };
              matrixWorld: unknown;
            };
            if (found.c || !m.geometry) return;
            if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
            const p = m.geometry.boundingSphere?.center.clone().applyMatrix4(m.matrixWorld);
            if (p) found.c = [p.x, p.y, p.z];
          });
          return found.c;
        },
        null,
      );
      expect(centre).not.toBeNull();
      if (!centre) return;
      await inspect(
        win,
        ({ w, a }) => {
          w.__stratlas.stage()?.restoreView({ position: [a[0], a[1] + 160, a[2] + 1], target: a });
        },
        centre,
      );
      await win.waitForTimeout(800);
      const box = await win.locator('[data-scene-view="compare"] canvas').boundingBox();
      if (!box) throw new Error('no second canvas');
      await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect
        .poll(() => inspect(win, ({ w }) => w.__stratlas.workspace.getState().selection, null))
        .toEqual({ kind: 'asset', id: 'P05_e2', layer: 'terrain-2021-01-10' });
      await expect
        .poll(() =>
          inspect(
            win,
            ({ w }) => [
              w.__stratlas.stage()?.highlight?.selected?.name ?? null,
              w.__stratlas.compare().second?.highlight?.selected?.name ?? null,
              w.__stratlas.volumetric.getState().selected,
            ],
            null,
          ),
        )
        .toEqual(['P05_e1', 'P05_e2', 'P05']);
      await win.waitForTimeout(1200);
      await shot(win, 'masafi-pile');

      // unlink: the right view moves alone
      await win.getByTestId('compare-link').click();
      await expect(win.getByTestId('compare-link')).toHaveAttribute('aria-pressed', 'false');
      const held = await views(win);
      await orbit(win, '[data-scene-view="compare"] canvas', -220);
      const apart = await views(win);
      expect(close(apart.main, held.main)).toBe(true);
      expect(close(apart.second, held.second)).toBe(false);
      await shot(win, 'masafi-unlinked');
      // link again: the left joins the view moved last
      await win.getByTestId('compare-link').click();
      await expect(win.getByTestId('compare-link')).toHaveAttribute('aria-pressed', 'true');
      // the link is applied after the button repaints (an effect), a frame later on a slow GPU
      await expect.poll(async () => close((await views(win)).main, apart.second, 0.05)).toBe(true);

      const two = await measure(app, win, 6000);
      const limit = await inspect(win, ({ w }) => w.__stratlas.compare().gpuLimit, null);
      const tier = await inspect(win, ({ w }) => w.__stratlas.graphics().getState(), null);
      await report(testInfo, 'masafi-perf', { tier, single, two, limit });
      expect(two.gpuBytes.reduce((x, y) => x + y, 0)).toBeLessThan(limit);

      // two maps, one ortho each, linked pan and zoom
      await win.getByTestId('pane-chooser-left').locator('select').first().selectOption('map');
      await win.getByTestId('pane-chooser-right').locator('select').first().selectOption('map');
      await expect(win.locator('.pane-map')).toHaveCount(2);
      await expect(win.getByTestId('pane-date-left')).toHaveValue('survey-2020-12-31');
      await expect(win.getByTestId('pane-date-right')).toHaveValue('survey-2021-01-10');
      await expect
        .poll(
          () => inspect(win, ({ w }) => w.__stratlas.compare().maps.every((m) => m !== null), null),
          {
            timeout: 30_000,
          },
        )
        .toBe(true);
      await inspect(
        win,
        ({ w }) => {
          const [a] = w.__stratlas.compare().maps;
          const c = a?.map.getCenter();
          if (a && c)
            a.map.jumpTo({ center: [c.lng + 0.0004, c.lat], zoom: a.map.getZoom() + 0.5 });
        },
        null,
      );
      await expect
        .poll(() =>
          inspect(
            win,
            ({ w }) => {
              const [a, b] = w.__stratlas.compare().maps;
              if (!a || !b) return false;
              const p = a.map.getCenter();
              const q = b.map.getCenter();
              return (
                Math.abs(p.lng - q.lng) < 1e-9 &&
                Math.abs(p.lat - q.lat) < 1e-9 &&
                Math.abs(a.map.getZoom() - b.map.getZoom()) < 1e-9
              );
            },
            null,
          ),
        )
        .toBe(true);
      await win.waitForTimeout(3000);
      await shot(win, 'masafi-maps');

      // two orthos, one per date, panned together
      await win.getByTestId('pane-chooser-left').locator('select').first().selectOption('raster');
      await win.getByTestId('pane-chooser-right').locator('select').first().selectOption('raster');
      await expect(win.getByTestId('raster-view')).toHaveCount(2);
      // translate x, y and scale of each pane's image
      const planes = () =>
        win
          .locator('.raster-plane')
          .evaluateAll((els) =>
            els.map((e) =>
              ((e as HTMLElement).style.transform.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(
                Number,
              ),
            ),
          );
      // within a pixel: the right pane is a pixel narrower (its border)
      const aligned = async () => {
        const [a = [], b = []] = await planes();
        return (
          a.length === 3 &&
          b.length === 3 &&
          Math.abs((a[0] ?? 0) - (b[0] ?? 0)) <= 1 &&
          Math.abs((a[1] ?? 0) - (b[1] ?? 0)) <= 1 &&
          Math.abs((a[2] ?? 1) / (b[2] ?? 1) - 1) < 1e-6
        );
      };
      // same placement on the ground, so the two dates line up pixel for pixel
      await expect.poll(aligned).toBe(true);
      const rv = await win.getByTestId('raster-view').first().boundingBox();
      if (!rv) throw new Error('no raster view');
      await win.mouse.move(rv.x + rv.width / 2, rv.y + rv.height / 2);
      await win.mouse.wheel(0, -600);
      await win.mouse.down();
      await win.mouse.move(rv.x + rv.width / 2 + 80, rv.y + rv.height / 2 + 40, { steps: 6 });
      await win.mouse.up();
      await expect.poll(aligned).toBe(true);
      await win.mouse.move(rv.x + 5, rv.y + rv.height - 5);
      await win.waitForTimeout(3000);
      await shot(win, 'masafi-orthos');

      // remembered: the split comes back as left
      await win.keyboard.press('1');
      await win.keyboard.press('3');
      await expect(win.getByTestId('pane-chooser-left').locator('select').first()).toHaveValue(
        'raster',
      );
      expect(errors).toEqual([]);
    },
  );
});

real.describe('@realdata Al-Zour with a synthetic second survey', () => {
  real.skip(!hasRealData('projects', 'alzour', 'manifest.json'), missingRealProject('alzour'));
  real.setTimeout(300_000);

  real(
    'two 3D views share the plant model and split the point budget',
    async ({ app, win, root }, testInfo) => {
      // the plant, the ortho and the thinned cloud; the second date reuses the same files
      const dst = join(root.data, 'projects', 'alzour-dates');
      await mkdir(dst, { recursive: true });
      for (const d of ['models', 'rasters/ortho', 'clouds/alzour'])
        await copyRealData(['projects', 'alzour', ...d.split('/')], join(dst, d));
      const src = JSON.parse(await readFile(join(ALZOUR, 'manifest.json'), 'utf8')) as {
        layers: { id: string; name: string; kind: string }[];
        [k: string]: unknown;
      };
      const keep = (id: string) => src.layers.find((l) => l.id === id);
      const plant = keep('plant');
      const ortho = keep('ortho');
      const cloud = keep('cloud');
      if (!plant || !ortho || !cloud) throw new Error('Al-Zour layers changed');
      await writeFile(
        join(dst, 'manifest.json'),
        JSON.stringify({
          ...src,
          id: 'alzour-dates',
          name: 'Al-Zour two dates',
          captures: [
            { id: 'survey-2023-02-21', label: 'Drone survey', date: '2023-02-21' },
            { id: 'survey-2023-08-30', label: 'Synthetic resurvey', date: '2023-08-30' },
          ],
          layers: [
            plant,
            ortho,
            { ...ortho, id: 'ortho-2023-08-30', name: 'Drone orthomosaic, 30 Aug 2023' },
            // the thinned cloud (hidden in the delivered project, which shows the COPC one)
            { ...cloud, visible: true },
            {
              ...cloud,
              visible: true,
              id: 'cloud-2023-08-30',
              name: 'Photogrammetry point cloud, 30 Aug 2023',
            },
          ],
        }),
      );
      await writeFile(
        join(dst, 'issues.json'),
        JSON.stringify({ schema: 'aio.issues/1', issues: [] }),
      );
      await win.reload();
      await win
        .getByTestId('project-card')
        .filter({ hasText: 'Al-Zour two dates' })
        .first()
        .click();
      await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
      const points = () =>
        inspect(
          win,
          ({ w }) => {
            const m = w.__stratlas.stage();
            m?.setPerfOverlay(true);
            return m?.perfStats().points ?? 0;
          },
          null,
        );
      await expect.poll(points, { timeout: 60_000 }).toBeGreaterThan(100_000);
      await win.waitForTimeout(4000);
      const single = await measure(app, win, 6000);

      await pinTwoViewTier(win);
      await win.getByTestId('compare-dates').click();
      await expect(win.locator('[data-scene-view] canvas')).toHaveCount(2);
      await expect
        .poll(() => layerState(win, ['plant', 'ortho', 'ortho-2023-08-30']), { timeout: 60_000 })
        .toEqual({
          main: { plant: 'shown', ortho: 'shown', 'ortho-2023-08-30': 'hidden' },
          second: { plant: 'shown', ortho: 'absent', 'ortho-2023-08-30': 'shown' },
        });
      // one parse of the plant for both views
      const models = await inspect(win, ({ w }) => w.__stratlas.compare().models, null);
      const key = Object.keys(models.held).find((k) => k.includes('plant.glb'));
      expect(key && models.held[key]).toBe(2);
      await win.waitForTimeout(6000);
      await shot(win, 'alzour-3d');
      const two = await measure(app, win, 6000);
      const limit = await inspect(win, ({ w }) => w.__stratlas.compare().gpuLimit, null);
      const budget = await inspect(
        win,
        () =>
          (
            window as unknown as {
              __stratlas: { pointcloud: { getState(): { budget: number } } };
            }
          ).__stratlas.pointcloud.getState().budget,
        null,
      );
      await report(testInfo, 'alzour-perf', { single, two, limit, budget });
      // each view draws its date's cloud; together they stay within the tier's point budget
      expect(two.points.every((p) => p > 50_000)).toBe(true);
      expect(two.points.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(budget * 1.1);
      expect(two.gpuBytes.reduce((x, y) => x + y, 0)).toBeLessThan(limit);
    },
  );
});
