/**
 * The map type picker on the Map view: Streets, Satellite and Satellite only, the imagery pack
 * and terrain shading, chosen on the map itself. On a synthetic site with imagery and terrain
 * packs (the globe library, `m10Fixtures.ts`) the pack layers come and go as the map type
 * changes, the camera stays where it was and the choice survives a relaunch; on a site no pack
 * covers, Satellite is greyed out with the reason and a way to Settings, Offline maps.
 * Zero network: the packs are files in the data root, and both launches are checked.
 */
import type { Page, TestInfo } from '@playwright/test';
import { expectAccessible } from './a11y';
import { expect, launchApp, NetworkGuard, test } from './fixtures';

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

async function openMap(win: Page, project: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: project }).click();
  await win.getByRole('button', { name: 'Map', exact: true }).first().click();
  await expect(win.getByTestId('basemap-button')).toBeVisible();
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
  test.setTimeout(180_000);
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
    await win.keyboard.press('Escape');
    await win.locator('.nav-item', { hasText: 'Settings' }).click();
    await win.locator('.set-nav button', { hasText: 'Offline maps' }).click();
    const satellite = win
      .getByTestId('raster-packs')
      .getByRole('checkbox', { name: /^Satellite: imagery packs/ });
    await expect(satellite).not.toBeChecked();
    await satellite.check();
    await win.locator('.nav-item', { hasText: 'Scene' }).click();
    await expect(chip).toHaveText('Satellite');
    await expect.poll(() => packs(win)).toEqual([WORLD, DETAIL, HILLSHADE]);

    // the 3D view's part: imagery and terrain around the site, in Layers
    await win.getByRole('button', { name: '3D', exact: true }).first().click();
    await win.getByRole('button', { name: 'Layers and issue pins' }).click();
    await expect(win.getByTestId('ground-aroundImagery')).toBeVisible();
    await expect(win.getByTestId('ground-aroundTerrain')).toBeVisible();
    await shot(win, testInfo, 'layers-3d-ground');
    await win.keyboard.press('Escape');

    // the command search has the map types too, and shows the map it changes
    await win.keyboard.press('Control+K');
    const palette = win.getByRole('dialog', { name: 'Command search' });
    await expect(palette).toBeVisible();
    await win.keyboard.type('map type satellite only');
    await expect(palette.getByText('Map type: satellite only')).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(chip).toHaveText('Satellite only');
    await expect
      .poll(async () => {
        const s = await mapState(win);
        return s ? s.streets - s.hidden : -1;
      })
      .toBe(0);

    // leave it on Streets for the relaunch
    await win.getByRole('button', { name: 'Map', exact: true }).first().click();
    await chip.click();
    await win.getByTestId('basemap-streets').click();
    await expect.poll(() => packs(win)).toEqual([HILLSHADE]);
    await win.keyboard.press('Escape');
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
