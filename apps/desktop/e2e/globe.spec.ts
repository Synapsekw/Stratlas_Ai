/**
 * The Globe (M10 G6): CesiumJS offline under the app CSP, every library project as a site, the
 * street map from a synthetic street pack over the bundled land shapes, imagery and terrain from
 * synthetic packs with their credits, the three looks, the hand-off to the site view and back,
 * issue pins, and the WebGL context given back when the Globe closes. Synthetic data only; the
 * zero-network guard of the fixtures runs on every test.
 */
import { utmToWgs84 } from '@aio/geo';
import { enuToEcefMatrix } from '@aio/globe';
import type { GlobeInspection } from '@aio/globe/view';
import {
  pmtilesOf,
  solidPng,
  squareMvt,
  syntheticPackMeta,
  terrariumPng,
} from '@aio/globe/testing';
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

/**
 * How long a flight and the tiles it brings in may take. On a software GPU the Globe's tile
 * stream can hold the renderer for tens of seconds: on the Windows runner (Low tier) one
 * `inspect()` sent as the flight to the synthetic packs began came back 30 s later (CI run
 * 37722686745), and Chromium's WARP rasteriser shows the same on a workstation
 * (QUADRION_E2E_SWGL=warp: 1 to 6 s per call on one or two cores, 0.2 s on SwiftShader), with the
 * flight then ending where it should. A polled value arrives late but right, so this is wall time
 * for slow software rendering; a fast GPU settles in a second or two.
 */
const SETTLE_MS = 60_000;
// a flight and its tiles may each take SETTLE_MS on the software GPU
test.describe.configure({ timeout: 3 * SETTLE_MS });

/** The graphics tier and WebGL renderer the app detected, for failure messages. */
const graphics = (win: Page) =>
  win
    .evaluate(async () => {
      const m = await (
        window as unknown as {
          __stratlas: { memory(): Promise<{ tier: string; renderer?: string | null }> };
        }
      ).__stratlas.memory();
      return `${m.tier} tier, ${m.renderer ?? 'no WebGL renderer'}`;
    })
    .catch((e: unknown) => `graphics unknown: ${String(e)}`);

/** Poll the Globe until `ok`; a timeout says what it last showed and on which GPU. */
async function settle(win: Page, what: string, ok: (s: GlobeInspection) => boolean) {
  let last: GlobeInspection | null = null;
  try {
    await expect
      .poll(
        async () => {
          last = await inspect(win);
          return last !== null && ok(last);
        },
        { timeout: SETTLE_MS },
      )
      .toBe(true);
  } catch (e) {
    const shown = last as GlobeInspection | null;
    const state = shown
      ? `flying ${String(shown.flying)}, height ${shown.cameraHeight.toFixed(0)} m, tiles loaded ${String(shown.tilesLoaded)}, ${String(shown.imageryTiles)} pack tiles, frame ${String(shown.frame)}`
      : 'no Globe';
    throw new Error(`${what} within ${String(SETTLE_MS)} ms: ${state}; ${await graphics(win)}`, {
      cause: e,
    });
  }
}

/** Where a site's pin is drawn, in CSS pixels of the Globe; null when it is not on screen. */
const pinOf = (win: Page, projectId: string) =>
  win.evaluate((id) => {
    const el = document.querySelector('[data-testid="globe-canvas"]');
    const c = (el as { __aioGlobe?: { pinPosition(id: string): [number, number] | null } })
      .__aioGlobe;
    return c?.pinPosition(`site:${id}`) ?? null;
  }, projectId);

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

/**
 * Install a synthetic street pack over the synthetic packs' box (`packs/<id>.pmtiles` and its
 * `MapPackInfo`, as a pack download leaves them): every vector tile from zoom 6 down is one
 * polygon of the street style's water, so where the pack is drawn the land turns to water.
 */
async function installSyntheticStreets(dataRoot: DataRoot): Promise<void> {
  const bytes = pmtilesOf({
    bbox: PACK_BBOX,
    minZoom: 6,
    maxZoom: 14,
    tile: squareMvt('water'),
    tileType: 'mvt',
  });
  const dir = join(dataRoot.root, 'packs');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'syn-streets.pmtiles'), bytes);
  await writeFile(
    join(dir, 'syn-streets.json'),
    JSON.stringify({
      id: 'syn-streets',
      label: 'Synthetic streets',
      bbox: [...PACK_BBOX],
      maxZoom: 14,
      sizeBytes: bytes.length,
    }),
  );
}

/** The colour drawn at a point of the Globe (fractions of the canvas), after its next frame. */
const sampleAt = (win: Page, fx: number, fy: number) =>
  win.evaluate(
    ([x, y]) => {
      const el = document.querySelector('[data-testid="globe-canvas"]');
      const c = (el as { __aioGlobe?: { samplePixel(x: number, y: number): Promise<number[]> } })
        .__aioGlobe;
      return c?.samplePixel(x, y);
    },
    [fx, fy] as const,
  );

/**
 * A click at this point of the window lands on the Globe's canvas: no panel, card, button or
 * label of the Globe's chrome is in the way (whatever the platform's window chrome and fonts).
 */
async function expectGlobeAt(win: Page, x: number, y: number) {
  const hit = await win.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return 'nothing';
      const inGlobe = el.closest('[data-testid="globe-canvas"]') !== null;
      return `${el.tagName.toLowerCase()}${inGlobe ? ' of the Globe' : ` .${el.getAttribute('class') ?? ''}`}`;
    },
    [x, y] as const,
  );
  expect(hit, `what is at ${x.toFixed(0)}, ${y.toFixed(0)}`).toBe('canvas of the Globe');
}

async function openGlobe(win: Page) {
  await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
  await expect(win.getByTestId('globe-canvas').locator('canvas')).toBeVisible();
  // The Globe's first frames hold the renderer like a flight does: on the Windows runner the
  // first inspect() came back after 15.8 s (main run 37854082873), so a 5 s poll gave up on it.
  await settle(win, 'the Globe placed the sites', (s) => s.sites.length > 0);
}

/** Pick a site in the list and wait for the flight to end over it. */
async function flyToSite(win: Page, name: string) {
  await win
    .getByTestId('globe-sites')
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await expect(win.getByTestId('globe-card')).toContainText(name);
  await settle(win, `the flight to ${name} ended`, (s) => !s.flying && s.cameraHeight < 5000);
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
  // the street map is the default look: the bundled land shapes, and no imagery pack drawn
  const credits = win.getByTestId('globe-credits');
  await expect(win.getByTestId('globe-look-street')).toHaveAttribute('aria-pressed', 'true');
  expect((await inspect(win))?.layers).toEqual(['earth-shapes:whole']);
  await expect(credits).toContainText('Natural Earth (public domain)');
  await expect(credits).not.toContainText('Synthetic imagery test pack');
  await expect(win.getByText(/No street map pack is installed/)).toBeVisible();
  // satellite is a choice: the packs go over the street globe
  await win.getByTestId('globe-look-satellite').click();
  await settle(win, 'the imagery pack is a layer', (s) => s.imagery.includes('syn-imagery'));
  expect((await inspect(win))?.layers).toEqual(['earth-shapes:whole', 'pack:syn-imagery']);
  await expect(win.locator('.globe-field select').first()).toContainText(
    'Synthetic imagery (syn-imagery)',
  );
  await flyToSite(win, SITE_A.name);
  await settle(win, 'the pack tiles loaded', (s) => s.tilesLoaded && s.imageryTiles > 0);
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
  await expect(credits).toContainText('Natural Earth (public domain)');
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
  // the old look stays within reach: Natural Earth II under the packs, credited as before
  await win.getByTestId('globe-look-natural-earth').click();
  await settle(
    win,
    'the Natural Earth raster is the base',
    (s) => s.layers[0] === 'natural-earth-ii',
  );
  expect((await inspect(win))?.layers).toEqual(['natural-earth-ii', 'pack:syn-imagery']);
  await expect(credits).toContainText('Natural Earth II (public domain)');
  await settle(win, 'the pack draws over it', (s) => s.tilesLoaded && s.imageryTiles > 0);
  const old = await sampleAt(win, 0.35, 0.75);
  expect(old?.[0]).toBeGreaterThan(150);
  expect(old?.[1]).toBeLessThan(100);
  // and the look is remembered for the next time the Globe opens
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).click();
  await expect(win.getByTestId('globe-canvas')).toHaveCount(0);
  await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
  await expect(win.getByTestId('globe-look-natural-earth')).toHaveAttribute('aria-pressed', 'true');
});

test('street packs draw as the street map of the Globe, offline under the app CSP', async ({
  win,
  dataRoot,
  network,
}) => {
  await installSyntheticStreets(dataRoot);
  const problems: string[] = [];
  win.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(text))
      problems.push(text);
  });
  win.on('pageerror', (e) => problems.push(String(e)));
  await expect(win.locator('.sb-nav .nav-item', { hasText: 'Globe' })).toBeVisible();
  await win.evaluate(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
  await openGlobe(win);
  expect((await inspect(win))?.layers).toEqual(['earth-shapes:underlay', 'street']);
  await expect(win.getByTestId('globe-credits')).toContainText('OpenStreetMap contributors');
  await expect(win.getByText(/No street map pack is installed/)).toHaveCount(0);
  await flyToSite(win, SITE_A.name);
  // street tiles are drawn one at a time by a hidden map: wait for the ones in view
  await settle(win, 'the street tiles drew', (s) => s.tilesLoaded && (s.street?.tiles ?? 0) > 0);
  // site A is inland: the land shapes alone would be the style's land (a neutral dark grey);
  // the synthetic pack paints its tiles as water (a dark blue)
  const px = await sampleAt(win, 0.35, 0.75);
  // (land is about 16, 19, 23 and water about 1, 20, 31: blue well over red, whatever the GPU)
  expect((px?.[2] ?? 0) - (px?.[0] ?? 0)).toBeGreaterThan(13);
  const state = await inspect(win);
  expect(state?.street?.timeouts).toBe(0);
  expect(state?.street?.lastError ?? null).toBeNull();
  // the Natural Earth look draws no street tiles
  await win.getByTestId('globe-look-natural-earth').click();
  await settle(win, 'the street layer is gone', (s) => !s.layers.includes('street'));
  expect((await inspect(win))?.street).toBeNull();
  const violations = await win.evaluate(
    () => (window as unknown as { __violations: string[] }).__violations,
  );
  expect(violations).toEqual([]);
  expect(problems).toEqual([]);
  expect(await network.outbound()).toEqual([]);
});

test('a site lights up under the pointer and when it is selected', async ({ win }) => {
  await openGlobe(win);
  // the sites are far apart, each its own pin; the pins stand still once the opening flight ends
  await settle(win, 'the opening flight ended', (s) => !s.flying);
  await expect.poll(async () => (await pinOf(win, SITE_A.id)) !== null).toBe(true);
  const box = await win.getByTestId('globe-canvas').boundingBox();
  const [x, y] = (await pinOf(win, SITE_A.id)) ?? [0, 0];
  // the pointer arrives, then rests on the pin
  await expectGlobeAt(win, (box?.x ?? 0) + x, (box?.y ?? 0) + y);
  await win.mouse.move((box?.x ?? 0) + x + 40, (box?.y ?? 0) + y + 30);
  await win.mouse.move((box?.x ?? 0) + x, (box?.y ?? 0) + y);
  await expect
    .poll(async () => (await inspect(win))?.hover, { timeout: 15_000 })
    .toEqual({ kind: 'site', projectId: SITE_A.id });
  const hover = win.getByTestId('globe-tag-hover');
  await expect(hover).toContainText(SITE_A.name);
  // the label itself (the element the Globe moves is a point without a size)
  await expect(hover.locator('.aio-globe-chip')).toBeVisible();
  // a click selects it: the card opens and the label stays beside the pin
  await win.mouse.click((box?.x ?? 0) + x, (box?.y ?? 0) + y);
  await expect(win.getByTestId('globe-card')).toContainText(SITE_A.name);
  expect((await inspect(win))?.selected).toBe(SITE_A.id);
  const selected = win.getByTestId('globe-tag-selected');
  await expect(selected).toContainText(SITE_A.name);
  await expect(selected.locator('.aio-globe-chip')).toBeVisible();
  // a row of the list lights its pin the same way
  await win
    .getByTestId('globe-sites')
    .getByRole('button', { name: new RegExp(SITE_B.name) })
    .hover();
  await expect(hover).toContainText(SITE_B.name);
  // closing the card clears the selection
  await win.getByTestId('globe-card').getByRole('button', { name: 'Close' }).click();
  await expect(win.getByTestId('globe-card')).toHaveCount(0);
  await expect.poll(async () => (await inspect(win))?.selected).toBeNull();
});

test('the view buttons zoom and show every site again', async ({ win }) => {
  await openGlobe(win);
  await settle(win, 'the opening flight ended', (s) => !s.flying);
  const height = async () => (await inspect(win))?.cameraHeight ?? 0;
  const start = await height();
  await win.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(height, { timeout: 15_000 }).toBeLessThan(start * 0.7);
  const near = await height();
  await win.getByRole('button', { name: 'Zoom out' }).click();
  await expect.poll(height, { timeout: 15_000 }).toBeGreaterThan(near * 1.5);
  await flyToSite(win, SITE_A.name);
  await win.getByRole('button', { name: 'Show all sites' }).click();
  await expect(win.getByTestId('globe-card')).toHaveCount(0);
  await settle(win, 'the Globe shows every site', (s) => !s.flying && s.cameraHeight > 100_000);
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
  await expectGlobeAt(win, (box?.x ?? 0) + x, (box?.y ?? 0) + y);
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
  const at = async (fx: number, fy: number) => {
    const x = (box?.x ?? 0) + (box?.width ?? 0) * fx;
    const y = (box?.y ?? 0) + (box?.height ?? 0) * fy;
    // the panel, the read-out and the view buttons leave this part of the Globe free
    await expectGlobeAt(win, x, y);
    await win.mouse.click(x, y);
  };
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
