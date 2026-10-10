/**
 * Online satellite (ADR 0007, amendment of 10 Oct 2026): Sentinel-2 imagery streamed by main when
 * the person switches it on, and never on an offline-only workstation.
 *
 * No test here reaches the network. An e2e app has no way to the service at all; these tests ask
 * main for its stand-in (QUADRION_ONLINE_TILES_TEST=1: flat green tiles made in main, with the
 * addresses it would have asked for kept in `__aioOnlineTileRequests`). The zero-network guard of
 * the fixtures still runs and fails the test on any real request.
 */
import { ONLINE_SATELLITE } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.use({ appEnv: { QUADRION_ONLINE_TILES_TEST: '1' } });
// the first test opens the project's Map three times; the software GPU of CI is slow at it
test.setTimeout(180_000);

const SOURCE = 'g7-raster-online-s2cloudless-2016';
const LAYER = `${SOURCE}-layer`;
const SERVICE =
  /^https:\/\/tiles\.maps\.eox\.at\/wmts\/1\.0\.0\/s2cloudless_3857\/default\/GoogleMapsCompatible\/\d+\/\d+\/\d+\.jpg$/;

async function openSettings(win: Page, page: string): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: page }).click();
  await expect(win.locator('.set-page h1')).toHaveText(page);
}

async function openMap(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await win.getByRole('button', { name: 'Map', exact: true }).first().click();
}

/** The addresses main's stand-in for the service was asked for. */
const asked = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as { __aioOnlineTileRequests?: string[] }).__aioOnlineTileRequests?.slice() ??
      null,
  );

/** Whether main has online satellite switched on. */
const switchedOn = async (win: Page) =>
  (await win.evaluate(() => window.aio.invoke('onlineTiles:status', {}))).satellite;

/** What a page gets for one tile of the app's own address. */
const tileStatus = (win: Page, path: string) =>
  win.evaluate(async (url) => {
    const res = await fetch(url);
    return { status: res.status, why: res.headers.get('x-aio-online') };
  }, `aio://online/${path}`);

interface MapProbe {
  getStyle():
    | {
        sources: Record<string, { attribution?: string; tiles?: string[]; maxzoom?: number }>;
        layers: { id: string; type: string }[];
      }
    | undefined;
  jumpTo(o: { center: [number, number]; zoom: number }): void;
  once(ev: string, cb: () => void): void;
  triggerRepaint(): void;
  getCanvas(): HTMLCanvasElement;
}

/** The main map's style (MapLibre), or null before it runs. */
const mainMap = (win: Page) =>
  win.evaluate(() => {
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      { __aioMap: MapProbe } | undefined;
    const s = host?.__aioMap.getStyle();
    if (!s) return null;
    return { sources: s.sources, layers: s.layers.map((l) => ({ id: l.id, type: l.type })) };
  });

test('switched on, the Map draws Sentinel-2 under everything, credited, through main', async ({
  app,
  win,
  dataRoot,
  network,
}) => {
  // off by default: nothing is drawn and main refuses a tile without asking anyone
  expect(await tileStatus(win, 's2cloudless-2016/3/4/2.jpg')).toEqual({ status: 403, why: 'off' });
  await openMap(win);
  await expect.poll(async () => (await mainMap(win))?.layers.length ?? 0).toBeGreaterThan(0);
  expect((await mainMap(win))?.sources[SOURCE]).toBeUndefined();
  expect(await asked(app)).toEqual([]);

  // Settings, Offline maps: the switch, and what it sends the first time
  await openSettings(win, 'Offline maps');
  const section = win.getByTestId('raster-packs');
  const box = section.getByRole('checkbox', { name: 'Online satellite (Sentinel-2)' });
  await expect(box).toBeEnabled();
  await expect(box).not.toBeChecked();
  const clear = section.getByTestId('online-satellite-clear');
  await expect(clear).toHaveText('Clear cached satellite tiles (0 B)');
  await expect(clear).toBeDisabled();
  await box.click();
  const notice = section.getByTestId('online-satellite-notice');
  await expect(notice).toContainText("from EOX's servers");
  await expect(notice).toContainText('the areas you view are visible to that service');
  await expect(notice).toContainText('from 2016, at about 10 m per pixel');
  // nothing is on until the person says yes
  await expect(box).not.toBeChecked();
  expect(await switchedOn(win)).toBe(false);
  await notice.getByRole('button', { name: 'Switch on' }).click();
  await expect(box).toBeChecked();
  await expect(notice).toHaveCount(0);
  expect(await switchedOn(win)).toBe(true);
  // the switch has its own file in the profile; settings.json keeps the keys older builds read
  expect(JSON.parse(await readFile(join(dataRoot.userData, 'online.json'), 'utf8'))).toEqual({
    schema: 'aio.online-settings/1',
    satellite: true,
  });
  expect(await win.evaluate(() => window.aio.invoke('settings:get', {}))).not.toHaveProperty(
    'onlineSatellite',
  );
  await expect(section.getByTestId('online-satellite')).toContainText(ONLINE_SATELLITE.attribution);

  // the project's Map: the layer at the bottom of the satellite stack, with its credit
  await openMap(win);
  await expect
    .poll(async () => (await mainMap(win))?.sources[SOURCE]?.attribution, { timeout: 30_000 })
    .toBe(ONLINE_SATELLITE.attribution);
  const style = await mainMap(win);
  expect(style?.sources[SOURCE]).toMatchObject({
    tiles: ['aio://online/s2cloudless-2016/{z}/{x}/{y}.jpg'],
    maxzoom: 14,
  });
  const ids = style?.layers.map((l) => l.id) ?? [];
  const at = ids.indexOf(LAYER);
  expect(at).toBeGreaterThanOrEqual(0);
  // under every street line and label, and under the project's own layers
  const firstAbove = style?.layers.findIndex((l) => l.type === 'line' || l.type === 'symbol') ?? -1;
  expect(firstAbove).toBeGreaterThan(at);
  expect(ids.indexOf('aio-view3d-fill')).toBeGreaterThan(at);
  // no other raster below it
  expect(style?.layers.slice(0, at).filter((l) => l.type === 'raster')).toEqual([]);
  await expect(win.locator('.pane-map .maplibregl-ctrl-attrib')).toContainText(
    ONLINE_SATELLITE.attribution,
  );

  // its tiles draw: green from main's stand-in around the site, at a zoom past the imagery's own
  const drawn = await win.evaluate(async () => {
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      { __aioMap: MapProbe } | undefined;
    const map = host?.__aioMap;
    if (!map) return null;
    const idle = new Promise<void>((resolve) => {
      map.once('idle', resolve);
    });
    map.jumpTo({ center: [51.02, 28.93], zoom: 15.5 });
    await idle;
    return new Promise<number[][]>((resolve) => {
      map.once('render', () => {
        const canvas = map.getCanvas();
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const dpr = canvas.width / canvas.clientWidth;
        const px: number[][] = [];
        for (const [dx, dy] of [
          [60, 40],
          [-60, 40],
          [60, -40],
          [-60, -40],
        ] as const) {
          const out = new Uint8Array(4);
          const x = Math.round((canvas.clientWidth / 2 + dx) * dpr);
          const y = Math.round((canvas.clientHeight / 2 + dy) * dpr);
          gl?.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
          px.push([...out]);
        }
        resolve(px);
      });
      map.triggerRepaint();
    });
  });
  const green = (drawn ?? []).filter(([r = 0, g = 0, b = 0]) => g > 120 && r < 90 && b < 90);
  expect(green.length, JSON.stringify(drawn)).toBeGreaterThanOrEqual(3);

  // main asked its stand-in for the one service only, never deeper than zoom 14
  const urls = (await asked(app)) ?? [];
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) expect(url).toMatch(SERVICE);
  const zooms = urls.map((u) => Number(u.split('/').at(-3)));
  expect(Math.max(...zooms)).toBe(14);
  // and nothing left the computer: not from the page, not from main
  expect(await network.outbound()).toEqual([]);

  // the tiles are kept under the profile, and Settings can clear them
  const cached = join(dataRoot.userData, 'cache', 'online-tiles', 's2cloudless-2016');
  expect((await readdir(cached)).length).toBeGreaterThan(0);
  await openSettings(win, 'Offline maps');
  await expect(clear).toBeEnabled();
  await expect(clear).not.toHaveText('Clear cached satellite tiles (0 B)');
  await clear.click();
  await expect(clear).toHaveText('Clear cached satellite tiles (0 B)');
  await expect(clear).toBeDisabled();
  expect(
    (await win.evaluate(() => window.aio.invoke('onlineTiles:status', {}))).cache,
  ).toMatchObject({ bytes: 0, tiles: 0 });

  // switched off again: no notice this time, the layer goes and main refuses
  await box.click();
  await expect(box).not.toBeChecked();
  expect(await tileStatus(win, 's2cloudless-2016/3/4/2.jpg')).toEqual({ status: 403, why: 'off' });
  await openMap(win);
  await expect.poll(async () => (await mainMap(win))?.layers.length ?? 0).toBeGreaterThan(0);
  expect((await mainMap(win))?.sources[SOURCE]).toBeUndefined();
});

test('offline only: the switch is disabled with the reason, and main asks nobody', async ({
  app,
  win,
  network,
}) => {
  await openSettings(win, 'Privacy and cloud');
  const offline = win.getByRole('switch', { name: 'Offline-only workstation' });
  await offline.click();
  await expect(offline).toHaveAttribute('aria-checked', 'true');

  await openSettings(win, 'Offline maps');
  const section = win.getByTestId('raster-packs');
  const box = section.getByRole('checkbox', { name: 'Online satellite (Sentinel-2)' });
  await expect(box).toBeDisabled();
  await expect(box).not.toBeChecked();
  await expect(section.getByTestId('online-satellite')).toContainText(
    'This workstation is offline-only, so online satellite cannot be switched on.',
  );
  await expect(box).toHaveAttribute('aria-describedby', 'online-satellite-help');

  // main is the one that enforces it. Off: refused.
  expect(await tileStatus(win, 's2cloudless-2016/3/4/2.jpg')).toEqual({ status: 403, why: 'off' });
  // Even with the setting forced on behind the page's back, an offline-only workstation asks for
  // nothing: no tile, no request to the stand-in, nothing on the network.
  expect(
    await win.evaluate(() => window.aio.invoke('onlineTiles:setSatellite', { on: true })),
  ).toEqual({ ok: true, satellite: true });
  expect(await tileStatus(win, 's2cloudless-2016/3/4/2.jpg')).toEqual({
    status: 404,
    why: 'offline-only',
  });
  expect(await tileStatus(win, 's2cloudless-2016/12/2234/1420.jpg')).toEqual({
    status: 404,
    why: 'offline-only',
  });
  // a bad address is refused whatever the settings
  expect((await tileStatus(win, 's2cloudless-2016/15/0/0.jpg')).status).toBe(400);
  expect((await tileStatus(win, 's2cloudless-2018/3/4/2.jpg')).status).toBe(400);
  expect(await asked(app)).toEqual([]);
  expect(await network.outbound()).toEqual([]);
});
