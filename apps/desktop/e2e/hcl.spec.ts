/**
 * End to end on the real HCl tank project (1 mesh, 10 point clouds, 76 clips, 11 issues). Runs
 * only on machines that hold the project at E:\Stratlas Data\projects\hcl (or under
 * STRATLAS_HCL_DATA); skipped elsewhere. Read-only: it never edits the project.
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const HCL = join(DATA, 'projects', 'hcl');

/** Issues saved in the real project: 11 imported plus any the founder added while testing. */
function savedIssueCount(): number {
  const file = JSON.parse(readFileSync(join(HCL, 'issues.json'), 'utf8')) as { issues: unknown[] };
  return file.issues.length;
}

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

test('HCl opens with a drawn 3D scene, plays a clip and lists its saved issues', async ({
  win,
}) => {
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await win.getByTestId('project-card').filter({ hasText: 'HCl' }).first().click();
  const canvas = win.locator('[data-scene-view] canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => (await clock(win)).issues, { timeout: 30_000 })
    .toBe(savedIssueCount());

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
  await expect(win.locator('.nav-item', { hasText: 'Issues' }).locator('.count')).toHaveText(
    String(savedIssueCount()),
  );
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

/** The tank's materials as the renderer draws them (blending, opacity, depth writes). */
const tankMaterials = (win: Page) =>
  win.evaluate(() => {
    interface Mat {
      uuid: string;
      transparent: boolean;
      opacity: number;
      depthWrite: boolean;
    }
    interface Node {
      isMesh?: boolean;
      material?: Mat | Mat[];
      traverse(f: (o: Node) => void): void;
    }
    const stage = (
      window as unknown as {
        __stratlas: { stage(): { scene: { getObjectByName(n: string): Node | undefined } } | null };
      }
    ).__stratlas.stage();
    const mats = new Map<string, Mat>();
    stage?.scene.getObjectByName('layer:tank')?.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.set(m.uuid, m);
    });
    return [...mats.values()]
      .sort((a, b) => a.uuid.localeCompare(b.uuid))
      .map((m) => ({ transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite }));
  });

test('the tank is cut or made transparent only by hand; photos and flights reach Media', async ({
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

  // Flight 101, clip 3: the drone is inside the tank. Nothing is cut automatically.
  const section = () => inspect(win, (w) => w.__stratlas.stage()?.section.enabled);
  const cloudsHidden = () =>
    inspect(win, (w) => {
      const s = w.__stratlas.workspace.getState();
      return (s.project?.manifest.layers ?? [])
        .filter((l) => l.kind === 'pointcloud')
        .every((l) => s.hidden[l.id]);
    });
  const before = await tankMaterials(win);
  expect(before.length).toBeGreaterThan(0);
  const bar = win.locator('.seg-c.grp').first();
  const box = await bar.boundingBox();
  if (!box) throw new Error('no flight bar');
  await bar.click({ position: { x: box.width * 0.4, y: box.height / 2 } });
  const status = win.getByTestId('cutaway-status');
  await expect(status).toContainText('Drone inside the asset', { timeout: 20_000 });
  await win.waitForTimeout(1500);
  expect(await section()).toBe(false);
  expect(await cloudsHidden()).toBe(false);
  await win.keyboard.press('Space');

  // Cut, by hand from the toolbar: the section opens at the drone and the clouds hide.
  const tool = win.getByRole('button', { name: 'See inside the asset: cut or transparent' });
  await tool.click();
  const panel = win.getByTestId('cutaway-panel');
  await panel.getByRole('button', { name: 'Cut', exact: true }).click();
  await expect.poll(section).toBe(true);
  await expect(status).toContainText('Cut open at the drone');
  await expect.poll(cloudsHidden).toBe(true);

  // Transparent: the section comes back off, the tank's materials blend without depth writes.
  await panel.getByRole('button', { name: 'Transparent', exact: true }).click();
  await expect.poll(section).toBe(false);
  await expect(status).toContainText('Asset transparent');
  await expect
    .poll(async () => (await tankMaterials(win)).every((m) => m.transparent && !m.depthWrite))
    .toBe(true);
  await panel.getByRole('slider', { name: 'Opacity' }).fill('0.5');
  await expect
    .poll(async () =>
      (await tankMaterials(win)).every(
        (m, i) => Math.abs(m.opacity - 0.5 * (before[i]?.opacity ?? 1)) < 0.01,
      ),
    )
    .toBe(true);
  expect(await cloudsHidden()).toBe(true);
  // the popover never scrolls the stage sideways
  expect(await win.locator('.stage').evaluate((e) => e.scrollLeft)).toBe(0);
  await win.waitForTimeout(800);
  await shot(win, 'transparent');
  await win.keyboard.press('Escape');

  // The choice is remembered per project, across a restart of the window.
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openHcl(app, win);
  await expect
    .poll(async () => (await tankMaterials(win)).every((m) => m.transparent && !m.depthWrite), {
      timeout: 20_000,
    })
    .toBe(true);

  // Solid again: every material exactly as it was, the clouds back.
  await win.getByTestId('cutaway-status').getByRole('button', { name: 'Solid' }).click();
  // (the reload made new materials: compare them as a set)
  const sorted = (ms: unknown[]) => ms.map((m) => JSON.stringify(m)).sort();
  await expect.poll(async () => sorted(await tankMaterials(win))).toEqual(sorted(before));
  await expect.poll(cloudsHidden).toBe(false);
  expect(await section()).toBe(false);

  // Media groups the 76 clips into 10 flights.
  await win.locator('.nav-item', { hasText: 'Media' }).first().click();
  await expect(win.locator('.m-flight')).toHaveCount(10);
  await expect(win.locator('#m-flight-clips .m-card')).toHaveCount(7);
});

/** Off-screen screenshots for the founder's review (outside the repo). */
const SHOTS = process.env.STRATLAS_SHOTS;
async function shot(win: Page, name: string) {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `hcl-${name}.png`) });
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const boxOf = async (win: Page, testId: string): Promise<Box> => {
  const b = await win.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`no ${testId}`);
  return b;
};

test('the video window moves, resizes with its aspect ratio and remembers its place', async ({
  app,
  win,
}) => {
  await openHcl(app, win);
  const video = win.getByTestId('video-window');
  await expect(video).toBeVisible();
  const stage = await win.locator('.stage').boundingBox();
  if (!stage) throw new Error('no stage');
  const start = await boxOf(win, 'video-window');
  // It starts at the bottom left of the stage.
  expect(start.x - stage.x).toBeCloseTo(12, 0);

  // Drag the title bar: the window follows the pointer.
  const head = await boxOf(win, 'video-header');
  const from = { x: head.x + 60, y: head.y + head.height / 2 };
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x + 300, from.y - 200, { steps: 10 });
  await win.mouse.up();
  const moved = await boxOf(win, 'video-window');
  expect(moved.x - start.x).toBeCloseTo(300, -1);
  expect(moved.y - start.y).toBeCloseTo(-200, -1);
  expect(moved.width).toBeCloseTo(start.width, 0);

  // Dragging far away keeps it inside the stage.
  await win.mouse.move(from.x + 300, from.y - 200);
  await win.mouse.down();
  await win.mouse.move(from.x + 4000, from.y - 4000, { steps: 6 });
  await win.mouse.up();
  const corner = await boxOf(win, 'video-window');
  expect(corner.x + corner.width).toBeLessThanOrEqual(stage.x + stage.width - 11);
  // the title bar stays below the toolbar row, where it can be grabbed again
  expect(corner.y).toBeGreaterThanOrEqual(stage.y + 55);
  // ... and back to the left, half way down
  const head2 = await boxOf(win, 'video-header');
  const dx = stage.x + 60 - corner.x;
  const dy = stage.y + stage.height * 0.3 - corner.y;
  await win.mouse.move(head2.x + 60, head2.y + 10);
  await win.mouse.down();
  await win.mouse.move(head2.x + 60 + dx, head2.y + 10 + dy, { steps: 10 });
  await win.mouse.up();
  const mid = await boxOf(win, 'video-window');

  // The bottom-right corner resizes; the frame keeps 16:9.
  const se = win.locator('.vwin-rs.rs-se');
  const h = await se.boundingBox();
  if (!h) throw new Error('no resize corner');
  await win.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await win.mouse.down();
  await win.mouse.move(h.x + h.width / 2 + 160, h.y + h.height / 2 + 20, { steps: 10 });
  await win.mouse.up();
  const bigger = await boxOf(win, 'video-window');
  expect(bigger.width - mid.width).toBeCloseTo(160, -1);
  expect(bigger.x).toBeCloseTo(mid.x, 0);
  expect(bigger.y).toBeCloseTo(mid.y, 0);
  const frame = await win.locator('.vwin .vframe').boundingBox();
  if (!frame) throw new Error('no frame');
  expect(frame.width / frame.height).toBeCloseTo(16 / 9, 1);
  await shot(win, 'video-moved');

  // The west edge cannot shrink it below the minimum.
  const w = await win.locator('.vwin-rs.rs-w').boundingBox();
  if (!w) throw new Error('no west edge');
  await win.mouse.move(w.x + 2, w.y + w.height / 2);
  await win.mouse.down();
  await win.mouse.move(w.x + 2 + 2000, w.y + w.height / 2, { steps: 6 });
  await win.mouse.up();
  const smallest = await boxOf(win, 'video-window');
  expect(smallest.width).toBeCloseTo(240, -1);
  expect(smallest.x + smallest.width).toBeCloseTo(bigger.x + bigger.width, -1);

  // Keyboard: the focused title bar moves with the arrow keys and resizes with plus.
  await win.getByTestId('video-header').focus();
  await win.keyboard.press('ArrowLeft');
  await win.keyboard.press('Shift+ArrowUp');
  await win.keyboard.press('+');
  const keyed = await boxOf(win, 'video-window');
  expect(keyed.x - smallest.x).toBeCloseTo(-10, 0);
  expect(keyed.width - smallest.width).toBeCloseTo(20, 0);
  expect(keyed.y + keyed.height - (smallest.y + smallest.height)).toBeCloseTo(-50, 0);

  // Callouts keep clear of the moved window.
  await win.waitForTimeout(800);
  const overlapping = await win.evaluate(() => {
    const v = document.querySelector('[data-testid="video-window"]')?.getBoundingClientRect();
    if (!v) return -1;
    return [...document.querySelectorAll('[data-callout]')].filter((c) => {
      const r = c.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(c).visibility === 'hidden') return false;
      return r.left < v.right && r.right > v.left && r.top < v.bottom && r.bottom > v.top;
    }).length;
  });
  expect(overlapping).toBe(0);

  // Place and size survive leaving the scene.
  await win.locator('.nav-item', { hasText: 'Issues' }).first().click();
  await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
  await expect(video).toBeVisible();
  const back = await boxOf(win, 'video-window');
  expect(back.x).toBeCloseTo(keyed.x, 0);
  expect(back.width).toBeCloseTo(keyed.width, 0);

  // Double-click on the title puts it back.
  await win.getByTestId('video-header').dblclick({ position: { x: 40, y: 10 } });
  const reset = await boxOf(win, 'video-window');
  expect(reset.x).toBeCloseTo(start.x, 0);
  expect(reset.y).toBeCloseTo(start.y, 0);
});

/** Shown state of the project's layers, and whether the tank group draws in 3D. */
const layerState = (win: Page) =>
  inspect(win, (w) => {
    const s = w.__stratlas.workspace.getState();
    const layers = s.project?.manifest.layers ?? [];
    const off = (kind?: string) =>
      layers.filter((l) => (kind ? l.kind === kind : true) && s.hidden[l.id]).length;
    const tank = w.__stratlas.stage()?.scene.getObjectByName('layer:tank') as
      { visible?: boolean } | undefined;
    return {
      total: layers.length,
      clouds: layers.filter((l) => l.kind === 'pointcloud').length,
      hidden: off(),
      cloudsHidden: off('pointcloud'),
      tankVisible: tank?.visible === true,
    };
  });

test('the eye over all layers and the group eyes switch many layers at once', async ({
  app,
  win,
}) => {
  await openHcl(app, win);
  const master = win.locator('.tree-h .eye');
  await expect(master).toHaveAttribute('data-visibility', 'all');
  const start = await layerState(win);
  expect(start.hidden).toBe(0);

  // One click hides every layer, the tank included.
  await master.click();
  await expect.poll(async () => (await layerState(win)).hidden).toBe(start.total);
  await expect.poll(async () => (await layerState(win)).tankVisible).toBe(false);
  await expect(master).toHaveAttribute('data-visibility', 'none');

  // A group eye shows just its group: the master turns mixed.
  const clouds = win.locator('.tgroup-row', { hasText: 'Point clouds' }).locator('.eye');
  await expect(clouds).toHaveAttribute('aria-label', 'Point clouds: show all');
  await clouds.click();
  await expect.poll(async () => (await layerState(win)).cloudsHidden).toBe(0);
  expect((await layerState(win)).hidden).toBe(start.total - start.clouds);
  await expect(master).toHaveAttribute('data-visibility', 'mixed');

  // From mixed the master shows everything again.
  await master.click();
  await expect.poll(async () => (await layerState(win)).hidden).toBe(0);
  await expect.poll(async () => (await layerState(win)).tankVisible).toBe(true);
  await expect(master).toHaveAttribute('data-visibility', 'all');

  // Hiding the clouds group hides the clouds only.
  await clouds.click();
  await expect.poll(async () => (await layerState(win)).cloudsHidden).toBe(start.clouds);
  expect((await layerState(win)).hidden).toBe(start.clouds);
  await expect(master).toHaveAttribute('data-visibility', 'mixed');
  await shot(win, 'master-eye');
  await clouds.click();
  await expect.poll(async () => (await layerState(win)).hidden).toBe(0);
});

test('split screen: each side shows the pane chosen for it', async ({ app, win }) => {
  await openHcl(app, win);
  await win.keyboard.press('3');
  const left = win.getByTestId('pane-chooser-left').locator('select');
  const right = win.getByTestId('pane-chooser-right').locator('select');
  // As before: 3D on the left, the map on the right.
  await expect(left).toHaveValue('3d');
  await expect(right).toHaveValue('map');
  await expect(win.locator('.pane-map')).toBeVisible();

  // HCl offers what it has: no rasters, so no ortho. The 3D view cannot go on both sides.
  const offered = await right.locator('option').evaluateAll((os) =>
    os.map((o) => ({
      value: (o as HTMLOptionElement).value,
      off: (o as HTMLOptionElement).disabled,
    })),
  );
  expect(offered).toEqual([
    { value: '3d', off: true },
    { value: 'map', off: false },
    { value: 'video', off: false },
    { value: 'photo', off: false },
    { value: 'report', off: false },
  ]);

  // Video on the right: the floating window gives way to the pane, the map goes.
  await right.selectOption('video');
  await expect(win.getByTestId('pane-video')).toBeVisible();
  await expect(win.getByTestId('video-window')).toHaveCount(0);
  await expect(win.locator('.pane-map')).toHaveCount(0);
  await expect(win.getByTestId('pane-video').locator('[data-video-window] video')).toHaveCount(1);
  const panes = async () => {
    const l = await win.locator('.pane-3d').boundingBox();
    const r = await win.getByTestId('pane-video').boundingBox();
    if (!l || !r) throw new Error('no panes');
    return { l, r };
  };
  const { l, r } = await panes();
  expect(l.x).toBeLessThan(r.x);
  expect(l.width).toBeCloseTo(r.width, -1);
  await win.waitForTimeout(1200);
  await shot(win, 'split-3d-video');

  // Photos on the left: the 3D view hides (still one stage), the photo shows there.
  await left.selectOption('photo');
  await expect(win.getByTestId('pane-photo')).toBeVisible();
  await expect(win.locator('.pane-3d')).toHaveClass(/is-hidden/);
  await expect(win.locator('[data-scene-view] canvas')).toHaveCount(1);
  const photoBox = await win.getByTestId('pane-photo').boundingBox();
  const videoBox = await win.getByTestId('pane-video').boundingBox();
  if (!photoBox || !videoBox) throw new Error('no panes');
  expect(photoBox.x).toBeLessThan(videoBox.x);
  await win.getByRole('button', { name: 'Next photo' }).click();
  await expect(win.getByTestId('pane-photo').locator('.pane-bar')).toContainText('2 of');

  // The report on the right; the left cannot pick it as well.
  await right.selectOption('report');
  await expect(win.getByTestId('pane-report')).toBeVisible();
  await expect(left.locator('option[value="report"]')).toBeDisabled();
  await expect(win.getByTestId('pane-report').locator('canvas').first()).toBeVisible({
    timeout: 20_000,
  });
  await win.waitForTimeout(800);
  await shot(win, 'split-photo-report');

  // Remembered per project: back to the scene after a restart of the window.
  await left.selectOption('3d');
  await right.selectOption('video');
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openHcl(app, win);
  await win.keyboard.press('3');
  await expect(win.getByTestId('pane-chooser-left').locator('select')).toHaveValue('3d');
  await expect(win.getByTestId('pane-chooser-right').locator('select')).toHaveValue('video');
  await expect(win.getByTestId('pane-video')).toBeVisible();

  // 3D mode alone has no choosers and the floating video comes back.
  await win.keyboard.press('1');
  await expect(win.getByTestId('pane-chooser-left')).toHaveCount(0);
  await expect(win.getByTestId('video-window')).toBeVisible();
});
