/**
 * Two processed surveys of one site, then change, then the heat map on the Globe (M10), on
 * synthetic data only: `python/tests/two_surveys_synth.py` writes one project with two aligned
 * photo runs of a fictional desert site, two weeks apart (`c1`: a stockpile 4 m high; `c2`: the
 * stockpile 6 m high and a new 3 m shed on open ground), and the `truth.json` of what changed.
 *
 * `photo.products` makes the cloud, DSM and ortho of each run (Standard preset, see PRESET),
 * started through the jobs:start channel as the Process photos wizard does. Then the Changes panel
 * offers and runs
 * imagery, surface and cloud change on those processed layers, each checked against the truth,
 * and the Globe lists the surface heat map in the site card, draws it when switched on (red over
 * the pile, which grew) and reaches no network. Needs the development pipeline Python
 * (QUADRION_E2E_PYTHON, or `uv sync` in python/) and PDAL; skipped without them.
 * ODM is the fake of `python/tests/fake_odm` (`odmEnv`): it writes ODM's outputs from the run's
 * synthetic surface, as LAS, so the cloud goes to COPC through untwine when AIO_UNTWINE names
 * it, else through PDAL.
 */
import { utmToWgs84 } from '@aio/geo';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expect,
  hasPdal,
  hasPipelinePython,
  hasUntwine,
  openProject,
  PDAL,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';
import { openBench } from './island';
import { ODM_FAKE_DIR, odmEnv } from './photoPack';

const FIXTURE = join(import.meta.dirname, 'photo-two-surveys-fixture.py');
/** The fixture's sampling step, metres (finer is slower to render and to process). */
const STEP = '0.05';
const FOLDER = 'synthetic-two-surveys';
const PROJECT_ID = 'synthetic-photo';
const SITE_NAME = 'Synthetic photo site';
/** UTM zone of the fixture's CRS (EPSG:32639). */
const ZONE = 39;
const PAIR = 'c1-c2';
/**
 * The products' preset. Not Fast: Fast skips ODM's dense matching (`--fast-orthophoto`), so its
 * cloud is the sparse points, and cloud change, which joins changed points on a 25 cm grid into
 * regions of at least 30 points, finds no region there (the shed and the pile included).
 * Standard runs ODM's dense matching (openmvs); the fake ODM makes its dense cloud from the
 * run's 20,000 true surface points.
 */
const PRESET = 'standard';
/** The cloud threshold the producer sends (`ChangeThresholds.cloud.significantM` default). */
const SIGNIFICANT_M = 0.05;
/**
 * Fill volume of the pile against the truth. 10 % leaves room for the DSM's grid without accepting
 * a pile measured on the wrong surface (a sparse DSM gave 80 m3 against 102.6 m3).
 */
const FILL_TOLERANCE = 0.1;

type XZ = [number, number];
interface Truth {
  shed: { outlineLocal: XZ[]; heightM: number };
  pile: {
    centreLocal: XZ;
    radiusM: number;
    heightFrom: number;
    heightTo: number;
    fillM3: number;
  };
  openGround: XZ[];
  captures: { id: string; date: string }[];
}
interface Fixture {
  runs: { c1: string; c2: string };
  origin: [number, number, number];
  truth: Truth;
}

interface JobLike {
  id: string;
  pipeline: string;
  status: string;
  error?: string;
}
interface Bridge {
  aio: { invoke(channel: string, request: unknown): Promise<unknown> };
}
interface LayerLike {
  id: string;
  kind: string;
  role?: string;
  format?: string;
  capture?: string;
  scalar?: { dim: string };
}
interface Win {
  __stratlas: {
    workspace: { getState(): { project: { manifest: { layers: LayerLike[] } } | null } };
  };
}
interface Region {
  kind: string;
  verdict: string;
  at?: number[];
  bounds?: { min: number[]; max: number[] };
  outlineLocal?: number[][];
  volume?: { cutM3: number; fillM3: number; netM3: number };
  distance?: { meanM: number; maxM: number };
}
interface ProjectRaster {
  projectId: string;
  layerId: string;
  ready: boolean;
  tiles: number;
  lastError: string | null;
}
interface ProductsReport {
  engines: { odm?: string };
  cloud: { points: number; writer?: string };
}

const twoSurveys = test.extend<{ surveys: Fixture & { root: string } }>({
  surveys: async ({ dataRoot }, use) => {
    const root = join(dataRoot.root, 'projects', FOLDER);
    const fx = JSON.parse(
      execFileSync(VENV_PYTHON, [FIXTURE, root, STEP], { encoding: 'utf8' }),
    ) as Fixture;
    await use({ ...fx, root });
  },
});

// the fake ODM as the processing engine: QUADRION_ODM_DIR for main, AIO_ODM for the job itself
twoSurveys.use({
  appEnv: { ...PIPELINE_ENV, ...odmEnv(), AIO_ODM: ODM_FAKE_DIR, AIO_ODM_VERSION: '3.6.2' },
});
twoSurveys.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
twoSurveys.skip(!hasPdal(), `no PDAL at ${PDAL} (set AIO_PDAL)`);

// ---------------------------------------------------------------- geometry of the local frame

/** Area of a polygon (x, z), square metres. */
function area(poly: readonly XZ[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i] ?? [0, 0];
    const [x1, z1] = poly[(i + 1) % poly.length] ?? [0, 0];
    s += x0 * z1 - x1 * z0;
  }
  return Math.abs(s) / 2;
}

/** The part of a polygon inside an axis-aligned box (Sutherland-Hodgman clipping). */
function clip(poly: readonly XZ[], b: { x0: number; x1: number; z0: number; z1: number }): XZ[] {
  const sides: ((p: XZ) => number)[] = [
    (p) => p[0] - b.x0,
    (p) => b.x1 - p[0],
    (p) => p[1] - b.z0,
    (p) => b.z1 - p[1],
  ];
  let out: XZ[] = [...poly];
  for (const side of sides) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i] ?? [0, 0];
      const q = input[(i + 1) % input.length] ?? [0, 0];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return out;
}

const boxOf = (outline: readonly XZ[]) => ({
  x0: Math.min(...outline.map((p) => p[0])),
  x1: Math.max(...outline.map((p) => p[0])),
  z0: Math.min(...outline.map((p) => p[1])),
  z1: Math.max(...outline.map((p) => p[1])),
});

/** A region's outline in x and z (its bounds as a rectangle when it has no outline). */
function outlineOf(r: Region): XZ[] {
  if (r.outlineLocal && r.outlineLocal.length >= 3)
    return r.outlineLocal.map((p): XZ => [p[0] ?? NaN, p[2] ?? NaN]);
  if (!r.bounds) return [];
  const { min, max } = r.bounds;
  const [x0, z0, x1, z1] = [min[0] ?? NaN, min[2] ?? NaN, max[0] ?? NaN, max[2] ?? NaN];
  return [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
}

/** Share of the outline's area that a region covers. */
const overlapShare = (r: Region, outline: readonly XZ[]) =>
  area(clip(outlineOf(r), boxOf(outline))) / area(outline);

/** Whether a point lies in a region's outline (even-odd rule). */
function contains(r: Region, [x, z]: XZ): boolean {
  const poly = outlineOf(r);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i] ?? [0, 0];
    const [xj, zj] = poly[j] ?? [0, 0];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Earth-centred coordinates of a WGS84 point, metres. */
function ecef(lon: number, lat: number, h: number): { x: number; y: number; z: number } {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const [l, p] = [(lon * Math.PI) / 180, (lat * Math.PI) / 180];
  const n = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return {
    x: (n + h) * Math.cos(p) * Math.cos(l),
    y: (n + h) * Math.cos(p) * Math.sin(l),
    z: (n * (1 - e2) + h) * Math.sin(p),
  };
}

/** A region in a line of the log: verdict, bounds (x and z), volume or distance. */
const brief = (r: Region) => ({
  v: r.verdict,
  x: [r.bounds?.min[0], r.bounds?.max[0]],
  z: [r.bounds?.min[2], r.bounds?.max[2]],
  fill: r.volume?.fillM3,
  max: r.distance?.maxM,
});

// ---------------------------------------------------------------- app helpers

const listJobs = async (win: Page) =>
  (
    (await win.evaluate(() => (window as unknown as Bridge).aio.invoke('jobs:list', {}))) as {
      jobs: JobLike[];
    }
  ).jobs;

/** Poll a job until it is done; a failed job fails the test with its error. */
async function waitJob(win: Page, find: (jobs: JobLike[]) => JobLike | undefined, what: string) {
  await expect
    .poll(
      async () => {
        const job = find(await listJobs(win));
        if (job?.status === 'failed') throw new Error(`${what} failed: ${job.error ?? ''}`);
        return job?.status;
      },
      { timeout: 360_000, intervals: [1000] },
    )
    .toBe('done');
}

const layersNow = (win: Page) =>
  win.evaluate(
    () => (window as unknown as Win).__stratlas.workspace.getState().project?.manifest.layers ?? [],
  );

/** The Changes tab's Run button of a producer, enabled with no sentence of what is missing. */
async function producerButton(win: Page, producer: string) {
  await openBench(win, 'changes');
  const button = win.getByTestId('change-panel').getByTestId(`change-producer-${producer}`);
  await expect(button).toBeEnabled({ timeout: 30_000 });
  const label = (await button.textContent()) ?? '';
  // an unavailable producer says what it needs in the title ("... needs a DSM ... on each date")
  await expect(button).toHaveAttribute('title', label);
  return button;
}

/** Run a producer from the Changes panel, wait for its job and its layers; its change set. */
async function runChange(
  win: Page,
  root: string,
  producer: string,
  pipeline: string,
  layers: string[],
): Promise<{ items: Region[]; stats: Record<string, number> }> {
  const before = new Set((await listJobs(win)).map((j) => j.id));
  await (await producerButton(win, producer)).click();
  await waitJob(
    win,
    (jobs) => jobs.find((j) => j.pipeline === pipeline && !before.has(j.id)),
    pipeline,
  );
  await expect
    .poll(async () => (await layersNow(win)).map((l) => l.id), { timeout: 60_000 })
    .toEqual(expect.arrayContaining(layers));
  return JSON.parse(await readFile(join(root, 'change', `${PAIR}-${producer}.json`), 'utf8')) as {
    items: Region[];
    stats: Record<string, number>;
  };
}

const globeCall = <T>(win: Page, fn: string, args: unknown[] = []) =>
  win.evaluate(
    ([name, a]) => {
      const el = document.querySelector('[data-testid="globe-canvas"]') as unknown as {
        __aioGlobe?: Record<string, (...x: unknown[]) => unknown>;
      } | null;
      const c = el?.__aioGlobe;
      const f = c?.[name];
      return f ? f.apply(c, a) : null;
    },
    [fn, args] as const,
  ) as Promise<T | null>;

const projectRasters = async (win: Page) =>
  (await globeCall<{ projectRasters: ProjectRaster[] }>(win, 'inspect'))?.projectRasters ?? [];

// ---------------------------------------------------------------- the chain

twoSurveys(
  'two processed surveys run imagery, surface and cloud change and show on the Globe',
  async ({ surveys, win, network }) => {
    twoSurveys.setTimeout(900_000);
    const { truth, runs, root } = surveys;
    const t0 = Date.now();
    const lap = (what: string) => {
      console.warn(`[photo-change] ${what} at ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    };
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));

    // 1. the cloud, DSM and ortho of each survey, as the wizard starts them
    for (const capture of ['c1', 'c2'] as const) {
      const run = runs[capture];
      const started = (await win.evaluate(
        ([project, id, cap, preset]) =>
          (window as unknown as Bridge).aio.invoke('jobs:start', {
            pipeline: 'photo.products',
            project,
            params: { run: id, products: ['cloud', 'dsm', 'ortho'], preset, capture: cap },
          }),
        [root, run, capture, PRESET] as const,
      )) as { ok: boolean; job?: JobLike; error?: string };
      expect(started.error ?? '').toBe('');
      const id = started.job?.id ?? '';
      await waitJob(win, (jobs) => jobs.find((j) => j.id === id), `photo.products ${capture}`);
    }

    lap('products of both surveys');
    // 2. the project opens with an ortho, a DSM and a COPC cloud of each date
    await win.getByTestId('project-card').filter({ hasText: SITE_NAME }).first().click();
    await expect
      .poll(async () => (await openProject(win)).id, { timeout: 60_000 })
      .toBe(PROJECT_ID);
    const layers = await layersNow(win);
    for (const capture of ['c1', 'c2']) {
      const mine = layers.filter((l) => l.capture === capture);
      expect(
        mine.some((l) => l.kind === 'raster' && l.role === 'ortho'),
        `ortho ${capture}`,
      ).toBe(true);
      expect(
        mine.some((l) => l.kind === 'raster' && l.role === 'dsm'),
        `DSM ${capture}`,
      ).toBe(true);
      expect(
        mine.some((l) => l.kind === 'pointcloud' && l.format === 'copc'),
        `cloud ${capture}`,
      ).toBe(true);
    }

    // 2b. ODM made the products, and the COPC went through untwine when this computer has it,
    // else through PDAL (the fake ODM writes LAS, not COPC); no DTM layer, none was asked for
    for (const capture of ['c1', 'c2'] as const) {
      const report = JSON.parse(
        await readFile(
          join(root, 'photogrammetry', runs[capture], 'report', 'products.json'),
          'utf8',
        ),
      ) as ProductsReport;
      expect(report.engines.odm, `ODM version ${capture}`).toBe('3.6.2');
      expect(report.cloud.writer, `COPC writer ${capture}`).toBe(hasUntwine() ? 'untwine' : 'pdal');
      expect(report.cloud.points, `cloud points ${capture}`).toBeGreaterThan(0);
      expect(
        layers.some((l) => l.capture === capture && l.id.endsWith('-dtm')),
        `no DTM layer ${capture}`,
      ).toBe(false);
    }

    // 3. Changes for c1 to c2 offers all three runs
    for (const producer of ['raster', 'surface', 'cloud']) await producerButton(win, producer);

    const shed = truth.shed.outlineLocal;
    const pile = truth.pile.centreLocal;

    // 4. imagery change: a region over the shed, none on open ground
    const raster = await runChange(win, root, 'raster', 'change.raster', [
      `${PAIR}-raster-heat`,
      `${PAIR}-raster-regions`,
    ]);
    const rasterRegions = raster.items.filter((i) => i.kind === 'region');
    console.warn(`[photo-change] imagery regions ${JSON.stringify(rasterRegions.map(brief))}`);
    const shedCover = Math.max(0, ...rasterRegions.map((r) => overlapShare(r, shed)));
    expect(shedCover, 'share of the shed an imagery region covers').toBeGreaterThanOrEqual(0.5);
    for (const p of truth.openGround)
      expect(
        rasterRegions.some((r) => contains(r, p)),
        `imagery region at ${p.join(', ')}`,
      ).toBe(false);

    lap('imagery change');
    // 5. surface change: a fill region at the pile with its volume, and one over the shed
    const surface = await runChange(win, root, 'surface', 'change.surface', [
      `${PAIR}-surface-heat`,
      `${PAIR}-surface-regions`,
    ]);
    console.warn(`[photo-change] surface regions ${JSON.stringify(surface.items.map(brief))}`);
    const fills = surface.items.filter((i) => i.kind === 'region' && i.verdict === 'fill');
    const atPile = fills.find((r) => contains(r, pile));
    expect(atPile, 'a fill region at the pile').toBeDefined();
    const fill = atPile?.volume?.fillM3 ?? 0;
    expect(
      Math.abs(fill - truth.pile.fillM3) / truth.pile.fillM3,
      `pile fill ${fill.toFixed(1)} m3 against ${truth.pile.fillM3.toFixed(1)} m3`,
    ).toBeLessThan(FILL_TOLERANCE);
    expect(
      Math.max(0, ...fills.map((r) => overlapShare(r, shed))),
      'share of the shed a fill region covers',
    ).toBeGreaterThanOrEqual(0.5);

    lap('surface change');
    // 6. cloud change: the change cloud with its distances, the shed and the pile above the
    // threshold, nothing on open ground
    const cloud = await runChange(win, root, 'cloud', 'change.cloud', [`${PAIR}-cloud`]);
    const changeCloud = (await layersNow(win)).find((l) => l.id === `${PAIR}-cloud`);
    expect(changeCloud?.scalar?.dim).toBe('Distance');
    const cloudRegions = cloud.items.filter((i) => i.kind === 'region');
    console.warn(`[photo-change] cloud regions ${JSON.stringify(cloudRegions.map(brief))}`);
    const above = (r: Region) => (r.distance?.maxM ?? 0) > SIGNIFICANT_M;
    expect(
      cloudRegions.some((r) => above(r) && overlapShare(r, shed) > 0.25),
      'a cloud region over the shed',
    ).toBe(true);
    // the fake ODM's dense cloud is the run's 20,000 true surface points, about 3 a square metre:
    // the pile's change falls apart into several regions on the 25 cm grid, none of them sure to
    // hold its very centre. They lie on the pile, and the largest distance is near its 2 m rise.
    const onPile = cloudRegions.filter((r) => {
      if (!above(r) || !r.bounds) return false;
      const cx = ((r.bounds.min[0] ?? NaN) + (r.bounds.max[0] ?? NaN)) / 2 - pile[0];
      const cz = ((r.bounds.min[2] ?? NaN) + (r.bounds.max[2] ?? NaN)) / 2 - pile[1];
      return Math.hypot(cx, cz) < truth.pile.radiusM;
    });
    expect(onPile.length, 'cloud regions on the pile').toBeGreaterThan(0);
    expect(
      Math.max(...onPile.map((r) => r.distance?.maxM ?? 0)),
      'largest cloud distance on the pile',
    ).toBeGreaterThan(1);
    for (const p of truth.openGround)
      expect(
        cloudRegions.some((r) => contains(r, p)),
        `cloud region at ${p.join(', ')}`,
      ).toBe(false);

    lap('cloud change');
    // 7. the Globe: the site card lists the surface heat map; on, it is drawn red over the pile
    await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
    await expect(win.getByTestId('globe-canvas').locator('canvas')).toBeVisible();
    await expect
      .poll(
        async () =>
          // the library's two projects (the tiny one and this one); site ids are the library's
          (await globeCall<{ sites: string[] }>(win, 'inspect'))?.sites.length ?? 0,
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(2);
    await win.getByRole('combobox', { name: 'Find a site' }).click();
    const list = win.getByTestId('globe-sites');
    await list.getByRole('option', { name: new RegExp(SITE_NAME) }).click();
    const card = win.getByTestId('globe-card');
    await expect(card).toContainText(SITE_NAME);
    await expect
      .poll(
        async () => {
          const s = await globeCall<{ flying: boolean; cameraHeight: number }>(win, 'inspect');
          return s !== null && !s.flying && s.cameraHeight < 5000;
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    // look straight down on the pile from 120 m: it fills the middle of the Globe
    const [lon, lat] = utmToWgs84(surveys.origin[0] + pile[0], surveys.origin[1] - pile[1], ZONE);
    await win.evaluate(
      (destination) => {
        const el = document.querySelector('[data-testid="globe-canvas"]') as unknown as {
          __aioGlobe: {
            widget: {
              scene: {
                requestRender(): void;
                camera: {
                  setView(v: {
                    destination: { x: number; y: number; z: number };
                    orientation: { heading: number; pitch: number; roll: number };
                  }): void;
                };
              };
            };
          };
        };
        const scene = el.__aioGlobe.widget.scene;
        scene.camera.setView({
          destination,
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        scene.requestRender();
      },
      ecef(lon, lat, 120),
    );

    const heat = `${PAIR}-surface-heat`;
    const sw = card.getByRole('switch', { name: 'Surface change' });
    await expect(sw).toBeVisible({ timeout: 30_000 });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    // the ortho of the later date alone first
    const sample = () => globeCall<number[]>(win, 'samplePixel', [0.5, 0.5]);
    const bare = (await sample()) ?? [0, 0, 0, 0];
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    let last: ProjectRaster[] = [];
    await expect
      .poll(
        async () => {
          last = await projectRasters(win);
          return last.find((r) => r.layerId === heat)?.ready ?? false;
        },
        { timeout: 60_000 },
      )
      .toBe(true)
      .catch((e: unknown) => {
        throw new Error(`the heat map was not drawn: ${JSON.stringify(last)}`, { cause: e });
      });
    // red (fill, the pile grew 2 m) over whatever the ortho was there
    const redness = (px: number[]) => (px[0] ?? 0) - Math.max(px[1] ?? 0, px[2] ?? 0);
    let drawn: number[] = [];
    await expect
      .poll(
        async () => {
          drawn = (await sample()) ?? [];
          return redness(drawn);
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(Math.max(60, redness(bare) + 30))
      .catch((e: unknown) => {
        throw new Error(`pixel at the pile ${drawn.join(', ')}, ortho alone ${bare.join(', ')}`, {
          cause: e,
        });
      });

    lap('the heat map on the Globe');
    expect(await network.outbound()).toEqual([]);
    expect(errors).toEqual([]);
  },
);
