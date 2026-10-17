/**
 * Online map sources (plan 2026-10-14-satellite-providers; ADR 0007, amendment of 14 Oct 2026):
 * Esri and Mapbox through main, keys per computer, one Map menu in the three views.
 *
 * No test reaches a provider: main's stand-in (QUADRION_ONLINE_TILES_TEST=1) makes flat green
 * tiles and keeps the addresses it would have asked for in `__aioOnlineTileRequests`; the
 * zero-network guard of the fixtures still fails a test on any real request.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { stageMode } from './island';

test.use({ appEnv: { QUADRION_ONLINE_TILES_TEST: '1' } });
test.setTimeout(240_000);

const ESRI =
  /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/;
const TOKEN = 'pk.e2e-fake-token-0123456789';
const ESRI_CREDIT = 'Powered by Esri';

const asked = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(
    () =>
      (globalThis as { __aioOnlineTileRequests?: string[] }).__aioOnlineTileRequests?.slice() ?? [],
  );

const tileStatus = (win: Page, path: string) =>
  win.evaluate(async (url) => {
    const res = await fetch(url);
    return { status: res.status, why: res.headers.get('x-aio-online') };
  }, `aio://online/${path}`);

async function openProject(win: Page, view: '3D' | 'Map'): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await stageMode(win, view);
}

async function openSettings(win: Page, page: string): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: page }).click();
  await expect(win.locator('.set-page h1')).toHaveText(page);
}

/** The main map's sources (MapLibre), or null before it runs. */
const mapSources = (win: Page) =>
  win.evaluate(() => {
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      | {
          __aioMap: {
            getStyle():
              { sources: Record<string, { tileSize?: number; attribution?: string }> } | undefined;
          };
        }
      | undefined;
    return host?.__aioMap.getStyle()?.sources ?? null;
  });

/** Confirm the provider's notice in the open menu. */
async function confirmNotice(win: Page, pop: string, provider: string): Promise<void> {
  const notice = win.getByTestId(pop).getByTestId('online-satellite-notice');
  await expect(notice).toHaveAttribute('data-provider', provider);
  await notice.getByRole('button', { name: 'Switch on' }).click();
  await expect(notice).toHaveCount(0);
}

/**
 * Close the open menu with Esc. Esc belongs to the menu while the focus is inside it; the
 * notice's button that was just pressed is gone, so the focus goes back to the picked tile first.
 */
async function closeMenu(win: Page, pop: string): Promise<void> {
  const menu = win.getByTestId(pop);
  if (!(await menu.locator(':focus').count()))
    await menu.locator('[role="radio"][tabindex="0"]').focus();
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

test('picking Esri in the Map view asks once, draws it through main and credits it', async ({
  app,
  win,
  network,
}) => {
  await openProject(win, 'Map');
  const chip = win.getByTestId('basemap-button');
  await chip.click();
  const esri = win.getByTestId('map-tile-esri-world-imagery');
  await expect(esri).toBeEnabled();
  await esri.click();
  // nothing is asked before the person says yes
  expect(await asked(app)).toEqual([]);
  await confirmNotice(win, 'basemap-pop', 'esri');
  await expect(esri).toHaveAttribute('aria-checked', 'true');
  await expect(chip).toContainText('Esri');
  await expect
    .poll(
      async () => (await mapSources(win))?.['g7-raster-online-esri-world-imagery']?.attribution,
      { timeout: 30_000 },
    )
    .toContain(ESRI_CREDIT);
  await expect(win.getByTestId('map-menu-credit')).toContainText(ESRI_CREDIT);
  await closeMenu(win, 'basemap-pop');
  await expect(win.locator('.pane-map .maplibregl-ctrl-attrib')).toContainText(ESRI_CREDIT);
  // main asked the public Esri service only (no key saved), and nothing left the computer
  await expect.poll(async () => (await asked(app)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  for (const url of await asked(app)) expect(url).toMatch(ESRI);
  expect(await network.outbound()).toEqual([]);
});

test('a Mapbox style without a key is greyed with the reason; a key in Map sources enables it', async ({
  app,
  win,
  network,
}) => {
  await openProject(win, 'Map');
  const chip = win.getByTestId('basemap-button');
  await chip.click();
  const style = win.getByTestId('map-tile-mapbox-streets');
  await expect(style).toBeDisabled();
  await expect(win.getByTestId('map-menu-note-mapbox')).toContainText('Add a key in Map sources');
  // Mapbox without a key is refused by main too, without a request
  await win.evaluate(() => window.aio.invoke('onlineTiles:set', { enabled: true }));
  expect(await tileStatus(win, 'mapbox-streets/3/4/2')).toEqual({ status: 401, why: 'no-key' });
  expect(await asked(app)).toEqual([]);

  // the way to Map sources is in the menu
  await win.getByTestId('map-menu-add-key-mapbox').click();
  await expect(win.locator('.set-page h1')).toHaveText('Map sources');
  const row = win.getByTestId('map-source-mapbox');
  await expect(row.getByTestId('map-source-status-mapbox')).toHaveText('No key');
  // the key check is disclosed beside the key: it asks the provider for one tile
  await expect(row.getByTestId('map-key-mapbox')).toHaveAccessibleDescription(
    'Saving or testing a key asks Mapbox for one tile to check it.',
  );
  await row.getByTestId('map-key-mapbox').fill(TOKEN);
  await row.getByTestId('map-key-save-mapbox').click();
  await expect(row.getByTestId('map-key-msg-mapbox')).toHaveText(
    'The key is saved on this computer.',
  );
  await expect(row.getByTestId('map-source-status-mapbox')).toHaveText('Key saved');
  await expect(row.getByTestId('map-key-mapbox')).toHaveValue('');
  // main checked it with one tile, the key added in main
  expect(
    (await asked(app)).some(
      (u) => u.startsWith('https://api.mapbox.com/') && u.includes(`access_token=${TOKEN}`),
    ),
  ).toBe(true);

  await openProject(win, 'Map');
  await chip.click();
  await expect(style).toBeEnabled();
  await style.click();
  await confirmNotice(win, 'basemap-pop', 'mapbox');
  await expect
    .poll(async () => (await mapSources(win))?.['g7-raster-online-mapbox-streets']?.tileSize, {
      timeout: 30_000,
    })
    .toBe(512);
  // a map with its own street names: ours are off and say why
  await expect(win.getByTestId('map-ontop-streets')).toContainText(
    'This map has its own street names',
  );
  await closeMenu(win, 'basemap-pop');
  // the token never reaches the page: not in its markup, not in the addresses it loaded
  const leaked = await win.evaluate(
    (token) =>
      document.documentElement.outerHTML.includes(token) ||
      performance.getEntriesByType('resource').some((e) => e.name.includes(token)),
    TOKEN,
  );
  expect(leaked).toBe(false);
  expect(await network.outbound()).toEqual([]);
});

test('the Globe picks Esri from the same menu', async ({ app, win, network }) => {
  await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
  await expect(win.getByTestId('globe-canvas').locator('canvas')).toBeVisible();
  await win.getByTestId('globe-map-button').click();
  const esri = win.getByTestId('globe-map-menu').getByTestId('map-tile-esri-world-imagery');
  await esri.click();
  await confirmNotice(win, 'globe-map-menu', 'esri');
  await expect
    .poll(
      () =>
        win.evaluate(() => {
          const el = document.querySelector('[data-testid="globe-canvas"]');
          const c = (el as { __aioGlobe?: { inspect(): { layers: string[] } | null } } | null)
            ?.__aioGlobe;
          return c?.inspect()?.layers ?? null;
        }),
      { timeout: 120_000 },
    )
    .toContain('online:esri-world-imagery');
  await expect(win.getByTestId('globe-credits')).toContainText(ESRI_CREDIT, { timeout: 60_000 });
  await expect.poll(async () => (await asked(app)).length, { timeout: 120_000 }).toBeGreaterThan(0);
  for (const url of await asked(app)) expect(url).toMatch(ESRI);
  expect(await network.outbound()).toEqual([]);
});

test("the 3D scene's Map chip turns on imagery around the site from Esri", async ({
  app,
  win,
  network,
}) => {
  await openProject(win, '3D');
  // imagery around the site needs Medium graphics; CI's software GPU is detected as Low
  await win.evaluate(() => {
    const g = (
      window as unknown as {
        __stratlas: { graphics(): { getState(): { tier: string; setOverride(t: string): void } } };
      }
    ).__stratlas
      .graphics()
      .getState();
    if (g.tier === 'low') g.setOverride('medium');
  });
  const chip = win.getByTestId('scene-map-button');
  await chip.click();
  await expect(
    win.getByTestId('scene-map-pop').getByTestId('map-ontop-aroundImagery'),
  ).toBeVisible();
  await win.getByTestId('scene-map-pop').getByTestId('map-tile-esri-world-imagery').click();
  await confirmNotice(win, 'scene-map-pop', 'esri');
  await expect(chip).toContainText('Esri');
  await closeMenu(win, 'scene-map-pop');
  // the landscape asks main for Esri tiles at a detailed zoom around the site
  await expect
    .poll(
      async () =>
        (await asked(app)).filter((u) => ESRI.test(u) && Number(u.split('/').at(-3)) >= 12).length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  // the landscape is the ground now: the plain ground goes, as it does for the street map (it
  // lay over the imagery and, seen from far off, cut the view in half at a ragged line), and the
  // drone video's drape lands on the landscape instead
  await expect
    .poll(() => sceneGround(win), { timeout: 60_000 })
    .toEqual({ landscape: true, plain: false, drape: true });

  // from far off and low, toward the horizon: the whole ground below the horizon is the map
  const placed = await win.evaluate(() => {
    const s = (window as unknown as SceneProbe).__stratlas.stage();
    if (!s) return 'no stage';
    // let the camera back off 300 m from the tiny model, as on a real site
    const box = s.contentBounds();
    if (!box) return 'no content';
    const big = box.clone();
    big.min.set(-1500, 0, -1500);
    big.max.set(1500, 30, 1500);
    s.setReach('e2e-far', big);
    s.restoreView({ position: [0, 6, 300], target: [0, 0, 0] });
    return 'placed';
  });
  // the default camera would see the map below it whatever happens far off
  expect(placed).toBe('placed');
  const canvas = win.locator('[data-scene-view] canvas').first();
  await expect
    .poll(
      async () => {
        const png = (await canvas.screenshot()).toString('base64');
        // a column left of the model, from just under the horizon down to above the readouts
        return win.evaluate(async (b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext('2d');
          if (!ctx) return -1;
          ctx.drawImage(bmp, 0, 0);
          const x = Math.round(bmp.width * 0.35);
          let notMap = 0;
          for (let y = Math.round(bmp.height * 0.5); y < bmp.height * 0.88; y++) {
            const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
            // main's stand-in tiles are green; the plain ground is a dark grey
            if (!(
              g !== undefined &&
              r !== undefined &&
              b !== undefined &&
              g > r + 40 &&
              g > b + 40
            ))
              notMap++;
          }
          return notMap;
        }, png);
      },
      { timeout: 30_000 },
    )
    .toBe(0);

  // back to the street map (no street pack covers this site): the landscape goes, and the plain
  // ground and its drape come back
  await chip.click();
  await win.getByTestId('scene-map-pop').getByTestId('map-tile-streets').click();
  await expect(chip).not.toContainText('Esri');
  await closeMenu(win, 'scene-map-pop');
  await expect
    .poll(() => sceneGround(win), { timeout: 30_000 })
    .toEqual({ landscape: false, plain: true, drape: false });
  expect(await network.outbound()).toEqual([]);
});

interface SceneProbe {
  __stratlas: {
    stage(): {
      scene: { getObjectByName(n: string): { visible: boolean } | undefined };
      contentBounds(): {
        clone(): { min: { set(...v: number[]): void }; max: { set(...v: number[]): void } };
      } | null;
      setReach(key: string, box: unknown): void;
      projectionReceivers(): readonly { name: string }[];
      restoreView(v: { position: number[]; target: number[] }): void;
    } | null;
  };
}

/** Whether the landscape around the site and the plain ground are drawn, and which takes video. */
const sceneGround = (win: Page) =>
  win.evaluate(() => {
    const stage = (window as unknown as SceneProbe).__stratlas.stage();
    const scene = stage?.scene;
    return {
      landscape: scene?.getObjectByName('site-surroundings')?.visible === true,
      plain: scene?.getObjectByName('env:ground')?.visible ?? null,
      // projected video drapes onto the receivers: the landscape while it stands in for the ground
      drape: stage?.projectionReceivers().some((m) => m.name === 'site-surroundings') ?? false,
    };
  });

test('offline-only: online maps are greyed in the menu and main asks nobody', async ({
  app,
  win,
  network,
}) => {
  await openSettings(win, 'Privacy and cloud');
  const offline = win.getByRole('switch', { name: 'Offline-only workstation' });
  await offline.click();
  await expect(offline).toHaveAttribute('aria-checked', 'true');

  await openSettings(win, 'Map sources');
  await expect(win.getByTestId('map-sources-master').getByRole('switch')).toBeDisabled();
  await expect(win.getByTestId('map-sources')).toContainText(
    'This workstation is offline-only, so online maps cannot be switched on.',
  );

  await openProject(win, 'Map');
  await win.getByTestId('basemap-button').click();
  for (const id of ['esri-world-imagery', 'mapbox-satellite', 's2cloudless-2016', 'mapbox-dark'])
    await expect(win.getByTestId(`map-tile-${id}`)).toBeDisabled();
  await expect(win.getByTestId('map-menu-note-satellite')).toContainText(
    'This workstation is offline-only',
  );
  // main enforces it, even with the switch forced on behind the page's back
  expect(await tileStatus(win, 'esri-world-imagery/3/4/2')).toEqual({ status: 403, why: 'off' });
  await win.evaluate(() => window.aio.invoke('onlineTiles:set', { enabled: true }));
  expect(await tileStatus(win, 'esri-world-imagery/3/4/2')).toEqual({
    status: 404,
    why: 'offline-only',
  });
  expect(await asked(app)).toEqual([]);
  expect(await network.outbound()).toEqual([]);
});
