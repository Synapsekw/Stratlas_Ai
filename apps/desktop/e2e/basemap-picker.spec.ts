/**
 * The Map menu on the Map view (plan 2026-10-14-satellite-providers): the base maps as small
 * pictures, and On top the imagery packs, terrain shading and street names, chosen on the map
 * itself. On a synthetic site with imagery and terrain packs (the globe library, `m10Fixtures.ts`)
 * the pack layers come and go as the switches change, the camera stays where it was and the
 * choice survives a relaunch; on a site no pack covers, the pack switches are greyed with the
 * reason and the menu has a way to Settings, Map sources.
 * Zero network: the packs are files in the data root, and both launches are checked.
 *
 * Online maps are tiles of the same menu (the last two tests): Sentinel-2 draws where no pack
 * covers the site. Main stands in for the service there; nothing is fetched.
 */
import { ONLINE_SATELLITE } from '@aio/schema';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { expectAccessible } from './a11y';
import { expect, launchApp, NetworkGuard, test } from './fixtures';
import { stageMode } from './island';

// two launches in the first test, a theme change in the last: room for a slow runner
test.setTimeout(180_000);

const SITE_A = 'Globe site A (synthetic, open desert)';
const WORLD = 'g7-raster-imagery-synthetic-world-layer';
const DETAIL = 'g7-raster-imagery-synthetic-site-a-layer';
const HILLSHADE = 'g7-raster-hillshade';

interface MapProbe {
  getStyle(): { layers: { id: string; type: string; source?: string }[] } | undefined;
  getLayoutProperty(layer: string, name: string): unknown;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
}

/** The main map of the open project: its pack layers, hidden street layers and camera. */
const mapState = (win: Page) =>
  win.evaluate(() => {
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      { __aioMap: MapProbe } | undefined;
    const map = host?.__aioMap;
    const style = map?.getStyle();
    if (!map || !style) return null;
    const streets = style.layers.filter(
      (l) => l.source === 'basemap' && (l.type === 'line' || l.type === 'symbol'),
    );
    const c = map.getCenter();
    return {
      packs: style.layers.filter((l) => l.id.startsWith('g7-raster-')).map((l) => l.id),
      streets: streets.length,
      hidden: streets.filter((l) => map.getLayoutProperty(l.id, 'visibility') === 'none').length,
      camera: [c.lng.toFixed(6), c.lat.toFixed(6), map.getZoom().toFixed(3)].join(' '),
    };
  });

const packs = (win: Page) => mapState(win).then((s) => s?.packs ?? null);

/** How many street lines and names are drawn (not hidden). */
const shownStreets = async (win: Page) => {
  const s = await mapState(win);
  return s ? s.streets - s.hidden : -1;
};

/** A map that was just created (a view change, back from Settings) loads its style first. */
const MAP_READY = { timeout: 30_000 };

/** One On top switch of the open Map menu. */
const onTop = (win: Page, key: string) => win.getByTestId(`map-ontop-${key}`).getByRole('switch');

/** Switch the stage with the island's view switch. */
async function showView(win: Page, view: '3D' | 'Map'): Promise<void> {
  await stageMode(win, view);
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', view === '3D' ? '3d' : 'map');
}

async function openMap(win: Page, project: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: project }).click();
  await showView(win, 'Map');
  await expect(win.getByTestId('basemap-button')).toBeVisible();
}

/**
 * Close an open Map menu with Esc. Esc belongs to the menu while the focus is inside it; a
 * notice's button that was just pressed is gone, so the focus goes back to the picked tile first.
 */
async function closeMenu(win: Page, pop: string): Promise<void> {
  const menu = win.getByTestId(pop);
  if (!(await menu.locator(':focus').count()))
    await menu.locator('[role="radio"][tabindex="0"]').focus();
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

async function shot(win: Page, testInfo: TestInfo, name: string): Promise<void> {
  // two frames, so the popover is placed and the map has drawn
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  // the menu fades in over 160 ms: finished animations, so it is shot opaque
  await win.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled' });
}

test('the Map menu works on the map, keeps the camera and survives a relaunch', async ({
  dataRoot,
  globeLibrary,
}, testInfo) => {
  expect(globeLibrary.imagery.map((p) => p.id)).toEqual(['synthetic-world', 'synthetic-site-a']);

  const guard = new NetworkGuard();
  const first = await launchApp(dataRoot);
  try {
    await guard.attach(first);
    const win = await first.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await openMap(win, SITE_A);

    // packs cover the site: the street map as the base, the packs on top under the hillshade
    const chip = win.getByTestId('basemap-button');
    await expect(chip).toHaveText('Streets');
    await expect.poll(() => packs(win), { timeout: 30_000 }).toEqual([WORLD, DETAIL, HILLSHADE]);
    // the map has gone to the site and stopped there
    let last = '';
    await expect
      .poll(async () => {
        const now = (await mapState(win))?.camera ?? '';
        const still = now === last && !now.startsWith('-0.0') && !now.startsWith('0.0');
        last = now;
        return still;
      })
      .toBe(true);
    const before = await mapState(win);
    expect(before?.streets).toBeGreaterThan(10);
    expect(before?.hidden).toBe(0);

    await chip.click();
    const pop = win.getByTestId('basemap-pop');
    await expect(pop).toBeVisible();
    await expect(win.getByTestId('map-tile-streets')).toHaveAttribute('aria-checked', 'true');
    await expect(win.getByTestId('map-tile-streets')).toBeFocused();
    await expect(onTop(win, 'packs')).toHaveAttribute('aria-checked', 'true');
    await shot(win, testInfo, 'menu-packs');
    await expectAccessible(win, 'Map with the Map menu open');

    // imagery packs off: the imagery goes, the hillshade and the camera stay
    await onTop(win, 'packs').click();
    await expect(onTop(win, 'packs')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => packs(win)).toEqual([HILLSHADE]);
    expect((await mapState(win))?.camera).toBe(before?.camera);
    await expect(chip).toHaveText('Streets');
    await shot(win, testInfo, 'menu-streets');

    // packs on and the street names off: the imagery is back and the streets over it are hidden
    await onTop(win, 'packs').click();
    await expect.poll(() => packs(win)).toEqual([WORLD, DETAIL, HILLSHADE]);
    await onTop(win, 'streets').click();
    await expect(onTop(win, 'streets')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => shownStreets(win)).toBe(0);
    await shot(win, testInfo, 'menu-packs-only');

    // one pack of the two that cover the site, then the best available again
    const pack = win.getByTestId('map-pack');
    await expect(pack.locator('option')).toHaveText([
      'Best available',
      'Synthetic imagery, site A (test)',
      'Synthetic world (test)',
    ]);
    await pack.selectOption('synthetic-site-a');
    await expect.poll(() => packs(win)).toEqual([DETAIL, HILLSHADE]);
    await pack.selectOption('');
    await expect.poll(() => packs(win)).toEqual([WORLD, DETAIL, HILLSHADE]);

    // terrain shading off and on leaves the imagery alone
    const shading = onTop(win, 'hillshade');
    await expect(shading).toHaveAttribute('aria-checked', 'true');
    await shading.click();
    await expect.poll(() => packs(win)).toEqual([WORLD, DETAIL]);
    await shading.click();
    await expect(shading).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => packs(win)).toEqual([WORLD, DETAIL, HILLSHADE]);

    // the street names back on: they return, the camera stays
    await onTop(win, 'streets').click();
    await expect.poll(async () => (await mapState(win))?.hidden).toBe(0);
    expect((await mapState(win))?.camera).toBe(before?.camera);

    // by keyboard: the next map is Esri, which asks first in the menu; Cancel keeps the streets
    await win.getByTestId('map-tile-streets').focus();
    await win.keyboard.press('ArrowRight');
    const notice = pop.getByTestId('online-satellite-notice');
    await expect(notice).toHaveAttribute('data-provider', 'esri');
    await notice.getByRole('button', { name: 'Cancel' }).click();
    await expect(notice).toHaveCount(0);
    await expect(chip).toHaveText('Streets');
    await expect(win.getByTestId('map-tile-streets')).toHaveAttribute('aria-checked', 'true');
    // Escape closes and focus goes to the chip
    await win.getByTestId('map-tile-streets').focus();
    await win.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await expect(chip).toBeFocused();

    // Settings shows the same choice, and its checkbox moves the packs switch
    await chip.click();
    await onTop(win, 'packs').click();
    await expect.poll(() => packs(win)).toEqual([HILLSHADE]);
    await closeMenu(win, 'basemap-pop');
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: 'Offline maps' }).click();
    await expect(win.locator('.set-page h1')).toHaveText('Offline maps');
    const satellite = win
      .getByTestId('raster-packs')
      .getByRole('checkbox', { name: /^Satellite: imagery packs/ });
    await expect(satellite).not.toBeChecked();
    await satellite.check();
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await expect.poll(() => packs(win), MAP_READY).toEqual([WORLD, DETAIL, HILLSHADE]);
    await chip.click();
    await expect(onTop(win, 'packs')).toHaveAttribute('aria-checked', 'true');
    await closeMenu(win, 'basemap-pop');

    // the 3D view's part: imagery and terrain around the site, in its own Map menu
    await showView(win, '3D');
    await expect(chip).toHaveCount(0);
    await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible(MAP_READY);
    await win.getByTestId('scene-map-button').click();
    const scenePop = win.getByTestId('scene-map-pop');
    await expect(scenePop.getByTestId('map-ontop-aroundImagery')).toBeVisible();
    await expect(scenePop.getByTestId('map-ontop-aroundTerrain')).toBeVisible();
    await shot(win, testInfo, 'scene-map-menu');
    await closeMenu(win, 'scene-map-pop');

    // the command search has the base maps too; an online one asks first, in Map sources
    await win.keyboard.press('Control+K');
    const palette = win.getByRole('dialog', { name: 'Command search' });
    await expect(palette).toBeVisible();
    await win.keyboard.type('map: sentinel');
    await expect(palette.getByText('Map: Sentinel-2')).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(win.locator('.set-page h1')).toHaveText('Map sources');
    const eox = win.getByTestId('map-sources').getByTestId('online-satellite-notice');
    await expect(eox).toHaveAttribute('data-provider', 'eox');
    await eox.getByRole('button', { name: 'Cancel' }).click();
    await expect(eox).toHaveCount(0);
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'map');
    await expect(chip).toHaveText('Streets');

    // leave the packs off for the relaunch
    await chip.click();
    await expect(pop).toBeVisible();
    await onTop(win, 'packs').click();
    await expect.poll(() => packs(win), MAP_READY).toEqual([HILLSHADE]);
    await closeMenu(win, 'basemap-pop');
    expect(await guard.outbound(), 'the app made network requests').toEqual([]);
  } finally {
    await first.close();
  }

  const guard2 = new NetworkGuard();
  const second = await launchApp(dataRoot);
  try {
    await guard2.attach(second);
    const win = await second.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await openMap(win, SITE_A);
    await expect(win.getByTestId('basemap-button')).toHaveText('Streets');
    await expect.poll(() => packs(win), { timeout: 30_000 }).toEqual([HILLSHADE]);
    // and it stays that way once the packs are listed and the map has settled
    await win.waitForTimeout(1500);
    expect(await packs(win)).toEqual([HILLSHADE]);
    await win.getByTestId('basemap-button').click();
    await expect(win.getByTestId('map-tile-streets')).toHaveAttribute('aria-checked', 'true');
    await expect(onTop(win, 'packs')).toHaveAttribute('aria-checked', 'false');
    expect(await guard2.outbound(), 'the app made network requests').toEqual([]);
  } finally {
    await second.close();
  }
});

test('imagery packs and shading are greyed with the reason when no pack covers the site', async ({
  win,
}, testInfo) => {
  // the tiny project's data root has no imagery or terrain pack
  await openMap(win, 'E2E tiny project');
  const chip = win.getByTestId('basemap-button');
  await expect(chip).toHaveText('Streets');
  await chip.click();
  await expect(win.getByTestId('map-tile-streets')).toHaveAttribute('aria-checked', 'true');
  await expect(onTop(win, 'packs')).toBeDisabled();
  await expect(onTop(win, 'hillshade')).toBeDisabled();
  await expect(win.getByTestId('map-ontop-packs')).toContainText(
    'No imagery pack covers this site',
  );
  await expect(win.getByTestId('map-ontop-hillshade')).toContainText(
    'No terrain pack covers this site',
  );
  await expect(win.getByTestId('map-pack')).toHaveCount(0);
  // the style may still be loading on a slow renderer: wait for it, then no pack layer is drawn
  await expect.poll(() => packs(win), MAP_READY).toEqual([]);
  await shot(win, testInfo, 'menu-no-packs');
  await expectAccessible(win, 'Map menu without packs');

  // never an error: the way to the map sources is one click
  await win.getByTestId('map-sources-link').click();
  await expect(win.locator('.set-page h1')).toHaveText('Map sources');
  await expect(win.getByTestId('map-sources')).toBeInViewport();
});

test('a site covered by imagery but no terrain pack offers the packs without shading', async ({
  globeLibrary,
  win,
}, testInfo) => {
  // site B lies under the world imagery only: no detailed pack, no terrain
  const site = globeLibrary.sites.find((s) => s.id === 'globe-site-b');
  await openMap(win, site?.name ?? '');
  const chip = win.getByTestId('basemap-button');
  await expect(chip).toHaveText('Streets');
  await expect.poll(() => packs(win), { timeout: 30_000 }).toEqual([WORLD, DETAIL]);
  await chip.click();
  await expect(onTop(win, 'packs')).toBeEnabled();
  await expect(onTop(win, 'packs')).toHaveAttribute('aria-checked', 'true');
  await expect(onTop(win, 'hillshade')).toBeDisabled();
  await expect(win.getByTestId('map-ontop-hillshade')).toContainText(
    'No terrain pack covers this site',
  );
  // one covering pack: the best available or that one
  await expect(win.getByTestId('map-pack').locator('option')).toHaveCount(2);

  // in the light theme the menu stays dark, as everything that sits on the map, and readable
  await closeMenu(win, 'basemap-pop');
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Appearance' }).click();
  await win.getByRole('radio', { name: 'Light', exact: true }).click();
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
  await win.locator('.nav-item', { hasText: 'Scene' }).click();
  await shot(win, testInfo, 'chip-light-theme');
  await chip.click();
  await expect(win.getByTestId('basemap-pop')).toBeVisible();
  await shot(win, testInfo, 'menu-light-theme');
  await expectAccessible(win, 'Map menu in the light theme');
});

// ------------------------------------------------------------------ Online maps in the menu

/**
 * Online maps (ADR 0007, amendments of 10 and 14 Oct 2026) as tiles of the Map menu. No test
 * reaches the network: main stands in for the service (QUADRION_ONLINE_TILES_TEST=1, flat green
 * tiles made in main), and the zero-network guard of the fixtures still fails the test on any
 * real request.
 */
test.describe('Online maps in the menu', () => {
  test.use({ appEnv: { QUADRION_ONLINE_TILES_TEST: '1' } });

  const ONLINE = 'g7-raster-online-s2cloudless-2016-layer';
  const EOX =
    /^https:\/\/tiles\.maps\.eox\.at\/wmts\/1\.0\.0\/s2cloudless_3857\/default\/GoogleMapsCompatible\/\d+\/\d+\/\d+\.jpg$/;
  const sentinel = (win: Page) => win.getByTestId('map-tile-s2cloudless-2016');
  const credit = (win: Page) => win.locator('.pane-map .maplibregl-ctrl-attrib');
  /** Whether main has online maps switched on. */
  const switchedOn = async (win: Page) =>
    (await win.evaluate(() => window.aio.invoke('onlineTiles:status', {}))).enabled;
  /** The addresses main's stand-in for the service was asked for. */
  const asked = (app: ElectronApplication) =>
    app.evaluate(
      () =>
        (globalThis as { __aioOnlineTileRequests?: string[] }).__aioOnlineTileRequests?.slice() ??
        null,
    );

  /** The commands the command search offers for `text`. */
  async function search(win: Page, text: string) {
    await win.keyboard.press('ControlOrMeta+K');
    const palette = win.getByRole('dialog', { name: 'Command search' });
    await expect(palette).toBeVisible();
    await win.keyboard.type(text);
    return palette;
  }

  async function settingsPage(win: Page, page: string): Promise<void> {
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: page }).click();
    await expect(win.locator('.set-page h1')).toHaveText(page);
  }

  /** Pick Sentinel-2 in the open menu the first time, and say yes to its notice. */
  async function switchOnSentinel(win: Page): Promise<void> {
    await sentinel(win).click();
    await win
      .getByTestId('basemap-pop')
      .getByTestId('online-satellite-notice')
      .getByRole('button', { name: 'Switch on' })
      .click();
    await expect(sentinel(win)).toHaveAttribute('aria-checked', 'true');
  }

  test('Sentinel-2 asks once, then draws where no pack covers the site', async ({
    app,
    win,
    network,
  }, testInfo) => {
    // the tiny project's data root has no imagery or terrain pack
    await openMap(win, 'E2E tiny project');
    const chip = win.getByTestId('basemap-button');
    await expect(chip).toHaveText('Streets');
    await chip.click();
    const pop = win.getByTestId('basemap-pop');
    await expect(sentinel(win)).toBeEnabled();
    await shot(win, testInfo, 'menu-online-off');
    await expectAccessible(win, 'Map menu, online maps off');

    // the first time: the notice, and nothing is on or asked for until the person says yes
    await sentinel(win).click();
    const notice = pop.getByTestId('online-satellite-notice');
    await expect(notice).toHaveAttribute('data-provider', 'eox');
    await expect(notice).toContainText("from EOX's servers");
    await expect(notice).toContainText('the areas you view are visible to that service');
    // the whole question is on screen, also in the smallest window (the menu scrolls there)
    await expect(notice).toBeInViewport({ ratio: 1 });
    await expect(notice.getByRole('button', { name: 'Switch on' })).toBeInViewport({ ratio: 1 });
    await expect(sentinel(win)).toHaveAttribute('aria-checked', 'false');
    expect(await switchedOn(win)).toBe(false);
    expect(await asked(app)).toEqual([]);
    await shot(win, testInfo, 'menu-online-notice');
    await expectAccessible(win, 'Map menu with the Sentinel-2 notice');
    await notice.getByRole('button', { name: 'Cancel' }).click();
    await expect(notice).toHaveCount(0);
    expect(await switchedOn(win)).toBe(false);

    // the second time: yes
    await sentinel(win).click();
    await notice.getByRole('button', { name: 'Switch on' }).click();
    await expect(notice).toHaveCount(0);
    await expect(sentinel(win)).toHaveAttribute('aria-checked', 'true');
    expect(await switchedOn(win)).toBe(true);
    await expect(chip).toHaveText('Sentinel-2');
    await expect.poll(() => packs(win), { timeout: 30_000 }).toEqual([ONLINE]);
    await expect(win.getByTestId('map-menu-credit')).toContainText(ONLINE_SATELLITE.attribution);
    await expect(credit(win)).toContainText(ONLINE_SATELLITE.attribution);
    await shot(win, testInfo, 'menu-online-on');
    await expectAccessible(win, 'Map menu, Sentinel-2 drawn');

    // the street names off: the imagery stays, credited, and the streets over it are hidden
    await onTop(win, 'streets').click();
    await expect.poll(() => shownStreets(win)).toBe(0);
    expect(await packs(win)).toEqual([ONLINE]);
    await expect(credit(win)).toContainText(ONLINE_SATELLITE.attribution);

    // the street map: none of the imagery is drawn, and online maps stay switched on
    await win.getByTestId('map-tile-streets').click();
    await expect.poll(() => packs(win)).toEqual([]);
    await expect(credit(win)).not.toContainText(ONLINE_SATELLITE.attribution);
    expect(await switchedOn(win)).toBe(true);
    // back to Sentinel-2: no notice the second time
    await sentinel(win).click();
    await expect(notice).toHaveCount(0);
    await expect.poll(() => packs(win)).toEqual([ONLINE]);
    await closeMenu(win, 'basemap-pop');

    // the stand-in was asked for the one service only; nothing left the computer
    await expect.poll(async () => ((await asked(app)) ?? []).length).toBeGreaterThan(0);
    for (const url of (await asked(app)) ?? []) expect(url).toMatch(EOX);
    expect(await network.outbound()).toEqual([]);

    // Settings shows the same switch, and switching it off there takes Sentinel-2 away again
    await settingsPage(win, 'Map sources');
    const box = win.getByTestId('map-sources-master').getByRole('switch');
    await expect(box).toHaveAttribute('aria-checked', 'true');
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'false');
    expect(await switchedOn(win)).toBe(false);
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    // the choice is kept, but the offline map is drawn in its place
    await expect(chip).toContainText('Sentinel-2');
    await expect(win.getByTestId('map-chip-fallback')).toHaveText('Offline map');
    await expect.poll(() => packs(win), MAP_READY).toEqual([]);

    // the command search has it too; the notice was read, so it switches at once
    const palette = await search(win, 'map: sentinel');
    await expect(palette.getByText('Map: Sentinel-2')).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect.poll(() => switchedOn(win)).toBe(true);
    await expect.poll(() => packs(win), MAP_READY).toEqual([ONLINE]);
    await expect(win.getByTestId('map-chip-fallback')).toHaveCount(0);
  });

  test('offline only: saved tiles while it is on, greyed with the reason once it is off', async ({
    app,
    win,
    network,
  }, testInfo) => {
    await openMap(win, 'E2E tiny project');
    const chip = win.getByTestId('basemap-button');
    await chip.click();
    await switchOnSentinel(win);
    await expect.poll(() => packs(win), { timeout: 30_000 }).toEqual([ONLINE]);
    await expect.poll(async () => ((await asked(app)) ?? []).length).toBeGreaterThan(0);
    await closeMenu(win, 'basemap-pop');

    // the workstation goes offline only
    await settingsPage(win, 'Privacy and cloud');
    const offline = win.getByRole('switch', { name: 'Offline-only workstation' });
    await offline.click();
    await expect(offline).toHaveAttribute('aria-checked', 'true');
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    const before = ((await asked(app)) ?? []).length;

    // still on: Sentinel-2 stays for the tiles kept on this computer; the others are greyed
    await chip.click();
    await expect(sentinel(win)).toBeEnabled();
    await expect(sentinel(win)).toHaveAttribute('aria-checked', 'true');
    await expect(win.getByTestId('map-tile-esri-world-imagery')).toBeDisabled();
    await expect(win.getByTestId('map-menu-note-satellite')).toContainText(
      'This workstation is offline-only',
    );
    await expect.poll(() => packs(win), MAP_READY).toEqual([ONLINE]);
    await shot(win, testInfo, 'menu-online-offline-only-on');
    await expectAccessible(win, 'Map menu, online maps on and offline only');
    await closeMenu(win, 'basemap-pop');

    // switched off in Settings it cannot be switched on again
    await settingsPage(win, 'Map sources');
    const box = win.getByTestId('map-sources-master').getByRole('switch');
    await expect(box).toBeEnabled();
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'false');
    await expect(box).toBeDisabled();
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await expect(chip).toContainText('Sentinel-2');
    await expect(win.getByTestId('map-chip-fallback')).toHaveText('Offline map');
    await expect.poll(() => packs(win), MAP_READY).toEqual([]);
    await chip.click();
    await expect(sentinel(win)).toBeDisabled();
    await shot(win, testInfo, 'menu-online-offline-only');
    await expectAccessible(win, 'Map menu, offline only');
    await closeMenu(win, 'basemap-pop');

    // nor in the command search
    const palette = await search(win, 'map: sentinel');
    await expect(palette.getByText('Map: Sentinel-2')).toHaveCount(0);
    await win.keyboard.press('Escape');

    // offline only asked the service for nothing
    expect(((await asked(app)) ?? []).length).toBe(before);
    expect(await network.outbound()).toEqual([]);
  });
});
