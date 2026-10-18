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
import { openBench, toggleCompareDates } from './island';
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

/** How `turned` misplaces `d2`: 2 m east, turned 0.3° and scaled +0.4% about the site centre. */
const TURN = { eastM: 2, northM: 0, turnDeg: 0.3, scale: 1.004 };
/** Where `TURN` puts a point of the site (local x, z; the similarity of `createMisalignedDemo`). */
function turnedAt([x, y, z]: XYZ): XYZ {
  const r = (TURN.turnDeg * Math.PI) / 180;
  const [a, b] = [TURN.scale * Math.cos(r), TURN.scale * Math.sin(r)];
  return [a * x + b * z + TURN.eastM, y, -b * x + a * z - TURN.northM];
}
/**
 * The roof of the control building B-01 (base centre -28, 24, 12 x 8 m, 4.5 m high), 1 m in from
 * its south-west corner: of the parts of the site both dates show alike, it is the one furthest
 * from the centre, where the turn and the scale move the later date most (about 0.3 m besides
 * the shift).
 */
const CORNER: XYZ = [-33, 4.5, 27];

interface Fixtures {
  /** The change demo with `d2` 2 m east of where it belongs, written before the app starts. */
  misaligned: Misaligned;
  /**
   * The change demo with `d2` 2 m east, turned and scaled (`TURN`), and a pin on the building
   * corner (`CORNER`) of `d2`, stored where `d2`'s own model has it.
   */
  turned: Misaligned;
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
  turned: async ({ dataRoot }, use, testInfo) => {
    testInfo.skip(
      !hasChangeDemo(),
      'no change demo: run pnpm demo:build --quick (or pnpm demo:change --quick)',
    );
    testInfo.skip(
      !hasPipelinePython(),
      `no pipeline Python at ${VENV_PYTHON} (uv sync in python/)`,
    );
    const demo = await createMisalignedDemo(dataRoot, TURN);
    await writeFile(
      join(demo.root, 'issues.json'),
      JSON.stringify(
        {
          schema: 'aio.issues/1',
          issues: [issue('pin-corner', 'P01', 'd2', 'model-d2', turnedAt(CORNER))],
        },
        null,
        2,
      ),
    );
    await use(demo);
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

type LonLat = [number, number];

/**
 * One map of the comparison: the four corners (lon, lat: top left, top right, bottom right,
 * bottom left) of both dates' whole orthos, and where it draws each issue pin (lon, lat).
 */
const mapLook = (win: Page, side: number) =>
  inspect(
    win,
    async ({ w, a }) => {
      interface Src {
        coordinates?: LonLat[];
        getData?(): Promise<{
          features?: { properties?: { issueId?: string }; geometry?: { coordinates?: LonLat } }[];
        }>;
      }
      const compare = (
        w.__stratlas as unknown as {
          compare(): { maps: ({ map: { getSource(id: string): Src | undefined } } | null)[] };
        }
      ).compare();
      const map = compare.maps[a]?.map;
      if (!map) return null;
      // the layer's images, a square of tiles row by row (maps controller): the whole quad is the
      // top left of the first, the top right of the last of the first row, and so on
      const quad = (layer: string): LonLat[] | null => {
        const tiles: LonLat[][] = [];
        for (let i = 0; ; i++) {
          const c = map.getSource(`aio-raster-${layer}-${String(i)}`)?.coordinates;
          if (!c) break;
          tiles.push(c);
        }
        const n = Math.round(Math.sqrt(tiles.length));
        if (!n || n * n !== tiles.length) return null;
        const corner = (tile: number, k: number) => {
          const c = tiles[tile]?.[k];
          return c ? ([c[0], c[1]] as LonLat) : null;
        };
        const out = [corner(0, 0), corner(n - 1, 1), corner(n * n - 1, 2), corner(n * n - n, 3)];
        return out.every((c) => c) ? (out as LonLat[]) : null;
      };
      const pins: Record<string, LonLat> = {};
      for (const id of ['aio-issues', 'aio-issues-far']) {
        const data = await map.getSource(id)?.getData?.();
        for (const f of data?.features ?? []) {
          const c = f.geometry?.coordinates;
          const issueId = f.properties?.issueId;
          if (issueId && c) pins[issueId] = [c[0], c[1]];
        }
      }
      return { d1: quad('ortho-d1'), d2: quad('ortho-d2'), pins };
    },
    side,
  );

/** The (lon, lat) of local point x, z (m) of the 96 m square whose corners `quad` gives. */
function onQuad(quad: LonLat[], x: number, z: number): LonLat {
  const [tl, tr, , bl] = quad;
  if (!tl || !tr || !bl) throw new Error('not a quad');
  const [u, v] = [(x + 48) / 96, (z + 48) / 96];
  return [
    tl[0] + u * (tr[0] - tl[0]) + v * (bl[0] - tl[0]),
    tl[1] + u * (tr[1] - tl[1]) + v * (bl[1] - tl[1]),
  ];
}

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
  return orthoBand(win, [-32, 14], [-24, -16]);
}

/** The strip of the earlier ortho's picture from local x `xs` and z `zs` (m), in page pixels. */
async function orthoBand(
  win: Page,
  xs: [number, number],
  zs: [number, number],
): Promise<{ x: number; y: number; width: number; height: number }> {
  // the first picture is the whole ortho (its coarsest level); the finer tiles come after it
  const img = await win
    .locator('.pane-raster[data-side="left"] .raster-plane img')
    .first()
    .boundingBox();
  if (!img) throw new Error('no ortho picture');
  const at = (m: number) => (m + 48) / 96;
  return {
    x: img.x + img.width * at(xs[0]),
    y: img.y + img.height * at(zs[0]),
    width: img.width * (at(xs[1]) - at(xs[0])),
    height: img.height * (at(zs[1]) - at(zs[0])),
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
  return strongest(await edgeStrength(win, band, 'columns'), count);
}

/** The `count` strongest places of an edge profile, a few pixels apart. */
function strongest(strength: number[], count: number): number[] {
  const out: number[] = [];
  const order = strength.map((v, x) => [v, x] as const).sort((a, b) => b[0] - a[0]);
  for (const [v, x] of order) {
    if (v <= 0 || out.length >= count) break;
    if (out.every((c) => Math.abs(c - x) > 6)) out.push(x);
  }
  return out;
}

/**
 * How strong an edge each column (or row) of `band` is: the change of brightness from the one
 * before it to the one after it, summed down (or across) the strip. In pixels of the screenshot
 * (device pixels).
 */
async function edgeStrength(
  win: Page,
  band: { x: number; y: number; width: number; height: number },
  axis: 'columns' | 'rows',
): Promise<number[]> {
  const png = (await win.screenshot({ clip: band })).toString('base64');
  return win.evaluate(
    async ({ data, rows }) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return [];
      ctx.drawImage(bmp, 0, 0);
      const { data: px, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      // `along` runs across the edges (columns, or rows), `down` along them
      const [along, down] = rows ? [height, width] : [width, height];
      const grey = (a: number, d: number) => {
        const i = (rows ? a * width + d : d * width + a) * 4;
        return 0.3 * (px[i] ?? 0) + 0.59 * (px[i + 1] ?? 0) + 0.11 * (px[i + 2] ?? 0);
      };
      const strength: number[] = [];
      for (let x = 0; x < along; x++) {
        let sum = 0;
        if (x >= 1 && x < along - 1)
          for (let d = 0; d < down; d++) sum += Math.abs(grey(x + 1, d) - grey(x - 1, d));
        strength.push(sum);
      }
      return strength;
    },
    { data: png, rows: axis === 'rows' },
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
  await openBench(win, 'changes');
  const run = win.getByTestId('change-panel').getByTestId('change-producer-raster');
  await expect(run).toBeEnabled();
  await run.click();
  const refused = win.getByTestId('chg-misaligned');
  // the imagery change's own registration (the median over fine tiles spread across the
  // overlap) reads the 2 m shift as 1.99 m
  await expect(refused).toHaveText(/These dates are (?:1\.99|2\.0\d) m apart\./, {
    timeout: 120_000,
  });

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
  // the annotation tools are the Annotate workbench's, which A brings to the front
  await win
    .getByRole('group', { name: 'Annotation tools' })
    .getByRole('button', { name: 'Pin' })
    .click();
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

test.describe('at the window size CI uses', () => {
  test.use({ appEnv: { ...PIPELINE_ENV, QUADRION_WINDOW_SIZE: '1100x720' } });

  test('turned dates line up from Compare', async ({ turned, win }, testInfo) => {
    test.setTimeout(720_000);
    const shot = async (name: string) => {
      const path = testInfo.outputPath(name);
      await win.screenshot({ path });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    };
    await openMisaligned(win, turned.id);
    // about 1100 x 720 (the size asked for is the window's, give or take its frame)
    const size = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(Math.abs(size.width - 1100)).toBeLessThanOrEqual(20);
    expect(Math.abs(size.height - 720)).toBeLessThanOrEqual(20);

    // 1. two maps, Compare dates: the chip measures the pair and finds it off
    await win.keyboard.press('2');
    await toggleCompareDates(win);
    await expect(win.getByTestId('pane-map-compare')).toBeVisible();
    const chip = win.getByTestId('compare-lineup');
    await expect(chip).toHaveAttribute('data-status', 'off', { timeout: 240_000 });
    const label = win.getByTestId('compare-lineup-label');
    await expect(label).toHaveText(/^\d+\.\d\d m off$/);
    // the largest move over the overlap: the 2 m shift and up to about 0.35 m of turn and scale
    const off = Number(/^(\d+\.\d\d)/.exec((await label.textContent()) ?? '')?.[1]);
    expect(off).toBeGreaterThanOrEqual(2);
    expect(off).toBeLessThanOrEqual(2.6);
    await shot('chip-off.png');

    // 2. Line up: the earlier (left) date is already kept; the fit turns and scales
    await win.getByTestId('compare-lineup-action').click();
    const dialog = win.getByTestId('lineup-dialog');
    await expect(dialog).toBeVisible();
    await expect(win.getByTestId('lineup-keep-d1')).toHaveAttribute('aria-checked', 'true');
    await win.getByTestId('lineup-keep-d1').click();
    await expect(win.getByTestId('lineup-keep-d1')).toHaveAttribute('aria-checked', 'true');
    await expect(win.getByTestId('lineup-turn')).toHaveText(
      /^turned -0\.(29|30|31)°, scaled -0\.(39|40|41)%$/,
      { timeout: 180_000 },
    );
    await expect(win.getByTestId('lineup-confidence')).toHaveText(/^Confident/);
    const confirm = win.getByTestId('lineup-confirm');
    await expect(confirm).toBeEnabled();
    await shot('dialog.png');
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    // the background offer for this pair goes with the line-up
    await expect(win.getByTestId('lineup-offer')).toHaveCount(0);

    // saved on the later date: a shift with a turn beside it, nothing on the earlier date
    const disk = async () => {
      const m = JSON.parse(await readFile(join(turned.root, 'manifest.json'), 'utf8')) as {
        captures: {
          id: string;
          lineUp?: { with: string };
          lineUpTurn?: { rotationDeg: number; scale: number };
        }[];
      };
      return m.captures.find((c) => c.id === 'd2') ?? null;
    };
    await expect.poll(async () => (await disk())?.lineUp?.with ?? null).toBe('d1');
    const d2 = await disk();
    expect(d2?.lineUpTurn?.rotationDeg).toBeCloseTo(-TURN.turnDeg, 1);
    expect(Math.abs((d2?.lineUpTurn?.scale ?? 0) - 1 / TURN.scale)).toBeLessThan(0.0005);
    expect(await lineUpOnDisk(turned.root, 'd1')).toBeNull();

    // 3. the chip measures the pair again and finds it lined up
    await expect(chip).toHaveAttribute('data-status', 'lined', { timeout: 240_000 });
    await expect(label).toHaveText('Lined up');
    await shot('chip-lined.png');

    // 4. on both maps the later ortho covers the earlier one corner for corner; the pin of the
    // later date (on its map, the right one) stands on the building corner both orthos show
    const looks: { d1: LonLat[] | null; d2: LonLat[] | null }[] = [];
    for (const side of [0, 1]) {
      await expect
        .poll(async () => (await mapLook(win, side))?.d2 ?? null, { timeout: 60_000 })
        .not.toBeNull();
      const look = await mapLook(win, side);
      if (!look?.d1 || !look.d2) throw new Error(`no ortho quads on map ${String(side)}`);
      for (let k = 0; k < 4; k++) {
        const [a, b] = [look.d1[k], look.d2[k]];
        if (!a || !b) throw new Error('a quad without four corners');
        expect(metresApart(a, b), `map ${String(side)} corner ${String(k)}`).toBeLessThan(0.1);
      }
      looks.push(look);
    }
    await expect
      .poll(async () => (await mapLook(win, 1))?.pins['pin-corner'] ?? null, { timeout: 60_000 })
      .not.toBeNull();
    const pin = (await mapLook(win, 1))?.pins['pin-corner'];
    if (!pin) throw new Error('no pin');
    for (const [side, look] of looks.entries())
      for (const quad of [look.d1, look.d2]) {
        if (!quad) continue;
        const feature = onQuad(quad, CORNER[0], CORNER[2]);
        expect(metresApart(pin, feature), `pin on map ${String(side)}`).toBeLessThan(0.1);
      }

    // 5. Swipe, zoomed in on the building: its north and south edges stand at the same rows
    // whichever date shows. A line-up that only shifted would leave the turn and the scale there.
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
    await dragDivider(win, stage.x + stage.width + 40);
    await expect(divider).toHaveAttribute('aria-valuenow', '98');
    // the drone video of the later date floats over the stage's lower left at this size: hide it
    // through the state its own Hide button sets
    await win.evaluate(() => {
      (
        window as unknown as {
          __stratlas: { shell: { getState(): { setVideoHidden(h: boolean): void } } };
        }
      ).__stratlas.shell
        .getState()
        .setVideoHidden(true);
    });
    await expect(win.getByTestId('video-window')).toHaveCount(0);
    // zoom in at the building (the two panes follow each other) to 24 px a metre or more
    const picture = win.locator('.pane-raster[data-side="left"] .raster-plane img').first();
    for (let k = 0; k < 40; k++) {
      const box = await picture.boundingBox();
      if (!box) throw new Error('no ortho picture');
      if (box.width / 96 >= 24) break;
      const at = await orthoBand(win, [-28, -28], [24, 24]);
      await win.mouse.move(at.x, at.y);
      await win.mouse.wheel(0, -100);
      await win.waitForTimeout(50);
    }
    // and bring the building to the middle of the views (a drag pans both)
    const view = await win.locator('.pane-raster[data-side="left"]').boundingBox();
    // (the ortho draws the roof north of the footprint, and the pane's own controls cover the
    // top of the view: aim at the building's north edge)
    const at = await orthoBand(win, [-28, -28], [20, 20]);
    if (!view) throw new Error('no ortho pane');
    await win.mouse.move(at.x, at.y);
    await win.mouse.down();
    await win.mouse.move(view.x + view.width / 2, view.y + view.height / 2, { steps: 8 });
    await win.mouse.up();
    const box = await picture.boundingBox();
    if (!box) throw new Error('no ortho picture');
    const perM = box.width / 96;
    expect(perM).toBeGreaterThanOrEqual(24);
    // what a shift-only line-up would leave on the building's south edge (x -28, z 28), north to
    // south: the turn and the scale about the site centre, about 0.26 m, here 6 px or more
    const r = (TURN.turnDeg * Math.PI) / 180;
    const residual = TURN.scale * Math.sin(r) * 28 + (TURN.scale * Math.cos(r) - 1) * 28;
    expect(residual * perM).toBeGreaterThanOrEqual(4);
    // a strip down the middle of the building, across its roof's long edges, from under the
    // pane's controls to the bottom of the views
    const across = await orthoBand(win, [-30, -26], [20, 20]);
    const band = { ...across, y: view.y + view.height * 0.22, height: view.height * 0.76 };
    // nothing covers the strip: the probe reads the orthos
    const seen = await win.evaluate(
      (b) =>
        [0.05, 0.5, 0.95].map(
          (f) =>
            document
              .elementFromPoint(b.x + b.width / 2, b.y + b.height * f)
              ?.closest('.pane-raster') != null,
        ),
      band,
    );
    expect(seen).toEqual([true, true, true]);
    const loaded = () =>
      win.evaluate(() =>
        [...document.querySelectorAll<HTMLImageElement>('.pane-raster img')].every(
          (i) => i.complete,
        ),
      );
    await expect.poll(loaded).toBe(true);
    const dpr = await win.evaluate(() => devicePixelRatio);
    // the earlier date's two strongest edges across the roof
    const earlier = strongest(await edgeStrength(win, band, 'rows'), 2);
    await shot('swipe-earlier.png');
    await dragDivider(win, stage.x - 40);
    await expect(divider).toHaveAttribute('aria-valuenow', '2');
    await expect.poll(loaded).toBe(true);
    const later = await edgeStrength(win, band, 'rows');
    await shot('swipe-later.png');
    // Each stands at the strongest row of the later date within `reach` of it, and that within a
    // page pixel. The reach stays short of what a shift-only line-up would leave there, so such a
    // line-up would put the strongest row at the reach's end, not on the edge. (The dates differ
    // further out: the later one has the building's shadow on its north side.)
    const reach = Math.floor(residual * perM * dpr) - 2;
    expect(earlier).toHaveLength(2);
    expect(Math.abs((earlier[1] ?? 0) - (earlier[0] ?? 0)) / dpr / perM).toBeGreaterThan(4);
    for (const row of earlier) {
      let best = row;
      for (let k = row - reach; k <= row + reach; k++)
        if ((later[k] ?? -1) > (later[best] ?? -1)) best = k;
      expect(Math.abs(best - row) / dpr, `the edge at row ${String(row)}`).toBeLessThanOrEqual(1);
    }

    // 6. the imagery change runs, with no misaligned notice
    const truth = changeDemoTruth();
    const { from, to } = truth.captures;
    await openBench(win, 'changes');
    const run = win.getByTestId('change-panel').getByTestId('change-producer-raster');
    await expect(run).toBeEnabled();
    await run.click();
    await expect(win.getByTestId('chg-misaligned')).toHaveCount(0);
    const file = join(turned.root, 'change', `${from}-${to}-raster.json`);
    await expect
      .poll(() => readFile(file, 'utf8').catch(() => null), {
        timeout: 360_000,
        intervals: [1000],
      })
      .not.toBeNull();
    const raster = JSON.parse(await readFile(file, 'utf8')) as {
      items: Item[];
      registration: { ok: boolean; shiftM: number };
    };
    expect(raster.registration.ok).toBe(true);
    expect(raster.registration.shiftM).toBeLessThan(0.2);
    expectRegionsMatchTruth(raster.items, truth.changes.raster as unknown as RasterTruth);
    await expect(win.getByTestId('chg-misaligned')).toHaveCount(0);
  });
});
