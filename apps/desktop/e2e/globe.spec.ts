/**
 * The Globe (M10 G6): CesiumJS offline under the app CSP, every library project as a site, the
 * street map from a synthetic street pack over the bundled land shapes, imagery and terrain from
 * synthetic packs with their credits, the three looks, the hand-off to the site view and back,
 * issue pins, and the WebGL context given back when the Globe closes. Synthetic data only; the
 * zero-network guard of the fixtures runs on every test.
 *
 * A site is a named chip on the Globe (chips that would overlap gather into one), its card opens
 * by its pin, the sites are listed by the **Find a site** field at the top and the map settings
 * are a dialog behind the **Map** button: the tests reach a site and a look the way a person does.
 */
import { utmToWgs84 } from '@aio/geo';
import { enuToEcefMatrix } from '@aio/globe';
import type { GlobeStyle } from '@aio/globe';
import type { GlobeInspection } from '@aio/globe/view';
import {
  pmtilesOf,
  solidPng,
  squareMvt,
  syntheticPackMeta,
  terrariumPng,
} from '@aio/globe/testing';
import {
  ONLINE_SATELLITE,
  ProjectManifest,
  SCHEMA_VERSION,
  type ProjectManifestInput,
} from '@aio/schema';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CSP, metaPolicy } from '../src/main/csp';
import { expectAccessible } from './a11y';
import { expect, processingChip, test, tinyGlb, TINY_PROJECT_ID, type DataRoot } from './fixtures';

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
 * Two frames of the Globe. What it places after a frame it draws (the labels, the card by its
 * pin, the chips that gather) is in place once the second has been drawn.
 */
async function frames(win: Page) {
  await sampleAt(win, 0.5, 0.5);
  await sampleAt(win, 0.5, 0.5);
}

/** The parts of the Globe's controller (the hook on its element) that turn and move the view. */
interface GlobeHook {
  pinPosition(id: string): [number, number] | null;
  widget: {
    scene: {
      canvas: HTMLCanvasElement;
      requestRender(): void;
      camera: {
        pitch: number;
        positionCartographic: { height: number };
        frustum: { fov: number };
        setView(view: { orientation: { heading: number; pitch: number; roll: number } }): void;
        moveLeft(metres: number): void;
        moveUp(metres: number): void;
      };
    };
  };
}

/** Turn the view where it stands until south is up, as a drag with the middle button does. */
async function faceSouth(win: Page) {
  await win.evaluate(() => {
    const el = document.querySelector('[data-testid="globe-canvas"]');
    const scene = (el as unknown as { __aioGlobe: GlobeHook }).__aioGlobe.widget.scene;
    scene.camera.setView({
      orientation: { heading: Math.PI, pitch: scene.camera.pitch, roll: 0 },
    });
    scene.requestRender();
  });
  await frames(win);
}

/**
 * Slide the view sideways (no turn, no zoom), as a drag does, until a site's pin is drawn at this
 * point of the Globe (fractions of its size).
 */
async function putPinAt(win: Page, projectId: string, fx: number, fy: number) {
  await win.evaluate(
    ([id, x, y]) => {
      const el = document.querySelector('[data-testid="globe-canvas"]');
      const c = (el as unknown as { __aioGlobe: GlobeHook }).__aioGlobe;
      const { camera, canvas } = c.widget.scene;
      // pixels to metres at the pin, roughly: each step lands nearer, so a few of them arrive
      const focal =
        Math.max(canvas.clientWidth, canvas.clientHeight) / 2 / Math.tan(camera.frustum.fov / 2);
      for (let i = 0; i < 24; i++) {
        const at = c.pinPosition(`site:${id}`);
        if (!at) break;
        const dx = x * canvas.clientWidth - at[0];
        const dy = y * canvas.clientHeight - at[1];
        if (Math.hypot(dx, dy) < 1) break;
        const depth = camera.positionCartographic.height / Math.max(0.2, -Math.sin(camera.pitch));
        camera.moveLeft((dx * depth) / focal);
        camera.moveUp((dy * depth) / focal);
      }
      c.widget.scene.requestRender();
    },
    [projectId, fx, fy] as const,
  );
  await frames(win);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const edges = (b: Box) =>
  `${b.x.toFixed(0)}, ${b.y.toFixed(0)} to ${(b.x + b.width).toFixed(0)}, ${(b.y + b.height).toFixed(0)}`;
/** `a` lies wholly inside `b` (half a pixel of rounding allowed). */
const within = (a: Box, b: Box) =>
  a.x >= b.x - 0.5 &&
  a.y >= b.y - 0.5 &&
  a.x + a.width <= b.x + b.width + 0.5 &&
  a.y + a.height <= b.y + b.height + 0.5;
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Where an element is drawn in the window; it must be there. */
async function boxOf(target: Locator, what: string): Promise<Box> {
  await expect(target, what).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${what} has no box`);
  return box;
}

/** The Globe's own box: the screen under the title bar, beside the sidebar. */
const globeBox = (win: Page) => boxOf(win.getByTestId('globe-screen'), 'the Globe');

/** Every part lies wholly inside the Globe, and no two of them overlap. */
function expectLaidOut(globe: Box, parts: Record<string, Box>) {
  const named = Object.entries(parts);
  for (const [name, box] of named)
    expect(within(box, globe), `${name} (${edges(box)}) inside the Globe (${edges(globe)})`).toBe(
      true,
    );
  named.forEach(([name, box], i) => {
    for (const [other, otherBox] of named.slice(i + 1))
      expect(
        overlap(box, otherBox),
        `${name} (${edges(box)}) overlaps ${other} (${edges(otherBox)})`,
      ).toBe(false);
  });
}

/**
 * The pieces the Globe keeps at its edges whatever it shows: the field (or the read-out that
 * takes its place), the Map button, the view buttons and the credits.
 */
async function edgePieces(win: Page): Promise<Record<string, Box>> {
  const top = (await win.getByTestId('globe-readout').count())
    ? { 'the read-out': await boxOf(win.getByTestId('globe-readout'), 'the read-out') }
    : { 'the field': await boxOf(win.locator('.globe-search-in'), 'the Find a site field') };
  return {
    ...top,
    'the Map button': await boxOf(win.getByTestId('globe-map-button'), 'the Map button'),
    'the view buttons': await boxOf(
      win.getByRole('group', { name: 'Globe view' }),
      'the view buttons',
    ),
    'the credits': await boxOf(win.getByTestId('globe-credits'), 'the credits'),
  };
}

/** The open card, once it has risen into place by its pin. */
async function cardBox(win: Page): Promise<Box> {
  const card = win.getByTestId('globe-card');
  await expect(card).toBeVisible();
  await card.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await frames(win);
  return boxOf(card, 'the card');
}

/**
 * The card stands by its pin (a point of the window): just under it or just over it, and across
 * it. For a pin well inside the Globe; at an edge the card slides along the edge instead.
 */
function expectByPin(card: Box, [x, y]: readonly [number, number]) {
  const gap = Math.min(Math.abs(card.y - y), Math.abs(y - (card.y + card.height)));
  expect(gap, `from the pin at ${y.toFixed(0)} to the card (${edges(card)})`).toBeLessThan(24);
  expect(x, `the pin against the card (${edges(card)})`).toBeGreaterThan(card.x);
  expect(x, `the pin against the card (${edges(card)})`).toBeLessThan(card.x + card.width);
}

/**
 * The field and the Map button keep out of the title bar above the Globe: its breadcrumbs, its
 * search and help buttons and every status chip it shows (Processing, Share, the connection).
 */
async function expectClearOfTitleBar(win: Page) {
  const bar: [string, Box][] = [];
  const items = win.locator(
    '.titlebar > .brand, .titlebar > .crumbs, .titlebar > button, .titlebar .tb-status > *',
  );
  for (const item of await items.all()) {
    const box = await item.boundingBox();
    if (!box || box.width === 0) continue;
    const name = await item.evaluate(
      (el) => el.getAttribute('data-testid') ?? el.getAttribute('class') ?? el.tagName,
    );
    bar.push([`the title bar's ${name}`, box]);
  }
  // the brand, the breadcrumbs, search, help and the connection menu are always there
  expect(bar.length).toBeGreaterThanOrEqual(5);
  const mine = {
    'the field': await boxOf(win.locator('.globe-search-in'), 'the Find a site field'),
    'the Map button': await boxOf(win.getByTestId('globe-map-button'), 'the Map button'),
  };
  for (const [name, box] of Object.entries(mine))
    for (const [other, otherBox] of bar)
      expect(
        overlap(box, otherBox),
        `${name} (${edges(box)}) overlaps ${other} (${edges(otherBox)})`,
      ).toBe(false);
}

/**
 * A click at this point of the window lands on the Globe's canvas: no card, button, field or
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

/** The field at the top of the Globe that lists the sites and finds one by name. */
const findField = (win: Page) => win.getByRole('combobox', { name: 'Find a site' });

/** Open the field's list of sites (a click in the field); the list. */
async function openSiteList(win: Page) {
  await findField(win).click();
  const list = win.getByTestId('globe-sites');
  await expect(list).toBeVisible();
  return list;
}

/** Pick a site in the field's list and wait for the flight to end over it. */
async function flyToSite(win: Page, name: string) {
  const list = await openSiteList(win);
  await list.getByRole('option', { name: new RegExp(name) }).click();
  await expect(list).toHaveCount(0);
  await expect(win.getByTestId('globe-card')).toContainText(name);
  await settle(win, `the flight to ${name} ended`, (s) => !s.flying && s.cameraHeight < 5000);
}

/** Open the Map dialog (the Map button at the top right), unless it is open; the dialog. */
async function openMap(win: Page) {
  const menu = win.getByTestId('globe-map-menu');
  if (!(await menu.isVisible())) await win.getByTestId('globe-map-button').click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Close the Map dialog with Esc, so nothing of it lies over the Globe. */
async function closeMap(win: Page) {
  const menu = win.getByTestId('globe-map-menu');
  if (await menu.isVisible()) {
    // Esc is the dialog's own: it closes while the focus is inside it
    await expect(menu.locator(':focus')).toHaveCount(1);
    await win.keyboard.press('Escape');
  }
  await expect(menu).toHaveCount(0);
}

/** Choose a map type in the Map dialog, which stays open to show what the look needs; the dialog. */
async function chooseLook(win: Page, style: GlobeStyle) {
  const menu = await openMap(win);
  const look = win.getByTestId(`globe-look-${style}`);
  await look.click();
  await expect(look).toHaveAttribute('aria-pressed', 'true');
  return menu;
}

/** Choose a map type in the Map dialog, then close the dialog: nothing of it covers the Globe. */
async function setLook(win: Page, style: GlobeStyle) {
  await chooseLook(win, style);
  await closeMap(win);
}

/** Whether a site is drawn inside a gathered chip ("2 sites") and not as its own. */
const gathered = async (win: Page, projectId: string) =>
  (await inspect(win))?.clusters.some((c) => c.sites.includes(projectId)) ?? true;

/**
 * Make sure a site has a chip of its own before the pointer goes to it: a gathered site is
 * drawn as part of one chip, which is not the site's to hover or click. Near the ground no other
 * site is in view, so a flight there and back out of its card always parts them.
 */
async function standAlone(win: Page, site: { id: string; name: string }) {
  await frames(win);
  if (!(await gathered(win, site.id))) return;
  await flyToSite(win, site.name);
  await win.getByTestId('globe-card').getByRole('button', { name: 'Close' }).click();
  await expect(win.getByTestId('globe-card')).toHaveCount(0);
  await expect.poll(() => gathered(win, site.id), { timeout: SETTLE_MS }).toBe(false);
}

/** Where a site's pin (the dot of its chip) is drawn, in the window's own pixels. */
async function pinInWindow(win: Page, projectId: string): Promise<[number, number]> {
  await expect.poll(async () => (await pinOf(win, projectId)) !== null).toBe(true);
  const box = await boxOf(win.getByTestId('globe-canvas'), 'the Globe');
  const [x, y] = (await pinOf(win, projectId)) ?? [0, 0];
  return [box.x + x, box.y + y];
}

/** Bring the pointer to a point of the Globe and let it rest there, as a hand does. */
async function pointAt(win: Page, x: number, y: number) {
  await expectGlobeAt(win, x, y);
  await win.mouse.move(x + 40, y + 30);
  await win.mouse.move(x, y);
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
  // the field lists them: A, B and the tiny e2e project, each with its state
  const list = await openSiteList(win);
  await expect(list.getByRole('option')).toHaveCount(3);
  await expect(list).toContainText(SITE_A.name);
  await expect(list).toContainText(SITE_B.name);
  await expect(list).toContainText('1 open issue');
  await expectAccessible(win, 'Globe');
  await win.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  // the street map is the default look: the bundled land shapes, and no imagery pack drawn
  const credits = win.getByTestId('globe-credits');
  const map = await openMap(win);
  await expect(win.getByTestId('globe-look-street')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => (await inspect(win))?.layers, { timeout: SETTLE_MS })
    .toEqual(['earth-shapes:whole']);
  await expect(credits).toContainText('Natural Earth (public domain)');
  await expect(credits).not.toContainText('Synthetic imagery test pack');
  await expect(map.getByText(/No street map pack is installed/)).toBeVisible();
  await expectAccessible(win, 'Globe');
  // satellite is a choice: the packs go over the street globe
  await chooseLook(win, 'satellite');
  await settle(win, 'the imagery pack is a layer', (s) => s.imagery.includes('syn-imagery'));
  await expect
    .poll(async () => (await inspect(win))?.layers, { timeout: SETTLE_MS })
    .toEqual(['earth-shapes:whole', 'pack:syn-imagery']);
  await expect(map.locator('.globe-field select').first()).toContainText(
    'Synthetic imagery (syn-imagery)',
  );
  await closeMap(win);
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
    // Low tier (software GPU): terrain stays off, and the Map dialog says so
    await expect(
      (await openMap(win)).getByText('Terrain is off on the Low graphics preset.'),
    ).toBeVisible();
    await closeMap(win);
  }
  // the old look stays within reach: Natural Earth II under the packs, credited as before
  await setLook(win, 'natural-earth');
  await settle(
    win,
    'the Natural Earth raster is the base',
    (s) => s.layers[0] === 'natural-earth-ii',
  );
  await expect
    .poll(async () => (await inspect(win))?.layers, { timeout: SETTLE_MS })
    .toEqual(['natural-earth-ii', 'pack:syn-imagery']);
  await expect(credits).toContainText('Natural Earth II (public domain)');
  await settle(win, 'the pack draws over it', (s) => s.tilesLoaded && s.imageryTiles > 0);
  const old = await sampleAt(win, 0.35, 0.75);
  expect(old?.[0]).toBeGreaterThan(150);
  expect(old?.[1]).toBeLessThan(100);
  // and the look is remembered for the next time the Globe opens
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).click();
  await expect(win.getByTestId('globe-canvas')).toHaveCount(0);
  await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
  await openMap(win);
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
  await expect
    .poll(async () => (await inspect(win))?.layers, { timeout: SETTLE_MS })
    .toEqual(['earth-shapes:underlay', 'street']);
  await expect(win.getByTestId('globe-credits')).toContainText('OpenStreetMap contributors');
  // the Map dialog has no word about a missing street pack
  const map = await openMap(win);
  await expect(win.getByTestId('globe-look-street')).toHaveAttribute('aria-pressed', 'true');
  await expect(map.getByText(/No street map pack is installed/)).toHaveCount(0);
  await closeMap(win);
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
  await setLook(win, 'natural-earth');
  await settle(win, 'the street layer is gone', (s) => !s.layers.includes('street'));
  await expect.poll(async () => (await inspect(win))?.street, { timeout: SETTLE_MS }).toBeNull();
  const violations = await win.evaluate(
    () => (window as unknown as { __violations: string[] }).__violations,
  );
  expect(violations).toEqual([]);
  expect(problems).toEqual([]);
  expect(await network.outbound()).toEqual([]);
});

test('a site lights up under the pointer and when it is selected', async ({ win }) => {
  await openGlobe(win);
  // the chips stand still once the opening flight ends; site A has one of its own
  await settle(win, 'the opening flight ended', (s) => !s.flying);
  await standAlone(win, SITE_A);
  // The dot of the chip is the site: at the site's own place the chip is drawn in the amber of
  // a site with an open issue, and 6 px to each side in the chip's dark ground (the dot is 8 px
  // across), whatever the screen's scale.
  const [x, y] = await pinInWindow(win, SITE_A.id);
  const canvas = await boxOf(win.getByTestId('globe-canvas'), 'the Globe');
  const drawnAt = async (dx: number, dy: number) => {
    const [r = 0, g = 0, b = 0] =
      (await sampleAt(
        win,
        (x - canvas.x + dx) / canvas.width,
        (y - canvas.y + dy) / canvas.height,
      )) ?? [];
    return { r, g, b };
  };
  // (billboard images load a frame late)
  await expect
    .poll(
      async () => {
        const { r, g, b } = await drawnAt(0, 0);
        return r > 180 && g > 80 && g < 200 && r - b > 80;
      },
      { message: "amber at the place of site A's pin", timeout: 15_000 },
    )
    .toBe(true);
  for (const [dx, dy] of [
    [-6, 0],
    [6, 0],
    [0, -6],
    [0, 6],
  ] as const) {
    const { r, g, b } = await drawnAt(dx, dy);
    expect(
      Math.max(r, g, b),
      `the chip ${String(dx)}, ${String(dy)} px from its dot is drawn ${String(r)}, ${String(g)}, ${String(b)}`,
    ).toBeLessThan(90);
  }
  // the pointer arrives, then rests on the dot
  await pointAt(win, x, y);
  await expect
    .poll(async () => (await inspect(win))?.hover, { timeout: 15_000 })
    .toEqual({ kind: 'site', projectId: SITE_A.id });
  const hover = win.getByTestId('globe-tag-hover');
  await expect(hover).toContainText(SITE_A.name);
  // the label itself (the element the Globe moves is a point without a size)
  await expect(hover.locator('.aio-globe-chip')).toBeVisible();
  // a click selects it: its card opens, by the pin and wholly inside the Globe
  await win.mouse.click(x, y);
  const card = win.getByTestId('globe-card');
  await expect(card).toContainText(SITE_A.name);
  await expect(card).toHaveAccessibleName(SITE_A.name);
  await expect
    .poll(async () => (await inspect(win))?.selected, { timeout: SETTLE_MS })
    .toBe(SITE_A.id);
  const globe = await globeBox(win);
  const placed = await cardBox(win);
  expect(within(placed, globe), `the card (${edges(placed)}) inside the Globe`).toBe(true);
  expectByPin(placed, [x, y]);
  // the selected site wears its rings and no label: the chip and the card say its name
  const selected = win.getByTestId('globe-tag-selected');
  await expect(selected.locator('.aio-globe-pulse')).toBeVisible();
  await expect(selected).toHaveText('');
  await expect(selected.locator('.aio-globe-chip')).toHaveCount(0);
  // a row of the field under the pointer lights its chip the same way
  const list = await openSiteList(win);
  await list.getByRole('option', { name: new RegExp(SITE_B.name) }).hover();
  await expect(hover).toContainText(SITE_B.name);
  await win.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(hover).not.toContainText(SITE_B.name);
  // closing the card clears the selection
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await inspect(win))?.selected).toBeNull();
});

test('chips that overlap gather into one, at any heading, and part again', async ({ win }) => {
  await openGlobe(win);
  await settle(win, 'the opening flight ended', (s) => !s.flying);
  // the tiny project and site A lie some 250 km apart, site B far to the south-west of both
  const pair = [TINY_PROJECT_ID, SITE_A.id];
  const groups = async () => (await inspect(win))?.clusters ?? null;
  const together = async () =>
    (await groups())?.some((c) => pair.every((id) => c.sites.includes(id))) ?? false;
  // from further out the chips of the two would overlap: one chip stands for both
  for (let step = 0; step < 2 && !(await together()); step++) {
    const from = (await inspect(win))?.cameraHeight ?? 0;
    await win.getByRole('button', { name: 'Zoom out' }).click();
    await expect
      .poll(async () => (await inspect(win))?.cameraHeight ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(from * 1.8);
    await frames(win);
  }
  await expect.poll(groups, { timeout: SETTLE_MS }).toEqual([{ count: 2, sites: pair }]);
  // the gathered chip lies between its sites and answers the pointer as one thing
  const between = async (): Promise<[number, number]> => {
    const [ax, ay] = await pinInWindow(win, SITE_A.id);
    const [tx, ty] = await pinInWindow(win, TINY_PROJECT_ID);
    return [(ax + tx) / 2, (ay + ty) / 2];
  };
  const hoverOf = async () => (await inspect(win))?.hover ?? null;
  const northUp = await between();
  await pointAt(win, ...northUp);
  await expect.poll(hoverOf, { timeout: 15_000 }).toEqual({ kind: 'cluster', count: 2 });
  // its words are on the chip: no label is added under the pointer
  await expect(win.getByTestId('globe-tag-hover')).toHaveText('');
  // neither site answers at its own place while it is gathered
  for (const id of pair) {
    const [x, y] = await pinInWindow(win, id);
    if (Math.hypot(x - northUp[0], y - northUp[1]) < 40) continue; // under the gathered chip
    await pointAt(win, x, y);
    await frames(win);
    expect((await hoverOf())?.kind ?? 'nothing', `what is at the place of ${id}`).not.toBe('site');
  }

  // with south up the two change sides, and still share one chip
  const [aBefore] = await pinInWindow(win, SITE_A.id);
  const [tBefore] = await pinInWindow(win, TINY_PROJECT_ID);
  await faceSouth(win);
  const [aAfter] = await pinInWindow(win, SITE_A.id);
  const [tAfter] = await pinInWindow(win, TINY_PROJECT_ID);
  expect(Math.sign(aAfter - tAfter)).toBe(-Math.sign(aBefore - tBefore));
  await expect.poll(groups, { timeout: SETTLE_MS }).toEqual([{ count: 2, sites: pair }]);

  // a click on the gathered chip flies in until they part: each is its own chip again
  const southUp = await between();
  await pointAt(win, ...southUp);
  await expect.poll(hoverOf, { timeout: 15_000 }).toEqual({ kind: 'cluster', count: 2 });
  await win.mouse.click(...southUp);
  await expect.poll(groups, { timeout: SETTLE_MS }).toEqual([]);
  await settle(win, 'the flight to the two sites ended', (s) => !s.flying);
  await frames(win);
  for (const id of pair) {
    expect(await gathered(win, id)).toBe(false);
    const [x, y] = await pinInWindow(win, id);
    await pointAt(win, x, y);
    await expect.poll(hoverOf, { timeout: 15_000 }).toEqual({ kind: 'site', projectId: id });
  }
});

test("the Globe's controls fit the smallest window", async ({ win }) => {
  await openGlobe(win);
  await settle(win, 'the opening flight ended', (s) => !s.flying);
  const globe = await globeBox(win);
  // at rest: the field in the middle of the top edge, Map at its end, the four view buttons
  // (Measure first) and the credits along the bottom, each inside the Globe and clear of the rest
  expectLaidOut(globe, await edgePieces(win));
  await expectClearOfTitleBar(win);
  const view = win.getByRole('group', { name: 'Globe view' }).getByRole('button');
  await expect(view).toHaveCount(4);
  const names: (string | null)[] = [];
  for (const button of await view.all()) {
    expect(within(await boxOf(button, 'a view button'), globe)).toBe(true);
    names.push(await button.getAttribute('aria-label'));
  }
  expect(names).toEqual(['Measure on the ellipsoid', 'Zoom in', 'Zoom out', 'Show all sites']);
  // nothing of it covers the middle of the Globe
  await expectGlobeAt(win, globe.x + globe.width / 2, globe.y + globe.height / 2);

  // the field's list and the Map dialog open inside the Globe too
  const list = await openSiteList(win);
  expect(within(await boxOf(list, 'the list of sites'), globe)).toBe(true);
  await win.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  const map = await openMap(win);
  const dialog = await boxOf(map, 'the Map dialog');
  expect(within(dialog, globe), `the Map dialog (${edges(dialog)}) inside the Globe`).toBe(true);
  const field = await boxOf(win.locator('.globe-search-in'), 'the Find a site field');
  expect(overlap(dialog, field), 'the Map dialog overlaps the field').toBe(false);
  await closeMap(win);

  // a selected site's card, wherever its pin is: in the middle after the flight, then with the
  // pin slid into the lower right corner (where the view buttons are) and the upper right one
  // (under the Map button), the card stays inside the Globe and clear of every control
  await flyToSite(win, SITE_A.name);
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.96, 0.94],
    [0.97, 0.05],
    [0.45, 0.04],
    [0.03, 0.95],
  ] as const) {
    await putPinAt(win, SITE_A.id, fx, fy);
    expectLaidOut(globe, { ...(await edgePieces(win)), 'the card': await cardBox(win) });
  }
  // and what is not under the card still takes the pointer
  await expectGlobeAt(win, globe.x + globe.width * 0.25, globe.y + globe.height * 0.4);

  // while measuring, the read-out stands where the field was, clear of the Map button
  await win.getByRole('button', { name: 'Measure on the ellipsoid' }).click();
  await expect(findField(win)).toHaveCount(0);
  expectLaidOut(globe, await edgePieces(win));
});

test('the keyboard alone reaches a site and the map settings', async ({ win }) => {
  await openGlobe(win);
  await settle(win, 'the opening flight ended', (s) => !s.flying);
  // the field: part of a name, Down to the match, Enter
  await findField(win).focus();
  const list = win.getByTestId('globe-sites');
  await expect(list.getByRole('option')).toHaveCount(3);
  await win.keyboard.type('site b');
  await expect(list.getByRole('option')).toHaveCount(1);
  await win.keyboard.press('ArrowDown');
  await expect(list.getByRole('option', { name: new RegExp(SITE_B.name) })).toHaveAttribute(
    'data-active',
    'true',
  );
  // the row the keyboard is on lights its chip, as the pointer does
  await expect(win.getByTestId('globe-tag-hover')).toContainText(SITE_B.name);
  await win.keyboard.press('Enter');
  const card = win.getByTestId('globe-card');
  await expect(card).toContainText(SITE_B.name);
  await expect(list).toHaveCount(0);
  await expect(findField(win)).toHaveValue('');
  await settle(win, 'the flight to site B ended', (s) => !s.flying && s.cameraHeight < 5000);
  expect((await inspect(win))?.selected).toBe(SITE_B.id);

  // Tab goes on to Map; Enter opens its dialog with the focus inside, Esc gives it back
  await win.keyboard.press('Tab');
  const mapButton = win.getByTestId('globe-map-button');
  await expect(mapButton).toBeFocused();
  await win.keyboard.press('Enter');
  const map = win.getByTestId('globe-map-menu');
  await expect(map).toBeVisible();
  await expect(mapButton).toHaveAttribute('aria-expanded', 'true');
  await expect(map.locator(':focus')).toHaveCount(1);
  await win.keyboard.press('Escape');
  await expect(map).toHaveCount(0);
  await expect(mapButton).toBeFocused();
  // the site's card is still open, and is the next stop
  await expect(card).toContainText(SITE_B.name);
  await win.keyboard.press('Tab');
  await expect(card.locator(':focus')).toHaveCount(1);
  // Esc in the card closes it
  await win.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
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
  const box = await boxOf(win.getByTestId('globe-canvas'), 'the Globe');
  // the pin is drawn (its severity red): billboard images load a frame late
  const drawnRed = async () => {
    const [x, y] = (await pinAt()) ?? [0, 0];
    const [r = 0, g = 255] = (await sampleAt(win, x / box.width, y / box.height)) ?? [];
    return r > 180 && g < 110;
  };
  const card = win.getByTestId('globe-card');
  // the project's own title bar chips (Processing, Share) are over the Globe now: the field and
  // the Map button keep out of them too
  await expect(processingChip(win)).toBeVisible();
  await expectClearOfTitleBar(win);

  // from the height of the flight the pin stands clear of its site's chip
  await expect.poll(drawnRed, { timeout: 15_000 }).toBe(true);
  let [x, y] = (await pinAt()) ?? [0, 0];
  await expectGlobeAt(win, box.x + x, box.y + y);
  await win.mouse.click(box.x + x, box.y + y);
  await expect(card).toContainText('F01 Corrosion on the tank');
  // the card is the issue's, by the issue's pin and inside the Globe
  const placed = await cardBox(win);
  expect(within(placed, await globeBox(win)), `the card (${edges(placed)}) inside the Globe`).toBe(
    true,
  );
  expectByPin(placed, [box.x + x, box.y + y]);
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toHaveCount(0);

  // from further out the pin lies on the chip of its site (which runs east of the site's dot):
  // it is still drawn over the chip, and it is the pin that answers the pointer, not the chip
  const onChip = async () => {
    const [sx, sy] = (await pinOf(win, SITE_A.id)) ?? [0, 0];
    const [ix, iy] = (await pinAt()) ?? [0, 0];
    return ix - sx > 4 && ix - sx < 60 && Math.abs(iy - sy) < 11;
  };
  for (let step = 0; step < 4 && !(await onChip()); step++) {
    const from = (await inspect(win))?.cameraHeight ?? 0;
    await win.getByRole('button', { name: 'Zoom out' }).click();
    await expect
      .poll(async () => (await inspect(win))?.cameraHeight ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(from * 1.8);
    await frames(win);
  }
  expect(await onChip(), "the issue pin lies on its site's chip").toBe(true);
  await expect.poll(drawnRed, { timeout: 15_000 }).toBe(true);
  [x, y] = (await pinAt()) ?? [0, 0];
  await pointAt(win, box.x + x, box.y + y);
  await expect
    .poll(async () => (await inspect(win))?.hover, { timeout: 15_000 })
    .toEqual({ kind: 'issue', projectId: SITE_A.id, issueId: majorIssue.id });
  await expect(win.getByTestId('globe-tag-hover')).toContainText('F01 Corrosion on the tank');
  await win.mouse.click(box.x + x, box.y + y);
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
  // the read-out stands where the field was, and the selected site's card has closed
  await expect(findField(win)).toHaveCount(0);
  await expect(win.getByTestId('globe-card')).toHaveCount(0);
  const box = await win.getByTestId('globe-canvas').boundingBox();
  const at = async (fx: number, fy: number) => {
    const x = (box?.x ?? 0) + (box?.width ?? 0) * fx;
    const y = (box?.y ?? 0) + (box?.height ?? 0) * fy;
    // the read-out, the view buttons and the credits leave this part of the Globe free
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

// ---------------------------------------------------------------- online satellite

test.describe('online satellite on the Globe', () => {
  // No test reaches the network: main answers with its stand-in (flat green tiles made in main,
  // the addresses it would have asked for kept in `__aioOnlineTileRequests`), as in
  // online-satellite.spec.ts. The zero-network guard of the fixtures runs as on every test.
  test.use({ appEnv: { QUADRION_ONLINE_TILES_TEST: '1' } });

  /** How many tiles main's stand-in for the service was asked for. */
  const asked = (app: ElectronApplication) =>
    app.evaluate(
      () =>
        (globalThis as { __aioOnlineTileRequests?: string[] }).__aioOnlineTileRequests?.length ?? 0,
    );
  const layers = async (win: Page) => (await inspect(win))?.layers ?? null;
  const HINT = 'Turn on Online satellite in the map type menu to see imagery everywhere.';

  test('the Satellite look draws it once it is switched on, under the packs, and only then', async ({
    app,
    win,
    dataRoot,
    network,
  }) => {
    await installSyntheticPacks(dataRoot);
    await openGlobe(win);
    const credits = win.getByTestId('globe-credits');
    // switched off (as a new profile is): the Satellite look is the packs alone
    await setLook(win, 'satellite');
    await expect
      .poll(() => layers(win), { timeout: SETTLE_MS })
      .toEqual(['earth-shapes:whole', 'pack:syn-imagery']);
    await expect(credits).not.toContainText(ONLINE_SATELLITE.attribution);
    expect(await asked(app)).toBe(0);

    // The person's switch (the map type menu, Settings, the palette) is held by main: switch it
    // on there and come back to the Globe, which asks main how it stands when it opens.
    const on = await win.evaluate(() =>
      window.aio.invoke('onlineTiles:setSatellite', { on: true }),
    );
    expect(on).toMatchObject({ ok: true, satellite: true });
    await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).click();
    await expect(win.getByTestId('globe-canvas')).toHaveCount(0);
    await openGlobe(win);
    // the look was remembered; the online imagery lies over the Earth and under the pack
    await expect
      .poll(() => layers(win), { timeout: SETTLE_MS })
      .toEqual(['earth-shapes:whole', 'online-satellite', 'pack:syn-imagery']);
    await expect(credits).toContainText(ONLINE_SATELLITE.attribution);
    await expect(credits).toContainText('Synthetic imagery test pack');
    // the Map dialog opens on the look that was remembered, with no hint to switch it on
    const map = await openMap(win);
    await expect(win.getByTestId('globe-look-satellite')).toHaveAttribute('aria-pressed', 'true');
    await expect(map.getByText(HINT)).toHaveCount(0);
    await closeMap(win);
    // its tiles come through main (the stand-in here) and draw: green well over red and blue,
    // whatever the GPU and the Globe's light make of the exact shade
    await expect.poll(() => asked(app), { timeout: SETTLE_MS }).toBeGreaterThan(0);
    await expect
      .poll(
        async () => {
          const spots = await Promise.all([sampleAt(win, 0.55, 0.4), sampleAt(win, 0.7, 0.6)]);
          return spots.some(([r = 0, g = 0, b = 0] = []) => g > r + 30 && g > b + 30);
        },
        { timeout: SETTLE_MS },
      )
      .toBe(true);

    // never in the other looks
    await setLook(win, 'street');
    await expect.poll(() => layers(win), { timeout: SETTLE_MS }).toEqual(['earth-shapes:whole']);
    await expect(credits).not.toContainText(ONLINE_SATELLITE.attribution);
    await setLook(win, 'natural-earth');
    await expect
      .poll(() => layers(win), { timeout: SETTLE_MS })
      .toEqual(['natural-earth-ii', 'pack:syn-imagery']);
    await expect(credits).not.toContainText(ONLINE_SATELLITE.attribution);
    // and nothing left the computer: not from the page, not from main
    expect(await network.outbound()).toEqual([]);
  });

  test('without it and without a pack, the Satellite look says where to switch it on', async ({
    app,
    win,
  }) => {
    await openGlobe(win);
    // the Map dialog stays open after a choice, and says what the look lacks
    const map = await chooseLook(win, 'satellite');
    await expect
      .poll(async () => (await inspect(win))?.style, { timeout: SETTLE_MS })
      .toBe('satellite');
    await expect.poll(() => layers(win), { timeout: SETTLE_MS }).toEqual(['earth-shapes:whole']);
    await expect(map.getByText(HINT)).toBeVisible();
    await expect(win.getByTestId('globe-credits')).not.toContainText(ONLINE_SATELLITE.attribution);
    expect(await asked(app)).toBe(0);
  });
});
