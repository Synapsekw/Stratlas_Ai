/**
 * The map type picker on the Map view: Streets, Satellite and Satellite only, the imagery pack
 * and terrain shading, chosen on the map itself. On a synthetic site with imagery and terrain
 * packs (the globe library, `m10Fixtures.ts`) the pack layers come and go as the map type
 * changes, the camera stays where it was and the choice survives a relaunch; on a site no pack
 * covers, Satellite is greyed out with the reason and a way to Settings, Offline maps.
 * Zero network: the packs are files in the data root, and both launches are checked.
 *
 * Online satellite is a row of the picker too (the last two tests): switched on, Satellite is a
 * choice where no pack covers the site. Main stands in for the service there; nothing is fetched.
 */
import { ONLINE_SATELLITE } from '@aio/schema';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { expectAccessible } from './a11y';
import { expect, launchApp, NetworkGuard, test } from './fixtures';

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

/** A map that was just created (a view change, back from Settings) loads its style first. */
const MAP_READY = { timeout: 30_000 };

const stageBar = (win: Page) => win.getByRole('toolbar', { name: 'Stage tools' });

/** Switch the stage with its view switch (the one control of that name on the toolbar). */
async function showView(win: Page, view: '3D' | 'Map'): Promise<void> {
  const button = stageBar(win)
    .getByRole('group', { name: 'Stage view' })
    .getByRole('button', { name: view, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', view === '3D' ? '3d' : 'map');
}

async function openMap(win: Page, project: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: project }).click();
  await showView(win, 'Map');
  await expect(win.getByTestId('basemap-button')).toBeVisible();
}

/**
 * The Layers popover of the 3D view. The 3D toolbar holds more tools than the map's, and what
 * does not fit the window folds into More tools, the Labels and layers group first: on a small
 * display (a CI runner's 1024 x 768) the Layers tool is not on the bar at all. The bar fits
 * itself again once the 3D scene runs (its environment tool takes room), so wait for that, then
 * open Layers from wherever it is.
 */
async function openLayers3d(win: Page): Promise<void> {
  const bar = stageBar(win);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible(MAP_READY);
  await expect(bar.getByRole('button', { name: 'Environment and time of day' })).toBeVisible(
    MAP_READY,
  );
  const layers = bar.getByRole('button', { name: 'Layers and issue pins', exact: true });
  const more = bar.getByRole('button', { name: 'More tools', exact: true });
  await expect(layers.or(more).first()).toBeVisible();
  if (!(await layers.isVisible())) {
    await more.click();
    await expect(win.getByRole('dialog', { name: 'More tools' })).toBeVisible();
  }
  await layers.click();
  await expect(win.getByRole('dialog', { name: 'Layers and issue pins' })).toBeVisible();
}

/** Close every stage popover (Layers, and More tools around it when the tool was folded). */
async function closeStagePopovers(win: Page): Promise<void> {
  const open = win.locator('.stage-pop');
  for (let i = 0; i < 3 && (await open.count()) > 0; i++) await win.keyboard.press('Escape');
  await expect(open).toHaveCount(0);
}

async function shot(win: Page, testInfo: TestInfo, name: string): Promise<void> {
  // two frames, so the popover is placed and the map has drawn
  await win.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await win.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

test('the map type is chosen on the map, keeps the camera and survives a relaunch', async ({
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

    // packs cover the site: Satellite from the start, imagery under the hillshade
    const chip = win.getByTestId('basemap-button');
    await expect(chip).toHaveText('Satellite');
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
    await expect(win.getByTestId('basemap-satellite')).toHaveAttribute('aria-checked', 'true');
    await expect(win.getByTestId('basemap-satellite')).toBeFocused();
    await expect(win.getByTestId('basemap-note')).toHaveCount(0);
    await shot(win, testInfo, 'picker-satellite');
    await expectAccessible(win, 'Map with the map type picker open');

    // Streets: the imagery goes, the hillshade and the camera stay
    await win.getByTestId('basemap-streets').click();
    await expect(chip).toHaveText('Streets');
    await expect.poll(() => packs(win)).toEqual([HILLSHADE]);
    expect((await mapState(win))?.camera).toBe(before?.camera);
    await shot(win, testInfo, 'picker-streets');

    // Satellite only: the imagery is back and the streets over it are hidden
    await win.getByTestId('basemap-imagery').click();
    await expect(chip).toHaveText('Satellite only');
    await expect.poll(() => packs(win)).toEqual([WORLD, DETAIL, HILLSHADE]);
    await expect
      .poll(async () => {
        const s = await mapState(win);
        return s ? s.streets - s.hidden : -1;
      })
      .toBe(0);
    await shot(win, testInfo, 'picker-satellite-only');

    // one pack of the two that cover the site, then the best available again
    const pack = win.getByTestId('basemap-pack');
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
    const shading = win.getByTestId('basemap-hillshade');
    await expect(shading).toBeChecked();
    await shading.uncheck();
    await expect.poll(() => packs(win)).toEqual([WORLD, DETAIL]);
    await shading.check();
    await expect.poll(() => packs(win)).toEqual([WORLD, DETAIL, HILLSHADE]);

    // back to Satellite by keyboard: the streets return; Escape closes and focus goes to the chip
    await win.getByTestId('basemap-imagery').focus();
    await win.keyboard.press('ArrowLeft');
    await expect(win.getByTestId('basemap-satellite')).toBeFocused();
    await expect(chip).toHaveText('Satellite');
    await expect.poll(async () => (await mapState(win))?.hidden).toBe(0);
    expect((await mapState(win))?.camera).toBe(before?.camera);
    await win.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await expect(chip).toBeFocused();

    // Settings shows the same choice, and its checkbox moves the map type
    await chip.click();
    await win.getByTestId('basemap-streets').click();
    await expect(chip).toHaveText('Streets');
    await win.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: 'Offline maps' }).click();
    await expect(win.locator('.set-page h1')).toHaveText('Offline maps');
    const satellite = win
      .getByTestId('raster-packs')
      .getByRole('checkbox', { name: /^Satellite: imagery packs/ });
    await expect(satellite).not.toBeChecked();
    await satellite.check();
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await expect(chip).toHaveText('Satellite');
    await expect.poll(() => packs(win), MAP_READY).toEqual([WORLD, DETAIL, HILLSHADE]);

    // the 3D view's part: imagery and terrain around the site, in Layers
    await showView(win, '3D');
    await expect(chip).toHaveCount(0);
    await openLayers3d(win);
    await expect(win.getByTestId('ground-aroundImagery')).toBeVisible();
    await expect(win.getByTestId('ground-aroundTerrain')).toBeVisible();
    await shot(win, testInfo, 'layers-3d-ground');
    await closeStagePopovers(win);

    // the command search has the map types too, and shows the map it changes
    await win.keyboard.press('Control+K');
    const palette = win.getByRole('dialog', { name: 'Command search' });
    await expect(palette).toBeVisible();
    await win.keyboard.type('map type satellite only');
    await expect(palette.getByText('Map type: satellite only')).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'map');
    await expect(chip).toHaveText('Satellite only');
    await expect
      .poll(async () => {
        const s = await mapState(win);
        return s ? s.streets - s.hidden : -1;
      }, MAP_READY)
      .toBe(0);

    // leave it on Streets for the relaunch
    await chip.click();
    await expect(pop).toBeVisible();
    await win.getByTestId('basemap-streets').click();
    await expect(chip).toHaveText('Streets');
    await expect.poll(() => packs(win), MAP_READY).toEqual([HILLSHADE]);
    await win.keyboard.press('Escape');
    await expect(pop).toBeHidden();
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
    await expect(win.getByTestId('basemap-streets')).toHaveAttribute('aria-checked', 'true');
    expect(await guard2.outbound(), 'the app made network requests').toEqual([]);
  } finally {
    await second.close();
  }
});

test('Satellite is greyed out with the reason when no imagery pack covers the site', async ({
  win,
}, testInfo) => {
  // the tiny project's data root has no imagery or terrain pack
  await openMap(win, 'E2E tiny project');
  const chip = win.getByTestId('basemap-button');
  await expect(chip).toHaveText('Streets');
  await chip.click();
  await expect(win.getByTestId('basemap-streets')).toHaveAttribute('aria-checked', 'true');
  await expect(win.getByTestId('basemap-satellite')).toBeDisabled();
  await expect(win.getByTestId('basemap-imagery')).toBeDisabled();
  await expect(win.getByTestId('basemap-hillshade')).toBeDisabled();
  await expect(win.getByTestId('basemap-note')).toContainText(
    'No imagery or terrain pack covers this site.',
  );
  await expect(win.getByTestId('basemap-pack')).toHaveCount(0);
  expect(await packs(win)).toEqual([]);
  await shot(win, testInfo, 'picker-no-packs');
  await expectAccessible(win, 'Map type picker without packs');

  // never an error: the way to the packs is one click
  await win.getByTestId('basemap-open-packs').click();
  await expect(win.locator('.set-page h1')).toHaveText('Offline maps');
  await expect(win.getByTestId('raster-packs')).toBeInViewport();
  await expect(
    win.getByTestId('raster-packs').getByRole('button', { name: 'Import imagery' }),
  ).toBeFocused();
});

test('a site covered by imagery but no terrain pack offers Satellite without shading', async ({
  globeLibrary,
  win,
}, testInfo) => {
  // site B lies under the world imagery only: no detailed pack, no terrain
  const site = globeLibrary.sites.find((s) => s.id === 'globe-site-b');
  await openMap(win, site?.name ?? '');
  const chip = win.getByTestId('basemap-button');
  await expect(chip).toHaveText('Satellite');
  await expect.poll(() => packs(win), { timeout: 30_000 }).toEqual([WORLD, DETAIL]);
  await chip.click();
  await expect(win.getByTestId('basemap-satellite')).toBeEnabled();
  await expect(win.getByTestId('basemap-hillshade')).toBeDisabled();
  await expect(win.getByTestId('basemap-note')).toContainText('No terrain pack covers this site.');
  // one covering pack: nothing to choose between
  await expect(win.getByTestId('basemap-pack')).toHaveCount(0);

  // in the light theme the picker stays dark, as everything that sits on the map, and readable
  await win.keyboard.press('Escape');
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Appearance' }).click();
  await win.getByRole('radio', { name: 'Light', exact: true }).click();
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
  await win.locator('.nav-item', { hasText: 'Scene' }).click();
  await shot(win, testInfo, 'chip-light-theme');
  await chip.click();
  await expect(win.getByTestId('basemap-pop')).toBeVisible();
  await shot(win, testInfo, 'picker-light-theme');
  await expectAccessible(win, 'Map type picker in the light theme');
});

// ------------------------------------------------------------------ Online satellite in the picker

/**
 * Online satellite (ADR 0007, amendment of 10 Oct 2026) as a row of the picker. No test reaches
 * the network: main stands in for the service (QUADRION_ONLINE_TILES_TEST=1, flat green tiles made
 * in main), and the zero-network guard of the fixtures still fails the test on any real request.
 */
test.describe('Online satellite', () => {
  test.use({ appEnv: { QUADRION_ONLINE_TILES_TEST: '1' } });

  const ONLINE = 'g7-raster-online-s2cloudless-2016-layer';
  const row = (win: Page) => win.getByTestId('basemap-online');
  const rowNote = (win: Page) => win.getByTestId('basemap-online-note');
  const credit = (win: Page) => win.locator('.pane-map .maplibregl-ctrl-attrib');
  /** Whether main has it switched on. */
  const switchedOn = async (win: Page) =>
    (await win.evaluate(() => window.aio.invoke('onlineTiles:status', {}))).satellite;
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

  test('switched on in the picker, Satellite is a choice where no pack covers the site', async ({
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

    // off: the row says what it is, and the reason line has a second way out
    await expect(row(win)).not.toBeChecked();
    await expect(row(win)).toBeEnabled();
    await expect(pop.getByText('Online satellite', { exact: true }).first()).toBeVisible();
    await expect(rowNote(win)).toHaveText('Sentinel-2, 2016, about 10 m per pixel');
    await expect(rowNote(win)).toBeInViewport({ ratio: 1 });
    await expect(win.getByTestId('basemap-satellite')).toBeDisabled();
    await expect(win.getByTestId('basemap-note')).toHaveText(
      'No imagery or terrain pack covers this site. Offline maps or turn on Online satellite',
    );
    await shot(win, testInfo, 'picker-online-off');
    await expectAccessible(win, 'Map type picker, online satellite off');

    // the first time: the notice, and nothing is on or asked for until the person says yes
    await row(win).click();
    const notice = pop.getByTestId('online-satellite-notice');
    await expect(notice).toContainText("from EOX's servers");
    await expect(notice).toContainText('the areas you view are visible to that service');
    // the whole question is on screen, also in the smallest window (the popover scrolls there)
    await expect(notice).toBeInViewport({ ratio: 1 });
    await expect(notice.getByRole('button', { name: 'Switch on' })).toBeInViewport({ ratio: 1 });
    await expect(row(win)).not.toBeChecked();
    await expect(win.getByTestId('basemap-satellite')).toBeDisabled();
    expect(await switchedOn(win)).toBe(false);
    expect(await asked(app)).toEqual([]);
    await shot(win, testInfo, 'picker-online-notice');
    await expectAccessible(win, 'Map type picker with the online satellite notice');
    await notice.getByRole('button', { name: 'Cancel' }).click();
    await expect(notice).toHaveCount(0);
    expect(await switchedOn(win)).toBe(false);

    // the second way out of the reason line asks the same question
    await win.getByTestId('basemap-turn-on-online').click();
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Switch on' }).click();
    await expect(row(win)).toBeChecked();
    await expect(notice).toHaveCount(0);
    expect(await switchedOn(win)).toBe(true);

    // Satellite is a choice now and, being the remembered type, what the map shows
    await expect(win.getByTestId('basemap-satellite')).toBeEnabled();
    await expect(win.getByTestId('basemap-imagery')).toBeEnabled();
    await expect(win.getByTestId('basemap-satellite')).toHaveAttribute('aria-checked', 'true');
    await expect(chip).toHaveText('Satellite');
    await expect.poll(() => packs(win), { timeout: 30_000 }).toEqual([ONLINE]);
    // no imagery line any more: only what is still missing
    await expect(win.getByTestId('basemap-note')).toHaveText(
      'No terrain pack covers this site. Offline maps',
    );
    await expect(credit(win)).toContainText(ONLINE_SATELLITE.attribution);
    await shot(win, testInfo, 'picker-online-on');
    await expectAccessible(win, 'Map type picker, online satellite on');

    // Satellite only: the imagery stays, credited, and the streets over it are hidden
    await win.getByTestId('basemap-imagery').click();
    await expect(chip).toHaveText('Satellite only');
    await expect
      .poll(async () => {
        const s = await mapState(win);
        return s ? s.streets - s.hidden : -1;
      })
      .toBe(0);
    expect(await packs(win)).toEqual([ONLINE]);
    await expect(credit(win)).toContainText(ONLINE_SATELLITE.attribution);

    // Streets: it is imagery like the packs, so none of it is drawn, and it stays switched on
    await win.getByTestId('basemap-streets').click();
    await expect.poll(() => packs(win)).toEqual([]);
    await expect(credit(win)).not.toContainText(ONLINE_SATELLITE.attribution);
    await expect(row(win)).toBeChecked();
    await win.getByTestId('basemap-satellite').click();
    await expect.poll(() => packs(win)).toEqual([ONLINE]);
    await win.keyboard.press('Escape');

    // the stand-in was asked for the one service only; nothing left the computer
    await expect.poll(async () => ((await asked(app)) ?? []).length).toBeGreaterThan(0);
    for (const url of (await asked(app)) ?? [])
      expect(url).toMatch(
        /^https:\/\/tiles\.maps\.eox\.at\/wmts\/1\.0\.0\/s2cloudless_3857\/default\/GoogleMapsCompatible\/\d+\/\d+\/\d+\.jpg$/,
      );
    expect(await network.outbound()).toEqual([]);

    // Settings shows the same switch, and switching it off there takes Satellite away again
    await settingsPage(win, 'Offline maps');
    const box = win
      .getByTestId('raster-packs')
      .getByRole('checkbox', { name: 'Online satellite (Sentinel-2)' });
    await expect(box).toBeChecked();
    await box.click();
    await expect(box).not.toBeChecked();
    expect(await switchedOn(win)).toBe(false);
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await expect(chip).toHaveText('Streets');
    await expect.poll(() => packs(win)).toEqual([]);

    // the command search has it too; the notice was read, so it switches at once
    const palette = await search(win, 'online satellite');
    await expect(palette.getByRole('option').first()).toHaveText(/^Turn online satellite on/);
    await win.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(chip).toHaveText('Satellite');
    await expect.poll(() => switchedOn(win)).toBe(true);
    await chip.click();
    await expect(row(win)).toBeChecked();
  });

  test('offline only: saved tiles while it is on, greyed with the reason once it is off', async ({
    app,
    win,
    network,
  }, testInfo) => {
    await openMap(win, 'E2E tiny project');
    const chip = win.getByTestId('basemap-button');
    await chip.click();
    await row(win).click();
    await win
      .getByTestId('online-satellite-notice')
      .getByRole('button', { name: 'Switch on' })
      .click();
    await expect(row(win)).toBeChecked();
    await expect.poll(() => packs(win), { timeout: 30_000 }).toEqual([ONLINE]);
    await expect.poll(async () => ((await asked(app)) ?? []).length).toBeGreaterThan(0);
    await win.keyboard.press('Escape');

    // the workstation goes offline only
    await settingsPage(win, 'Privacy and cloud');
    const offline = win.getByRole('switch', { name: 'Offline-only workstation' });
    await offline.click();
    await expect(offline).toHaveAttribute('aria-checked', 'true');
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    const before = ((await asked(app)) ?? []).length;

    // still on: the layer stays for the tiles kept on this computer, and it can be switched off
    await chip.click();
    await expect(row(win)).toBeChecked();
    await expect(row(win)).toBeEnabled();
    await expect(rowNote(win)).toHaveText('Showing saved tiles only');
    await expect(win.getByTestId('basemap-satellite')).toBeEnabled();
    expect(await packs(win)).toEqual([ONLINE]);
    await shot(win, testInfo, 'picker-online-offline-only-on');
    await expectAccessible(win, 'Map type picker, online satellite on and offline only');

    await row(win).click();
    await expect(row(win)).not.toBeChecked();
    await expect(row(win)).toBeDisabled();
    await expect(rowNote(win)).toHaveText('Go online to use it');
    await expect(win.getByTestId('basemap-satellite')).toBeDisabled();
    await expect(chip).toHaveText('Streets');
    await expect.poll(() => packs(win)).toEqual([]);
    // no second way out while offline only
    await expect(win.getByTestId('basemap-note')).toHaveText(
      'No imagery or terrain pack covers this site. Offline maps',
    );
    await expect(win.getByTestId('basemap-turn-on-online')).toHaveCount(0);
    await shot(win, testInfo, 'picker-online-offline-only');
    await expectAccessible(win, 'Map type picker, offline only');
    await win.keyboard.press('Escape');

    // nor in the command search
    const palette = await search(win, 'online satellite');
    await expect(palette.getByText(/Turn online satellite/)).toHaveCount(0);
    await win.keyboard.press('Escape');

    // offline only asked the service for nothing
    expect(((await asked(app)) ?? []).length).toBe(before);
    expect(await network.outbound()).toEqual([]);
  });
});
