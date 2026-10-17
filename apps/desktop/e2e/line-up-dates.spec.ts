/**
 * Line up dates (a saved sideways correction on one survey date) on a copy of the change demo
 * whose second date sits 2 m east of where it should (`createMisalignedDemo`): the background
 * offer and "Not now", the Changes panel refusal and its Line up dates step with the imagery
 * change that then runs by itself, the lined-up date in 3D, on two maps, for pins and in Swipe,
 * and Undo with a pin drawn after the line-up. Synthetic data, off-screen, zero network. Skipped
 * without the change demo (`pnpm demo:build --quick`) or the pipeline Python (the measurement and
 * the change run are pipeline jobs, `uv sync` in python/ or QUADRION_E2E_PYTHON).
 */
import type { Page } from '@playwright/test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createMisalignedDemo,
  expect,
  hasChangeDemo,
  hasPipelinePython,
  launchApp,
  NetworkGuard,
  openProject,
  PIPELINE_ENV,
  test as base,
  VENV_PYTHON,
  changeDemoTruth,
  type DataRoot,
} from './fixtures';
import { expectRegionsMatchTruth, type Item, type RasterTruth } from './changeRaster';
import { toggleCompareDates } from './island';
import { choosePane } from './panoFixtures';

interface Misaligned {
  id: string;
  root: string;
}

type XYZ = [number, number, number];

/** Where the demo's T-201 stands and the top of its cone roof (tools/demo/change-scene.mjs). */
const TANK = { name: 'T-201', cx: -26, cz: -18, top: 10.2 };
/** A point on the cone roof, a little off the apex (the apex has the model's tag label on it). */
const ROOF: XYZ = [TANK.cx, 9.6, TANK.cz + 3];
/** The apex of the roof as the demo puts it, and as the moved date stores it (2 m east). */
const apex = (eastM: number): XYZ => [TANK.cx + eastM, TANK.top + 0.02, TANK.cz];

const SAVED = { eastM: -2, northM: 0, with: 'd1', at: '2026-10-16T08:00:00.000Z' };

const issue = (id: string, code: string, capture: string, layer: string, p: XYZ) => ({
  id,
  code,
  classId: 'corrosion',
  severityModelId: 'general-inspection',
  severity: 2,
  status: 'reviewed',
  title: `Pin ${code}`,
  note: '',
  author: 'E2E',
  createdAt: '2026-04-14T08:00:00.000Z',
  updatedAt: '2026-04-14T08:00:00.000Z',
  source: 'human',
  capture,
  sightings: [{ on: 'mesh', layer, geom: { type: 'spoint', p, n: [0, 1, 0] } }],
});

interface Fixtures {
  /** The change demo with `d2` 2 m east of where it belongs, written before the app starts. */
  misaligned: Misaligned;
  /** The same, already lined up (`d2.lineUp` saved), with a pin on the tank of each date. */
  linedUp: Misaligned;
}

const test = base.extend<Fixtures>({
  misaligned: async ({ dataRoot }, use, testInfo) => {
    testInfo.skip(
      !hasChangeDemo(),
      'no change demo: run pnpm demo:build --quick (or pnpm demo:change --quick)',
    );
    testInfo.skip(
      !hasPipelinePython(),
      `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`,
    );
    await use(await createMisalignedDemo(dataRoot, { eastM: 2, northM: 0 }));
  },
  linedUp: async ({ misaligned }, use) => {
    const file = join(misaligned.root, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      captures: { id: string; lineUp?: unknown }[];
    };
    const d2 = manifest.captures.find((c) => c.id === 'd2');
    if (!d2) throw new Error('no d2');
    d2.lineUp = SAVED;
    await writeFile(file, JSON.stringify(manifest, null, 2));
    // a pin on the tank roof of each date: d2's is stored where its own model has the tank
    await writeFile(
      join(misaligned.root, 'issues.json'),
      JSON.stringify(
        {
          schema: 'aio.issues/1',
          issues: [
            issue('pin-d1', 'P01', 'd1', 'model-d1', apex(0)),
            issue('pin-d2', 'P02', 'd2', 'model-d2', apex(2)),
          ],
        },
        null,
        2,
      ),
    );
    await use(misaligned);
  },
});

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`);

/* ---------------------------------------------------------------------------- probes */

interface Mat {
  elements: number[];
}
interface Obj {
  name: string;
  visible: boolean;
  parent: Obj | null;
  matrixWorld: Mat;
  updateWorldMatrix(parents: boolean, children: boolean): void;
  getObjectByName(n: string): Obj | undefined;
  userData: { layout?: { items: { members: { issueId: string }[]; world: XYZ }[] } };
}
interface Cam {
  matrixWorldInverse: Mat;
  projectionMatrix: Mat;
}
interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        project: {
          manifest: {
            captures: { id: string; lineUp?: { eastM: number; northM: number; with: string } }[];
          };
        } | null;
        issues: { id: string; sightings: { layer?: string; geom?: { p?: number[] } }[] }[];
        select(s: { kind: string; id: string } | null): void;
      };
    };
    stage(): { scene: Obj; camera: Cam; renderer: { domElement: HTMLCanvasElement } } | null;
  };
}

/** Run a probe in the renderer with the inspection hook typed (sent as a function, no eval). */
async function inspect<T, A>(
  win: Page,
  probe: (x: { w: Probe; a: A }) => T | Promise<T>,
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

/** The saved line-up of a date, read from the open project's manifest. */
const lineUpOf = (win: Page, capture: string) =>
  inspect(
    win,
    ({ w, a }) =>
      w.__stratlas.workspace.getState().project?.manifest.captures.find((c) => c.id === a)
        ?.lineUp ?? null,
    capture,
  );

/** The finished `change.lineup` jobs of the project (each start measures the pair once), with whether their `lineup.json` verdict is ok. */
async function finishedMeasures(root: string): Promise<{ ok: boolean }[]> {
  const dir = join(root, 'jobs');
  const out: { ok: boolean }[] = [];
  for (const id of await readdir(dir).catch(() => [] as string[])) {
    const read = async (
      file: string,
    ): Promise<{ pipeline?: string; status?: string; verdict?: string } | null> =>
      JSON.parse(await readFile(join(dir, id, file), 'utf8').catch(() => 'null')) as {
        pipeline?: string;
        status?: string;
        verdict?: string;
      } | null;
    const job = await read('job.json');
    if (job?.pipeline !== 'change.lineup' || job.status !== 'done') continue;
    out.push({ ok: (await read('lineup.json'))?.verdict === 'ok' });
  }
  return out;
}

/** The saved line-up of a date, read from `manifest.json` on disk. */
async function lineUpOnDisk(root: string, capture: string) {
  const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    captures: { id: string; lineUp?: { eastM: number; northM: number; with: string } }[];
  };
  return m.captures.find((c) => c.id === capture)?.lineUp ?? null;
}

/** The world x of a layer's node in the 3D scene (its transform and the date's shift). */
const nodeX = (win: Page, layer: string) =>
  inspect(
    win,
    ({ w, a }) => {
      const node = w.__stratlas.stage()?.scene.getObjectByName(`layer:${a}`);
      if (!node) return null;
      node.updateWorldMatrix(true, false);
      return node.matrixWorld.elements[12] ?? null;
    },
    layer,
  );

/** The pins the 3D view lays out: each issue's id and world position (clusters give the mean). */
const pinWorlds = (win: Page) =>
  inspect(
    win,
    ({ w }) => {
      const layout = w.__stratlas.stage()?.scene.getObjectByName('annotate-issue-pins')
        ?.userData.layout;
      return (layout?.items ?? []).flatMap((i) =>
        i.members.map((m) => ({ id: m.issueId, world: i.world, n: i.members.length })),
      );
    },
    null,
  );

/** The top left corner (lon, lat) of a raster layer's first image on one map of the comparison. */
const quadCorner = (win: Page, side: number, layer: string) =>
  inspect(
    win,
    ({ w, a }) => {
      const compare = (
        w.__stratlas as unknown as {
          compare(): {
            maps: ({
              map: { getSource(id: string): { coordinates?: [number, number][] } | undefined };
            } | null)[];
          };
        }
      ).compare();
      const corner = compare.maps[a.side]?.map.getSource(`aio-raster-${a.layer}-0`)
        ?.coordinates?.[0];
      return corner ? ([corner[0], corner[1]] as [number, number]) : null;
    },
    { side, layer },
  );

/** Metres between two (lon, lat) points close together. */
function metresApart(a: [number, number], b: [number, number]): number {
  const m = 111_320;
  return Math.hypot((a[0] - b[0]) * m * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * m);
}

/** Drag the swipe divider (at its present place) to the page x `to`, along the middle of the stage. */
async function dragDivider(win: Page, to: number): Promise<void> {
  const handle = await win.getByTestId('compare-divider').boundingBox();
  const stage = await win.locator('.stage-panes').boundingBox();
  if (!handle || !stage) throw new Error('no stage or divider');
  const y = stage.y + stage.height / 2;
  await win.mouse.move(handle.x + handle.width / 2, y);
  await win.mouse.down();
  await win.mouse.move(to, y, { steps: 8 });
  await win.mouse.up();
}

/**
 * The strip of the earlier ortho's picture across the three tanks of the demo (x -32 to 14 m,
 * z -24 to -16 m of its 96 m square), in page pixels: the part of the site both dates show alike.
 */
async function tankBand(
  win: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const img = await win.locator('.pane-raster[data-side="left"] .raster-plane img').boundingBox();
  if (!img) throw new Error('no ortho picture');
  const at = (m: number) => (m + 48) / 96;
  return {
    x: img.x + img.width * at(-32),
    y: img.y + img.height * at(-24),
    width: img.width * (at(14) - at(-32)),
    height: img.height * (at(-16) - at(-24)),
  };
}

/**
 * The columns of `band` (page pixels) with the strongest vertical edges (a change of brightness
 * from one column to the next, summed down the strip): the `count` strongest, a few pixels apart.
 */
async function verticalEdges(
  win: Page,
  band: { x: number; y: number; width: number; height: number },
  count: number,
): Promise<number[]> {
  const png = (await win.screenshot({ clip: band })).toString('base64');
  return win.evaluate(
    async ({ data, count }) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return [];
      ctx.drawImage(bmp, 0, 0);
      const { data: px, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const grey = (x: number, row: number) => {
        const i = (row * width + x) * 4;
        return 0.3 * (px[i] ?? 0) + 0.59 * (px[i + 1] ?? 0) + 0.11 * (px[i + 2] ?? 0);
      };
      const strength: number[] = [];
      for (let x = 0; x < width; x++) {
        let sum = 0;
        if (x >= 1 && x < width - 1)
          for (let row = 0; row < height; row++)
            sum += Math.abs(grey(x + 1, row) - grey(x - 1, row));
        strength.push(sum);
      }
      const out: number[] = [];
      const order = strength.map((v, x) => [v, x] as const).sort((a, b) => b[0] - a[0]);
      for (const [v, x] of order) {
        if (v <= 0 || out.length >= count) break;
        if (out.every((c) => Math.abs(c - x) > 6)) out.push(x);
      }
      return out;
    },
    { data: png, count },
  );
}

/** The issues in `issues.json` with where each is seen. */
async function issuesOnDisk(root: string) {
  const file = JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as {
    issues: { id: string; sightings: { layer?: string; geom?: { p?: number[] } }[] }[];
  };
  return file.issues;
}

/** Where a point of the scene is on the screen (page pixels), for a click on it. */
const screenPoint = (win: Page, p: XYZ) =>
  inspect(
    win,
    ({ w, a }) => {
      const stage = w.__stratlas.stage();
      if (!stage) throw new Error('no 3D view');
      const { matrixWorldInverse: view, projectionMatrix: proj } = stage.camera;
      const mul = (m: number[], v: number[]) =>
        [0, 1, 2, 3].map(
          (r) =>
            (m[r] ?? 0) * (v[0] ?? 0) +
            (m[4 + r] ?? 0) * (v[1] ?? 0) +
            (m[8 + r] ?? 0) * (v[2] ?? 0) +
            (m[12 + r] ?? 0) * (v[3] ?? 0),
        );
      const c = mul(proj.elements, mul(view.elements, [a[0], a[1], a[2], 1]));
      const r = stage.renderer.domElement.getBoundingClientRect();
      const w4 = c[3] ?? 1;
      return {
        x: r.left + (((c[0] ?? 0) / w4 + 1) / 2) * r.width,
        y: r.top + ((1 - (c[1] ?? 0) / w4) / 2) * r.height,
      };
    },
    p,
  );

async function openMisaligned(win: Page, id: string): Promise<void> {
  const card = win.getByTestId('project-card').filter({ hasText: 'E2E misaligned dates' });
  if (
    !(await card
      .first()
      .isVisible()
      .catch(() => false))
  )
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await card.first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 60_000 }).toBe(id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 60_000 });
}

/**
 * Start the app on `dataRoot`'s profile, run `body` and close it; the profile (and with it the
 * renderer's localStorage) stays for the next start. Zero network, as the fixtures.
 */
async function withApp(dataRoot: DataRoot, body: (win: Page) => Promise<void>): Promise<void> {
  const network = new NetworkGuard();
  const app = await launchApp(dataRoot, PIPELINE_ENV);
  await network.attach(app);
  let outbound: string[];
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await body(win);
    outbound = await network.outbound();
  } finally {
    await app.close();
  }
  expect(outbound, 'the app made network requests').toEqual([]);
}

/* ---------------------------------------------------------------------------- the specs */

test('a misaligned survey offers Line up dates, and Not now is remembered', async ({
  dataRoot,
  misaligned,
}) => {
  test.setTimeout(360_000);
  const answers = (win: Page, key: 'measured' | 'notNow') =>
    win.evaluate((k) => {
      try {
        return (JSON.parse(localStorage.getItem(`quadrion.lineUp.${k}`) ?? '[]') as unknown[])
          .length;
      } catch {
        return -1;
      }
    }, key);

  // first start: the offer, then Not now
  await withApp(dataRoot, async (win) => {
    await openMisaligned(win, misaligned.id);
    const text = win.getByTestId('lineup-offer-text');
    await expect(text).toHaveText(
      /^Survey 13 April 2026 doesn't line up with Survey 2 March 2026\. Its ortho sits 2\.\d\d m away\.$/,
      { timeout: 180_000 },
    );
    const away = Number(/sits (\d\.\d\d) m/.exec((await text.textContent()) ?? '')?.[1]);
    expect(away).toBeGreaterThanOrEqual(1.9);
    expect(away).toBeLessThanOrEqual(2.1);

    await win.getByTestId('lineup-offer-later').click();
    await expect(win.getByTestId('lineup-offer')).toHaveCount(0);
    expect(await answers(win, 'notNow')).toBe(1);
    // Forget only that the pair was measured, so that the next start measures it again: then it
    // is the answer that keeps the offer away, not the memory of having looked.
    expect(await answers(win, 'measured')).toBe(1);
    await win.evaluate(() => {
      localStorage.removeItem('quadrion.lineUp.measured');
    });
  });

  // second start on the same profile: measured again, no offer
  await withApp(dataRoot, async (win) => {
    expect(await answers(win, 'notNow')).toBe(1);
    expect(await answers(win, 'measured')).toBe(0);
    await openMisaligned(win, misaligned.id);
    await expect.poll(() => answers(win, 'measured'), { timeout: 180_000 }).toBe(1);
    // the measurement of this start finished and found the pair misaligned (a failed one would
    // also leave no offer), so the answer is what keeps the offer away
    const done = () => finishedMeasures(misaligned.root);
    await expect.poll(done, { timeout: 60_000 }).toHaveLength(2);
    for (const m of await done()) expect(m.ok, 'a measurement found the pair').toBe(true);
    // held over the whole window, not only looked at once
    await win.waitForTimeout(10_000);
    await expect(win.getByTestId('lineup-offer')).toHaveCount(0);
    expect(await lineUpOnDisk(misaligned.root, 'd2')).toBeNull();
  });
});

test('imagery change refused, lined up from the Changes panel, then runs clean', async ({
  misaligned,
  win,
}) => {
  test.setTimeout(480_000);
  const truth = changeDemoTruth();
  const { from, to } = truth.captures;
  const tiles = join(misaligned.root, 'rasters', 'ortho-d2', 'tiles.json');
  const tilesBefore = await readFile(tiles);
  await openMisaligned(win, misaligned.id);

  // 1. the run is refused, and the panel says why
  await win.getByTestId('tab-changes').click();
  const run = win.getByTestId('change-panel').getByTestId('change-producer-raster');
  await expect(run).toBeEnabled();
  await run.click();
  const refused = win.getByTestId('chg-misaligned');
  await expect(refused).toHaveText(/These dates are 2\.0\d m apart\./, { timeout: 120_000 });

  // 2. the step: no date is kept until one is chosen
  await win.getByTestId('chg-lineup').click();
  const dialog = win.getByTestId('lineup-dialog');
  await expect(dialog).toBeVisible();
  const confirm = win.getByTestId('lineup-confirm');
  await expect(confirm).toBeDisabled();
  await win.getByTestId('lineup-keep-d1').click();
  await expect(win.getByTestId('lineup-shift')).toHaveText(/^2\.0\d m west, 0\.0\d m north/, {
    timeout: 120_000,
  });
  await expect(win.getByTestId('lineup-confidence')).toHaveText(/^Confident/);
  await expect(confirm).toBeEnabled();
  await win.getByTestId('lineup-after').click();
  await expect(win.getByTestId('lineup-after')).toHaveAttribute('aria-pressed', 'true');
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(win.getByTestId('lineup-text')).toHaveText(
    /^Survey 13 April 2026 lined up with Survey 2 March 2026 \(2\.0\d m\)\.$/,
  );

  // 3. saved on the date that moved, nothing written into its files
  const saved = await lineUpOnDisk(misaligned.root, 'd2');
  expect(saved?.eastM).toBeCloseTo(-2, 1);
  expect(Math.abs((saved?.northM ?? 9) - 0)).toBeLessThan(0.1);
  expect(saved?.with).toBe('d1');
  expect(await lineUpOnDisk(misaligned.root, 'd1')).toBeNull();
  expect((await readFile(tiles)).equals(tilesBefore)).toBe(true);

  // 4. the imagery change starts again by itself and finishes
  const file = join(misaligned.root, 'change', `${from}-${to}-raster.json`);
  await expect
    .poll(() => readFile(file, 'utf8').catch(() => null), { timeout: 360_000, intervals: [1000] })
    .not.toBeNull();
  const raster = JSON.parse(await readFile(file, 'utf8')) as {
    items: Item[];
    registration: { ok: boolean; shiftM: number };
  };
  expect(raster.registration.ok).toBe(true);
  expect(raster.registration.shiftM).toBeLessThan(0.2);
  expectRegionsMatchTruth(raster.items, truth.changes.raster as unknown as RasterTruth);
  await expect(refused).toHaveCount(0);
});

test('the lined-up date lines up in 3D, on the map and for pins', async ({ linedUp, win }) => {
  test.setTimeout(300_000);
  await openMisaligned(win, linedUp.id);
  await expect.poll(() => lineUpOf(win, 'd2')).toMatchObject({ eastM: -2, with: 'd1' });

  // 3D: the two models stand on each other (d2's own placement is 2 m east)
  await expect.poll(async () => (await nodeX(win, 'model-d1')) !== null).toBe(true);
  expect(Math.abs((await nodeX(win, 'model-d2')) ?? NaN)).toBeLessThan(0.05);
  expect(Math.abs((await nodeX(win, 'model-d1')) ?? NaN)).toBeLessThan(0.05);

  // pins: one on the tank roof of each date (d2's stored 2 m east, with its model), drawn on the
  // same spot; a date's pins show with its folder eye
  const eye = (d: string) =>
    win.getByTestId(`date-folder-${d}`).locator('.dfolder-row .eye[data-visibility]');
  await eye('d1').click();
  await expect(eye('d1')).toHaveAttribute('data-visibility', 'all');
  // a date with some layers hidden shows all of them on the first click, hides them on the next
  if ((await eye('d2').getAttribute('data-visibility')) !== 'all') await eye('d2').click();
  await expect(eye('d2')).toHaveAttribute('data-visibility', 'all');
  const pinOf = async (id: string) => {
    const pin = (await pinWorlds(win)).find((p) => p.id === id);
    if (!pin) throw new Error(`no pin ${id} drawn`);
    return pin.world;
  };
  await expect
    .poll(async () => (await pinWorlds(win)).map((p) => p.id).sort())
    .toEqual(['pin-d1', 'pin-d2']);
  await eye('d2').click();
  await expect(eye('d2')).toHaveAttribute('data-visibility', 'none');
  await expect.poll(async () => (await pinWorlds(win)).map((p) => p.id)).toEqual(['pin-d1']);
  const onD1 = await pinOf('pin-d1');
  await eye('d2').click();
  await eye('d1').click();
  await expect(eye('d1')).toHaveAttribute('data-visibility', 'none');
  await expect.poll(async () => (await pinWorlds(win)).map((p) => p.id)).toEqual(['pin-d2']);
  const onD2 = await pinOf('pin-d2');
  for (let k = 0; k < 3; k++)
    expect(Math.abs((onD2[k] ?? NaN) - (onD1[k] ?? NaN)), `pin axis ${String(k)}`).toBeLessThan(
      0.05,
    );
  expect(onD1[0]).toBeCloseTo(TANK.cx, 1);
  expect(onD1[2]).toBeCloseTo(TANK.cz, 1);
  await eye('d1').click();

  // two maps: both dates' orthos start at the same corner
  await win.keyboard.press('2');
  await toggleCompareDates(win);
  await expect(win.getByTestId('pane-map-compare')).toBeVisible();
  for (const side of [0, 1]) {
    await expect
      .poll(async () => (await quadCorner(win, side, 'ortho-d2')) !== null, { timeout: 60_000 })
      .toBe(true);
    const a = await quadCorner(win, side, 'ortho-d1');
    const b = await quadCorner(win, side, 'ortho-d2');
    if (!a || !b) throw new Error('no ortho quad on the map');
    expect(metresApart(a, b), `map ${String(side)}`).toBeLessThan(0.05);
  }

  // Swipe: leave the two maps, put the orthos side by side and drag the divider over them. The
  // tanks and buildings stand at the same columns whichever date shows (no 2 m step at an edge).
  await toggleCompareDates(win);
  await win.keyboard.press('3');
  await choosePane(win, 'left', 'raster', 'd1');
  await choosePane(win, 'right', 'raster', 'd2');
  await expect(win.getByTestId('pane-raster')).toHaveCount(2);
  await win.getByTestId('compare-view-swipe').click();
  const panes = win.locator('.stage-panes');
  await expect(panes).toHaveAttribute('data-compare-view', 'swipe');
  const divider = win.getByTestId('compare-divider');
  const stage = await panes.boundingBox();
  if (!stage) throw new Error('no stage');
  await dragDivider(win, stage.x + stage.width * 0.5);
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  // the divider stops 2% short of either end: the earlier date shows left of it, the later right
  await dragDivider(win, stage.x + stage.width + 40);
  await expect(divider).toHaveAttribute('aria-valuenow', '98');
  const band = await tankBand(win);
  // the earlier date's four strongest edges each stand at one of the later date's ten strongest:
  // the dates differ in places, so the weaker edges rank differently, but a 2 m step would move
  // every edge by about 8 px
  const earlier = await verticalEdges(win, band, 4);
  await dragDivider(win, stage.x - 40);
  await expect(divider).toHaveAttribute('aria-valuenow', '2');
  const later = await verticalEdges(win, band, 10);
  expect(earlier).toHaveLength(4);
  for (const column of earlier)
    expect(
      Math.min(...later.map((c) => Math.abs(c - column))),
      `an edge at column ${String(column)} of the earlier date`,
    ).toBeLessThanOrEqual(2);
});

test('undo puts the date back and keeps a pin drawn after the line-up on its feature', async ({
  misaligned,
  win,
}) => {
  test.setTimeout(360_000);
  // no issues but the one this makes, so that no pin clusters with it
  await writeFile(
    join(misaligned.root, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }),
  );
  await openMisaligned(win, misaligned.id);

  // line up from the background offer, keeping the earlier date
  await win.getByTestId('lineup-offer-go').click({ timeout: 180_000 });
  await win.getByTestId('lineup-keep-d1').click();
  const confirm = win.getByTestId('lineup-confirm');
  await expect(confirm).toBeEnabled({ timeout: 120_000 });
  await confirm.click();
  await expect(win.getByTestId('lineup-text')).toHaveText(/lined up with Survey 2 March 2026/);
  await expect.poll(() => lineUpOnDisk(misaligned.root, 'd2')).not.toBeNull();
  await expect.poll(() => nodeX(win, 'model-d2')).toBeCloseTo(0, 1);

  // a pin on the roof of the tank, as the date is drawn now (lined up, on the earlier date's tank)
  const known = new Set((await issuesOnDisk(misaligned.root)).map((i) => i.id));
  const canvas = win.locator('[data-scene-view] canvas').first();
  await canvas.click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('a');
  await win.locator('.ann-subbar').getByRole('button', { name: 'Pin' }).click();
  const at = await screenPoint(win, ROOF);
  await win.mouse.click(at.x, at.y);
  const pop = win.getByRole('dialog', { name: 'New issue' });
  await expect(pop).toBeVisible();
  await pop.getByRole('listbox', { name: 'Class' }).getByRole('button').first().click();
  await pop.getByRole('group', { name: 'Severity' }).getByRole('button').nth(1).click();
  await pop.getByRole('button', { name: 'Create issue' }).click();
  const pinOnDisk = async () =>
    (await issuesOnDisk(misaligned.root)).find((i) => !known.has(i.id)) ?? null;
  await expect.poll(pinOnDisk, { timeout: 30_000 }).not.toBeNull();
  const pin = await pinOnDisk();
  const sighting = pin?.sightings.find((x) => x.layer === 'model-d2');
  const stored = sighting?.geom?.p;
  if (!pin || !stored) throw new Error('the pin has no sighting on model-d2');
  // stored where the model has the tank, not where the line-up draws it: 2 m east of the roof
  expect(stored[0]).toBeCloseTo(ROOF[0] + 2, 0);
  await win.keyboard.press('Escape');

  // drawn on the tank roof of the earlier date, next to the model
  const drawn = async () => (await pinWorlds(win)).find((p) => p.id === pin.id)?.world ?? null;
  await expect.poll(drawn).not.toBeNull();
  const lined = await drawn();
  expect(lined?.[0]).toBeCloseTo(ROOF[0], 0);

  // Ctrl+Z on the scene: the date goes back, the pin goes with its model
  await win.locator('[data-scene-view] canvas').first().hover();
  await win.keyboard.press('Control+z');
  await expect(win.getByTestId('lineup-redo')).toBeVisible();
  await expect.poll(() => lineUpOf(win, 'd2')).toBeNull();
  expect(await lineUpOnDisk(misaligned.root, 'd2')).toBeNull();
  await expect.poll(() => nodeX(win, 'model-d2')).toBeCloseTo(2, 1);
  await expect
    .poll(async () => ((await drawn())?.[0] ?? NaN) - (lined?.[0] ?? NaN), { timeout: 15_000 })
    .toBeCloseTo(2, 1);
  const back = await drawn();
  expect(back?.[0]).toBeCloseTo(ROOF[0] + 2, 0);
  for (const k of [1, 2]) expect(back?.[k]).toBeCloseTo(lined?.[k] ?? NaN, 1);
});
