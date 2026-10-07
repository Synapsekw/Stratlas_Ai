/**
 * The Globe (M10 G6): CesiumJS offline under the app CSP, every library project as a site,
 * imagery and terrain from synthetic packs with their credits, the hand-off to the site view and
 * back, issue pins, and the WebGL context given back when the Globe closes. Synthetic data only;
 * the zero-network guard of the fixtures runs on every test.
 */
import { utmToWgs84 } from '@aio/geo';
import { enuToEcefMatrix } from '@aio/globe';
import type { GlobeInspection } from '@aio/globe/view';
import { pmtilesOf, solidPng, syntheticPackMeta, terrariumPng } from '@aio/globe/testing';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CSP, metaPolicy } from '../src/main/csp';
import { expectAccessible } from './a11y';
import { expect, test, tinyGlb, type DataRoot } from './fixtures';

/** The app's CSP as the build writes it into the page's `<meta>` (src/main/csp.ts). */
const appCsp = (): string => metaPolicy(APP_CSP);

/** What the Globe shows (`GlobeController.inspect()` through the hook on its element). */
const inspect = (win: Page) =>
  win.evaluate(() => {
    const el = document.querySelector('[data-testid="globe-canvas"]');
    const c = (el as { __aioGlobe?: { inspect(): unknown } } | null)?.__aioGlobe;
    return (c?.inspect() ?? null) as GlobeInspection | null;
  });

const memMiB = (app: ElectronApplication) =>
  app.evaluate(({ app: a }) =>
    Math.round(a.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024),
  );

// ---------------------------------------------------------------- synthetic library and packs

/** Site A sits over the synthetic packs; site B elsewhere in the Gulf (UTM 39N, fictional). */
const SITE_A = { id: 'globe-a', name: 'Globe site A', origin: [745_000, 3_245_000, 12] as const };
const SITE_B = { id: 'globe-b', name: 'Globe site B', origin: [300_000, 2_800_000, 5] as const };
const [A_LON, A_LAT] = utmToWgs84(SITE_A.origin[0], SITE_A.origin[1], 39);
/** About 15 km around site A. */
const PACK_BBOX = [A_LON - 0.15, A_LAT - 0.15, A_LON + 0.15, A_LAT + 0.15] as const;
const BENCHMARK_M = 123.45;
const MAGENTA = [255, 0, 200, 255] as const;

async function writeGlobeProject(
  dataRoot: DataRoot,
  site: { id: string; name: string; origin: readonly [number, number, number] },
  issues: unknown[],
): Promise<void> {
  const dir = join(dataRoot.root, 'projects', site.id);
  await mkdir(dir, { recursive: true });
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: site.id,
    name: site.name,
    crs: { epsg: 32639 },
    origin: [...site.origin],
    captures: [{ id: 'c1', label: 'Survey 1 June 2026', date: '2026-06-01' }],
    layers: [],
    severityModels: [
      {
        id: 'sev',
        name: 'Severity',
        levels: [
          { value: 1, label: 'Minor', color: '#2f9e44', criteria: 'Minor' },
          { value: 3, label: 'Major', color: '#e03131', criteria: 'Major' },
        ],
      },
    ],
    classCatalogues: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(input)));
  await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues }));
}

const majorIssue = {
  id: 'globe-i1',
  code: 'F01',
  classId: 'damage',
  severityModelId: 'sev',
  severity: 3,
  status: 'reviewed',
  title: 'Corrosion on the tank',
  note: '',
  author: 'E2E',
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
  sightings: [
    { on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [250, 2, -200], n: [0, 1, 0] } },
  ],
  source: 'human',
};

test.beforeEach(async ({ dataRoot }) => {
  await writeGlobeProject(dataRoot, SITE_A, [majorIssue]);
  await writeGlobeProject(dataRoot, SITE_B, []);
});

/**
 * Install synthetic imagery and terrain packs in the data folder (`packs/{imagery,terrain}/`,
 * `aio.raster-pack/1` beside the archive), as **Import imagery** or a pack download leaves them:
 * the Globe lists them with `globe:packs` and reads them over `aio://packs/<kind>/<id>.pmtiles`.
 */
async function installSyntheticPacks(dataRoot: DataRoot): Promise<void> {
  const packs = [
    {
      meta: syntheticPackMeta('syn-imagery', 'imagery', PACK_BBOX, 0, 14),
      bytes: pmtilesOf({
        bbox: PACK_BBOX,
        minZoom: 0,
        maxZoom: 14,
        tile: solidPng(256, MAGENTA),
        tileType: 'png',
      }),
    },
    {
      meta: syntheticPackMeta('syn-terrain', 'terrain', PACK_BBOX, 0, 12),
      bytes: pmtilesOf({
        bbox: PACK_BBOX,
        minZoom: 0,
        maxZoom: 12,
        tile: terrariumPng(256, BENCHMARK_M),
        tileType: 'png',
      }),
    },
  ];
  for (const { meta, bytes } of packs) {
    const dir = join(dataRoot.root, 'packs', meta.kind);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${meta.id}.json`), JSON.stringify(meta));
    await writeFile(join(dir, `${meta.id}.pmtiles`), bytes);
  }
}

async function openGlobe(win: Page) {
  await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
  await expect(win.getByTestId('globe-canvas').locator('canvas')).toBeVisible();
  await expect.poll(async () => (await inspect(win))?.sites.length ?? 0).toBeGreaterThan(0);
}

/** Pick a site in the list and wait for the flight to end over it. */
async function flyToSite(win: Page, name: string) {
  await win
    .getByTestId('globe-sites')
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await expect(win.getByTestId('globe-card')).toContainText(name);
  await expect
    .poll(
      async () => {
        const s = await inspect(win);
        return s !== null && !s.flying && s.cameraHeight < 5000;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

// ---------------------------------------------------------------- tests

test('spike: the Globe renders offline under the app CSP', async ({ app, win, network }) => {
  const problems: string[] = [];
  win.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(text))
      problems.push(text);
  });
  win.on('pageerror', (e) => problems.push(String(e)));
  await expect(win.locator('.sb-nav .nav-item', { hasText: 'Globe' })).toBeVisible();
  // The built page carries the app policy as a <meta> (the window loads from file://, where
  // main's response-header CSP does not reach), so the Globe runs under it; eval refused there is
  // csp.spec's. Every violation while the Globe starts is a problem.
  const meta = await win.evaluate(() => {
    const w = window as unknown as {
      __workers: string[];
      __violations: string[];
      Worker: typeof Worker;
    };
    w.__workers = [];
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
    const W = w.Worker;
    w.Worker = class extends W {
      constructor(u: string | URL, o?: WorkerOptions) {
        super(u, o);
        w.__workers.push(String(u));
      }
    };
    return (
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? null
    );
  });
  expect(meta).toBe(appCsp());
  const mem0 = await memMiB(app);
  const t0 = Date.now();
  await openGlobe(win);
  await expect.poll(async () => (await inspect(win))?.tilesLoaded, { timeout: 30_000 }).toBe(true);
  const ready = Date.now() - t0;
  const mem1 = await memMiB(app);
  const seen = await win.evaluate(() => {
    const w = window as unknown as { __workers: string[]; __violations: string[] };
    return { workers: w.__workers, violations: w.__violations };
  });
  const workers = seen.workers.map((u) => u.replace(/^.*\//, ''));
  // eslint-disable-next-line no-console -- spike measurements, kept for the report
  console.log(
    `globe: ready in ${String(ready)} ms under the meta CSP; working set ${String(mem0)} -> ${String(mem1)} MiB; workers ${workers.join(', ')}`,
  );
  expect(seen.workers.length).toBeGreaterThan(0);
  // Cesium's workers are same-origin module files next to the page, never blob: URLs
  expect(seen.workers.every((u) => u.startsWith('file:') && u.includes('/cesium/Workers/'))).toBe(
    true,
  );
  expect(seen.violations).toEqual([]);
  expect(problems).toEqual([]);
  expect(await network.outbound()).toEqual([]);
});

test('every library project is a site; packs draw with their credits', async ({
  win,
  dataRoot,
}) => {
  await installSyntheticPacks(dataRoot);
  await openGlobe(win);
  const list = win.getByTestId('globe-sites');
  await expect(list.getByRole('button')).toHaveCount(3); // A, B and the tiny e2e project
  await expect(list).toContainText(SITE_A.name);
  await expect(list).toContainText(SITE_B.name);
  await expect(list).toContainText('1 open issue');
  await expectAccessible(win, 'Globe');
  await expect(win.locator('.globe-field select').first()).toContainText(
    'Synthetic imagery (syn-imagery)',
  );
  await flyToSite(win, SITE_A.name);
  await expect
    .poll(
      async () => {
        const s = await inspect(win);
        return s !== null && s.tilesLoaded && s.imageryTiles > 0;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  // the pack's flat magenta is drawn below the site pin, in the middle of the view
  const px = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="globe-canvas"]');
    const c = (el as { __aioGlobe?: { samplePixel(x: number, y: number): Promise<number[]> } })
      .__aioGlobe;
    return c?.samplePixel(0.35, 0.75);
  });
  expect(px?.[0]).toBeGreaterThan(150);
  expect(px?.[1]).toBeLessThan(100);
  expect(px?.[2]).toBeGreaterThan(110);
  const credits = win.getByTestId('globe-credits');
  await expect(credits).toContainText('Natural Earth II');
  await expect(credits).toContainText('Synthetic imagery test pack');
  const state = await inspect(win);
  if (state?.terrain.length) {
    // Medium tier and up: the benchmark height of the terrain pack (ellipsoidal heights)
    await expect(credits).toContainText('Synthetic terrain test pack');
    await expect
      .poll(
        () =>
          win.evaluate(
            ([lon, lat]) => {
              const el = document.querySelector('[data-testid="globe-canvas"]');
              const c = (el as { __aioGlobe?: { terrainHeight(lon: number, lat: number): number } })
                .__aioGlobe;
              return c?.terrainHeight(lon, lat) ?? null;
            },
            [A_LON, A_LAT] as const,
          ),
        { timeout: 30_000 },
      )
      .toBeCloseTo(BENCHMARK_M, 0);
  } else {
    // Low tier (software GPU): terrain stays off, and the panel says so
    await expect(win.getByText('Terrain is off on the Low graphics preset.')).toBeVisible();
  }
});

test('Open site here hands over to the site view; the Globe comes back to the same view', async ({
  win,
}) => {
  await openGlobe(win);
  await flyToSite(win, SITE_A.name);
  const camera = () =>
    win.evaluate(() => {
      const el = document.querySelector('[data-testid="globe-canvas"]');
      return (el as { __aioGlobe?: { camera(): { position: number[] } } }).__aioGlobe?.camera();
    });
  const before = await camera();
  await win.getByTestId('globe-card').getByRole('button', { name: 'Open site here' }).click();
  await expect(win.locator('.app')).toHaveAttribute('data-screen', 'scene');
  await expect(win.locator('.crumbs')).toContainText(SITE_A.name);
  // the Globe released its WebGL context when it closed
  await expect(win.getByTestId('globe-canvas')).toHaveCount(0);
  await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
  await expect.poll(async () => (await inspect(win))?.sites.length ?? 0).toBeGreaterThan(0);
  const after = await camera();
  const moved = Math.hypot(
    ...(after?.position ?? [0, 0, 0]).map((v, i) => v - (before?.position[i] ?? 0)),
  );
  expect(moved).toBeLessThan(1);
});

test('an issue pin opens the issue in the site view', async ({ win }) => {
  await openGlobe(win);
  await flyToSite(win, SITE_A.name);
  await win.getByTestId('globe-card').getByRole('button', { name: 'Open site here' }).click();
  await expect(win.locator('.app')).toHaveAttribute('data-screen', 'scene');
  // with the project open, its issues are pins on the Globe
  await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
  await expect.poll(async () => (await inspect(win))?.issuePins.length ?? 0).toBe(1);
  const pin = (await inspect(win))?.issuePins[0] ?? '';
  const pinAt = () =>
    win.evaluate((id) => {
      const el = document.querySelector('[data-testid="globe-canvas"]');
      const c = (el as { __aioGlobe?: { pinPosition(id: string): [number, number] | null } })
        .__aioGlobe;
      return c?.pinPosition(`issue:${id}`) ?? null;
    }, pin);
  await expect.poll(async () => (await pinAt()) !== null).toBe(true);
  const [x, y] = (await pinAt()) ?? [0, 0];
  const box = await win.getByTestId('globe-canvas').boundingBox();
  // the pin is drawn (its severity red) before it is clicked: billboard images load a frame late
  await expect
    .poll(
      () =>
        win.evaluate(
          ([fx, fy]) => {
            const el = document.querySelector('[data-testid="globe-canvas"]');
            const c = (
              el as { __aioGlobe?: { samplePixel(x: number, y: number): Promise<number[]> } }
            ).__aioGlobe;
            return c?.samplePixel(fx, fy).then((p) => (p[0] ?? 0) > 180 && (p[1] ?? 255) < 110);
          },
          [x / (box?.width ?? 1), y / (box?.height ?? 1)] as const,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await win.mouse.click((box?.x ?? 0) + x, (box?.y ?? 0) + y);
  const card = win.getByTestId('globe-card');
  await expect(card).toContainText('F01 Corrosion on the tank');
  await card.getByRole('button', { name: 'Open issue' }).click();
  await expect(win.locator('.app')).toHaveAttribute('data-screen', 'scene');
  await expect(win.getByTestId('issue-card')).toContainText('F01');
});

/**
 * A 2 km square of the 1 m test quad as a 3D Tiles 1.1 tileset in project A (glTF content, an
 * east-north-up root transform at the site origin, scaled), the shape `tiles.mesh` writes.
 */
async function writeQuadTileset(dataRoot: DataRoot): Promise<void> {
  const dir = join(dataRoot.root, 'projects', SITE_A.id, 'tiles', 'quad');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'quad.glb'), tinyGlb());
  const m = enuToEcefMatrix(A_LON, A_LAT, SITE_A.origin[2]);
  const S = 2000;
  const col = (i: number) => m.slice(i * 4, i * 4 + 3);
  const [e, n, u] = [col(0), col(1), col(2)];
  const origin = col(3).map((v, i) => v - 1000 * (e[i] ?? 0) - 1000 * (n[i] ?? 0));
  const transform = [
    ...e.map((v) => v * S),
    0,
    ...n.map((v) => v * S),
    0,
    ...u.map((v) => v * S),
    0,
    ...origin,
    1,
  ];
  await writeFile(
    join(dir, 'tileset.json'),
    JSON.stringify({
      asset: { version: '1.1' },
      geometricError: 100,
      root: {
        transform,
        boundingVolume: { box: [0.5, 0.5, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.01] },
        geometricError: 0,
        refine: 'REPLACE',
        content: { uri: 'quad.glb' },
      },
    }),
  );
}

test('the tilesets of a project draw on the Globe', async ({ win, dataRoot }) => {
  await writeQuadTileset(dataRoot);
  await openGlobe(win);
  await flyToSite(win, SITE_A.name);
  const sample = () =>
    win.evaluate(() => {
      const el = document.querySelector('[data-testid="globe-canvas"]');
      const c = (el as { __aioGlobe?: { samplePixel(x: number, y: number): Promise<number[]> } })
        .__aioGlobe;
      return c?.samplePixel(0.35, 0.75);
    });
  const ground = await sample();
  // G7's tilesets:list is not in this build yet: give the Globe the entry it would answer
  await win.evaluate((id) => {
    const el = document.querySelector('[data-testid="globe-canvas"]');
    const c = (el as { __aioGlobe?: { setTilesets: (...a: unknown[]) => Promise<void> } })
      .__aioGlobe;
    return c?.setTilesets(id, { crs: { epsg: 32639 }, origin: [0, 0, 0], heightOffset: 0 }, [
      { id: 'quad', src: 'tiles/quad/tileset.json', visible: true },
    ]);
  }, SITE_A.id);
  await expect
    .poll(async () => (await inspect(win))?.tilesets, { timeout: 20_000 })
    .toEqual([{ id: 'quad', ready: true }]);
  // the white quad now covers the ground under the camera
  const quad = await sample();
  expect(ground?.slice(0, 3).every((v) => v > 215)).toBe(false);
  expect(quad?.slice(0, 3).every((v) => v > 215)).toBe(true);
});

test('the only tool is a distance and area read-out on the ellipsoid', async ({ win }) => {
  await openGlobe(win);
  await flyToSite(win, SITE_A.name);
  await win.getByRole('button', { name: 'Measure on the ellipsoid' }).click();
  const readout = win.getByTestId('globe-readout');
  await expect(readout).toContainText('Click points on the ground');
  const box = await win.getByTestId('globe-canvas').boundingBox();
  const at = (fx: number, fy: number) =>
    win.mouse.click(
      (box?.x ?? 0) + (box?.width ?? 0) * fx,
      (box?.y ?? 0) + (box?.height ?? 0) * fy,
    );
  await at(0.35, 0.7);
  await at(0.65, 0.7);
  await expect(readout).toContainText(/Distance on the ellipsoid: \d+ m/);
  await at(0.5, 0.85);
  await expect(readout).toContainText(/area: [\d.]+ (m²|ha)/);
  // picking is off while measuring: no card opened
  await expect(win.getByTestId('globe-card')).toHaveCount(0);
});

test('closing the Globe gives its WebGL context back', async ({ app, win }) => {
  const gpuMiB = () =>
    app.evaluate(({ app: a }) =>
      Math.round(
        a
          .getAppMetrics()
          .filter((m) => m.type === 'GPU')
          .reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024,
      ),
    );
  const before = await gpuMiB();
  const seen: number[] = [];
  for (let i = 0; i < 2; i++) {
    await openGlobe(win);
    await flyToSite(win, SITE_A.name);
    seen.push(await gpuMiB());
    await win.evaluate(() => {
      const el = document.querySelector('[data-testid="globe-canvas"] canvas');
      (window as unknown as { __globeCanvas?: Element | null }).__globeCanvas = el;
    });
    await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).click();
    await expect(win.getByTestId('globe-canvas')).toHaveCount(0);
    const lost = await win.evaluate(() => {
      const c = (window as unknown as { __globeCanvas?: HTMLCanvasElement }).__globeCanvas;
      return c?.getContext('webgl2')?.isContextLost() ?? null;
    });
    expect(lost).toBe(true);
  }
  // eslint-disable-next-line no-console -- the GPU process working set, for the report
  console.log(`globe GPU process: ${String(before)} MiB, open ${seen.join(', ')} MiB`);
});
