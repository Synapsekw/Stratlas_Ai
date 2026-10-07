/**
 * Imagery and terrain packs (M10 G7): Settings, Map packs, Import imagery builds a pack from a
 * synthetic GeoTIFF (written here with the development pipeline Python's rasterio, red at the
 * tiny project's site) through `packs.imagery`; the pack lists with its licence and customer
 * mark, and the project's Map shows it under the streets (Satellite) with its attribution.
 * Zero network, as every test (the fixture asserts it).
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';

test.use({ appEnv: PIPELINE_ENV });
test.setTimeout(180_000);

/** A 300 m red GeoTIFF in UTM 39N around the tiny project's origin (E 500000, N 3200000). */
function writeGeoTiff(path: string): void {
  const script = [
    'import sys, numpy as np, rasterio',
    'from rasterio.transform import from_origin',
    'a = np.zeros((3, 150, 150), np.uint8); a[0] = 230; a[1] = 20; a[2] = 30',
    "with rasterio.open(sys.argv[1], 'w', driver='GTiff', width=150, height=150, count=3,",
    "    dtype='uint8', crs='EPSG:32639', transform=from_origin(499850, 3200150, 2, 2)) as d:",
    '    d.write(a)',
  ].join('\n');
  execFileSync(VENV_PYTHON, ['-c', script, path], { stdio: 'pipe' });
}

async function answerOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
  }, path);
}

async function openSettings(win: Page, page: string): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: page }).click();
  await expect(win.locator('.set-page h1')).toHaveText(page);
}

interface MapProbe {
  getStyle(): { sources: Record<string, { attribution?: string }>; layers: { id: string }[] };
  jumpTo(o: { center: [number, number]; zoom: number }): void;
  once(ev: string, cb: () => void): void;
  triggerRepaint(): void;
  getCanvas(): HTMLCanvasElement;
  getZoom(): number;
}

/** The main map of the open project (MapLibre), or null before it runs. */
const mainMap = (win: Page) =>
  win.evaluate(() => {
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      { __aioMap: MapProbe } | undefined;
    if (!host) return null;
    const s = host.__aioMap.getStyle();
    return {
      sources: Object.fromEntries(
        Object.entries(s.sources).map(([k, v]) => [k, v.attribution ?? null]),
      ),
      layers: s.layers.map((l) => l.id),
    };
  });

test('imports a GeoTIFF as an imagery pack and shows it on the Satellite map', async ({
  app,
  win,
  dataRoot,
}) => {
  test.skip(!hasPipelinePython(), 'no development pipeline Python (python/.venv)');
  const tif = join(dataRoot.base, 'site-ortho.tif');
  writeGeoTiff(tif);

  await openSettings(win, 'Offline maps');
  const section = win.getByTestId('raster-packs');
  await expect(section).toBeVisible();
  await answerOpenDialog(app, tif);
  await section.getByRole('button', { name: 'Import imagery' }).click();
  const form = win.getByTestId('raster-import');
  await expect(form).toContainText('site-ortho.tif');
  await form.getByRole('textbox', { name: 'Licence' }).fill('CC0-1.0');
  await form.getByRole('textbox', { name: 'Attribution' }).fill('E2E synthetic imagery');
  await expect(form.getByRole('checkbox')).toBeChecked();
  await form.getByRole('button', { name: 'Build the pack' }).click();
  await expect(section.getByRole('status')).toContainText('Building site-ortho');

  const row = win.getByTestId('raster-pack-site-ortho');
  await expect(row).toBeVisible({ timeout: 120_000 });
  await expect(row).toContainText('CC0-1.0');
  await expect(row).toContainText('E2E synthetic imagery');
  await expect(row).toContainText('Customer licence');
  expect((await readdir(join(dataRoot.root, 'packs', 'imagery'))).sort()).toEqual([
    'site-ortho.json',
    'site-ortho.pmtiles',
  ]);

  // the project's Map: the pack under the streets, credited
  await win.locator('.nav-item', { hasText: 'Projects' }).click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await win.getByRole('button', { name: 'Map', exact: true }).first().click();
  await expect
    .poll(async () => (await mainMap(win))?.sources['g7-raster-imagery-site-ortho'], {
      timeout: 30_000,
    })
    .toBe('E2E synthetic imagery');
  expect((await mainMap(win))?.layers).toContain('g7-raster-imagery-site-ortho-layer');

  // and its tiles draw: the centre of the map at the site is red. The source was added a moment
  // ago and has requested no tiles yet, so `areTilesLoaded()` (which only looks at tiles already
  // requested) is true at once; wait for `idle` after the move instead: every source loaded, its
  // tiles for this view loaded and drawn, no transition running.
  const centre = await win.evaluate(async () => {
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      { __aioMap: MapProbe } | undefined;
    const map = host?.__aioMap;
    if (!map) return null;
    const packs = (await (
      window as unknown as { aio: { invoke(c: string, r: unknown): Promise<unknown> } }
    ).aio.invoke('imageryPacks:list', {})) as { packs: { bbox: number[] }[] };
    const [w = 0, s = 0, e = 0, n = 0] = packs.packs[0]?.bbox ?? [];
    const idle = new Promise<void>((resolve) => {
      map.once('idle', resolve);
    });
    map.jumpTo({ center: [(w + e) / 2, (s + n) / 2], zoom: 15 });
    await idle;
    // a few points around the site (its centre carries the project's own markers), read in a
    // render event, while the frame is still in the drawing buffer
    return new Promise<{ px: number[][]; zoom: number; tiles: string[] }>((resolve) => {
      map.once('render', () => {
        const canvas = map.getCanvas();
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const dpr = canvas.width / canvas.clientWidth;
        const px: number[][] = [];
        for (const [dx, dy] of [
          [40, 30],
          [-40, 30],
          [40, -30],
          [-40, -30],
        ] as const) {
          const out = new Uint8Array(4);
          const x = Math.round((canvas.clientWidth / 2 + dx) * dpr);
          const y = Math.round((canvas.clientHeight / 2 + dy) * dpr);
          gl?.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
          px.push([...out]);
        }
        // for the failure message: the imagery source's tiles and their states
        const caches = (map as unknown as { style?: { sourceCaches?: Record<string, unknown> } })
          .style?.sourceCaches;
        const cache = caches?.['g7-raster-imagery-site-ortho'] as
          { _tiles?: Record<string, { state: string; tileID: { key: string } }> } | undefined;
        const tiles = Object.values(cache?._tiles ?? {}).map((t) => `${t.tileID.key}:${t.state}`);
        resolve({ px, zoom: map.getZoom(), tiles });
      });
      map.triggerRepaint();
    });
  });
  expect(centre).not.toBeNull();
  const red = (centre?.px ?? []).filter(([r = 0, g = 0, b = 0]) => r > 150 && g < 90 && b < 90);
  expect(red.length, JSON.stringify(centre)).toBeGreaterThanOrEqual(3);
});
