/**
 * Packages of processed projects (M10 X1) end to end: a project with a photogrammetry run, a
 * tileset and a customer-licensed imagery pack installed over its site is shared as a package.
 * The export dialog offers the imagery pack unticked with its licence reminder (and not a terrain
 * pack far away); ticked, the pack travels cut to the site, beside the run's records and reports,
 * never its work files. On another machine with no pack installed, the player's Globe opens on
 * the whole Earth over the package's site and, flown there, draws the imagery from inside the package; processing stays closed and
 * nothing is written. Synthetic data only; the zero-network guard runs on both apps.
 */
import { utmToWgs84 } from '@aio/geo';
import { headingPitch, WHOLE_EARTH_HEIGHT_M, type GlobeCamera } from '@aio/globe';
import type { GlobeInspection } from '@aio/globe/view';
import { pmtilesOf, solidPng, syntheticPackMeta } from '@aio/globe/testing';
import { openZip } from '@aio/project/package';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDataRoot,
  expect,
  launchApp,
  NetworkGuard,
  test,
  tinyGlb,
  type DataRoot,
} from './fixtures';
import { enuTileset, writeRasterPack } from './m10Fixtures';

/** A flight and the tiles it brings in may take this long on a software GPU (globe.spec.ts). */
const SETTLE_MS = 60_000;
test.setTimeout(6 * SETTLE_MS);

const SITE = {
  id: 'handover-site',
  name: 'Handover site (synthetic)',
  origin: [550_000, 2_330_000, 140] as [number, number, number],
};
const [LON, LAT] = utmToWgs84(SITE.origin[0], SITE.origin[1], 39);
const IMAGERY_ID = 'handover-imagery';
const IMAGERY_LABEL = 'Handover imagery (synthetic)';
const FAR_TERRAIN_ID = 'far-terrain';
const MAGENTA = [255, 0, 200, 255] as const;
/** The package file; its name gives the package's project id in the player. */
const PACKAGE_ID = 'handover';
// Same rule as embeddedRasterId in src/main/packs/rasterEmbed.ts.
const PACKAGE_RASTER_ID = `pkg-${createHash('sha256').update(`${PACKAGE_ID}/${IMAGERY_ID}`).digest('hex').slice(0, 8)}`;

/**
 * A folder project at the site with a finished run (records, a report, work files that must stay
 * home), its mesh tileset listed in `tilesets.json`, and two packs installed: customer-licensed
 * imagery over the site and terrain far from it.
 */
async function writeProcessedProject(dataRoot: DataRoot): Promise<string> {
  const dir = join(dataRoot.root, 'projects', SITE.id);
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: SITE.id,
    name: SITE.name,
    crs: { epsg: 32639 },
    origin: SITE.origin,
    captures: [{ id: 'c1', label: 'Survey 1 June 2026', date: '2026-06-01' }],
    layers: [],
    severityModels: [],
    classCatalogues: [],
  };
  const put = async (rel: string, data: string | Buffer) => {
    const file = join(dir, ...rel.split('/'));
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, data);
  };
  await put('manifest.json', JSON.stringify(ProjectManifest.parse(input), null, 2));
  await put('issues.json', JSON.stringify({ schema: 'aio.issues/1', issues: [] }));
  const run = 'photogrammetry/r1';
  await put(
    `${run}/run.json`,
    JSON.stringify({ schema: 'aio.photo-run/1', id: 'r1', status: 'done' }),
  );
  await put(
    `${run}/gcp.json`,
    JSON.stringify({ schema: 'aio.gcp/1', crs: { epsg: 32639 }, points: [] }),
  );
  await put(`${run}/report/accuracy.json`, JSON.stringify({ points: [] }));
  await put(`${run}/work/database.db`, Buffer.alloc(1024 * 1024));
  await put(`${run}/work/products/k/depth.bin`, Buffer.alloc(4096, 7));
  await put('tiles/r1-mesh/quad.glb', tinyGlb());
  await put(
    'tiles/r1-mesh/tileset.json',
    JSON.stringify(enuTileset(LON, LAT, SITE.origin[2], 'quad.glb'), null, 2),
  );
  await put(
    'tilesets.json',
    JSON.stringify(
      {
        schema: 'aio.tilesets/1',
        entries: [
          {
            id: 'r1-mesh',
            name: 'Run r1 mesh',
            kind: 'mesh',
            src: 'tiles/r1-mesh/tileset.json',
            visible: true,
          },
        ],
      },
      null,
      2,
    ),
  );

  const near = [LON - 0.05, LAT - 0.05, LON + 0.05, LAT + 0.05] as const;
  await writeRasterPack(dataRoot.root, {
    meta: {
      ...syntheticPackMeta(IMAGERY_ID, 'imagery', near, 0, 15),
      label: IMAGERY_LABEL,
      licence: 'Survey Co imagery licence',
      customerLicence: true,
    },
    pmtiles: pmtilesOf({
      bbox: near,
      minZoom: 0,
      maxZoom: 15,
      tile: solidPng(256, MAGENTA),
      tileType: 'png',
    }),
  });
  const far = [10, 50, 10.1, 50.1] as const;
  await writeRasterPack(dataRoot.root, {
    meta: syntheticPackMeta(FAR_TERRAIN_ID, 'terrain', far, 0, 8),
    pmtiles: pmtilesOf({
      bbox: far,
      minZoom: 0,
      maxZoom: 8,
      tile: solidPng(256, [128, 0, 0, 255]),
      tileType: 'png',
    }),
  });
  return dir;
}

test.beforeEach(async ({ dataRoot }) => {
  await writeProcessedProject(dataRoot);
});

/** Answer the next native save dialog with `file` (main process). */
async function stubSaveDialog(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, file);
}

/** Every file under `dir` with its size and modification time (none when `dir` is missing). */
async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      const p = join(d, n);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p, `${rel}${n}/`);
      else out.push(`${rel}${n} ${String(s.size)} ${String(s.mtimeMs)}`);
    }
  };
  await walk(dir, '');
  return out;
}

/** What the Globe shows (`GlobeController.inspect()` through the hook on its element). */
const inspect = (win: Page) =>
  win.evaluate(() => {
    const el = document.querySelector('[data-testid="globe-canvas"]');
    const c = (el as { __aioGlobe?: { inspect(): unknown } } | null)?.__aioGlobe;
    return (c?.inspect() ?? null) as GlobeInspection | null;
  });

/** Poll the Globe until `ok`; a timeout says what it last showed. */
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
    const s = last as GlobeInspection | null;
    const state = s
      ? `flying ${String(s.flying)}, height ${s.cameraHeight.toFixed(0)} m, tiles loaded ${String(s.tilesLoaded)}, imagery ${s.imagery.join(',')}, ${String(s.imageryTiles)} pack tiles`
      : 'no Globe';
    throw new Error(`${what} within ${String(SETTLE_MS)} ms: ${state}`, { cause: e });
  }
}

async function openGlobe(win: Page) {
  await win.locator('.sb-nav .nav-item', { hasText: 'Globe' }).click();
  await expect(win.getByTestId('globe-canvas').locator('canvas')).toBeVisible();
  await settle(win, 'the Globe placed the sites', (s) => s.sites.length > 0);
}

/** The pitch of the Globe's camera, degrees (-90 looks straight down); null without a Globe. */
const cameraPitch = async (win: Page) => {
  const cam = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="globe-canvas"]');
    const c = (el as { __aioGlobe?: { camera(): GlobeCamera } } | null)?.__aioGlobe;
    return c?.camera() ?? null;
  });
  return cam ? headingPitch(cam).pitch : null;
};

/** Where a site's pin is drawn and the canvas size, in CSS pixels; null when not on screen. */
const pinOf = (win: Page, projectId: string) =>
  win.evaluate((id) => {
    const el = document.querySelector('[data-testid="globe-canvas"]');
    const c = (el as { __aioGlobe?: { pinPosition(id: string): [number, number] | null } } | null)
      ?.__aioGlobe;
    const at = c?.pinPosition(`site:${id}`) ?? null;
    const box = el?.getBoundingClientRect();
    return at && box ? { at, width: box.width, height: box.height } : null;
  }, projectId);

/** The colour the Globe draws at a point of its canvas (fractions), after its next frame. */
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

test('a processed project travels as a package with its ticked imagery; the player shows it and writes nothing', async ({
  app,
  win,
  dataRoot,
}) => {
  const outDir = join(dataRoot.base, 'out');
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `${PACKAGE_ID}.aio`);

  // ---- the builder shares the project, with the imagery ticked
  await win.getByTestId('project-card').filter({ hasText: SITE.name }).click();
  await expect(win.locator('.proj-switch')).toContainText(SITE.name, { timeout: 60_000 });
  await win.locator('.nav-item', { hasText: 'Reports' }).first().click();
  await win.getByTestId('export-package').click();
  const dialog = win.getByTestId('package-export');
  await expect(dialog).toBeVisible();
  const size = dialog.getByTestId('pkg-size');
  await expect(size).not.toContainText('...');
  const raster = dialog.getByTestId('pkg-raster');
  await expect(raster).toContainText('Imagery and terrain');
  const tick = raster.getByTestId(`pkg-raster-imagery-${IMAGERY_ID}`);
  await expect(tick).toBeVisible();
  await expect(tick).not.toBeChecked();
  await expect(raster).toContainText(IMAGERY_LABEL);
  await expect(raster).toContainText(
    'Licensed to you by the provider (Survey Co imagery licence). Send it only if the licence allows this recipient to see it.',
  );
  // the terrain pack far from the site is not offered
  await expect(raster.getByTestId(`pkg-raster-terrain-${FAR_TERRAIN_ID}`)).toHaveCount(0);
  const before = await size.innerText();
  await tick.check();
  await expect(size).not.toHaveText(before);
  await stubSaveDialog(app, file);
  await dialog.getByTestId('pkg-export').click();
  await expect(dialog.getByTestId('pkg-done')).toBeVisible({ timeout: 180_000 });
  await win.keyboard.press('Escape');

  // ---- the package carries the run's records, the tiles and the cut pack, never work files
  const zip = await openZip(file);
  const names = [...zip.entries.keys()];
  for (const name of [
    'photogrammetry/r1/run.json',
    'photogrammetry/r1/gcp.json',
    'photogrammetry/r1/report/accuracy.json',
    'tilesets.json',
    'tiles/r1-mesh/tileset.json',
    `packs/imagery/${IMAGERY_ID}.pmtiles`,
    `packs/imagery/${IMAGERY_ID}.json`,
  ])
    expect(names, name).toContain(name);
  expect(names.filter((n) => n.startsWith('photogrammetry/r1/work/'))).toEqual([]);
  expect(names.filter((n) => n.startsWith(`packs/terrain/`))).toEqual([]);
  const packMeta = JSON.parse(
    (await zip.read(`packs/imagery/${IMAGERY_ID}.json`)).toString('utf8'),
  ) as { bbox: number[]; customerLicence: boolean };
  expect(packMeta.customerLicence).toBe(true);
  // cut to the site: narrower than the installed pack's 0.1 degree
  expect((packMeta.bbox[2] ?? 0) - (packMeta.bbox[0] ?? 0)).toBeLessThan(0.1);

  // ---- another machine, no pack installed: the player
  const customer = await createDataRoot();
  const network = new NetworkGuard();
  const player = await launchApp(customer);
  await network.attach(player);
  try {
    const pw = await player.firstWindow();
    await pw.waitForLoadState('domcontentloaded');
    await expect(pw.getByTestId('project-card').first()).toBeVisible({ timeout: 60_000 });
    // the Globe once with no project open
    await openGlobe(pw);
    await pw.locator('.sb-nav .nav-item', { hasText: 'Projects' }).click();
    await expect(pw.getByTestId('globe-canvas')).toHaveCount(0);

    const pkgFolderBefore = await listing(outDir);
    const projectsBefore = await listing(join(customer.root, 'projects'));

    // the package arrives as a second launch hands it over
    await player.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('app:openPath', { path });
    }, file);
    await expect(pw.getByTestId('readonly-chip')).toHaveText('Read-only package', {
      timeout: 60_000,
    });

    // the Globe opens on the whole Earth centred over the package's site, not where it was left
    await openGlobe(pw);
    await settle(
      pw,
      "the whole Earth over the package's site",
      (s) => !s.flying && s.cameraHeight >= WHOLE_EARTH_HEIGHT_M && s.sites.includes(PACKAGE_ID),
    );
    expect(await cameraPitch(pw), 'the camera looks straight down').toBeLessThan(-89);
    const pin = await pinOf(pw, PACKAGE_ID);
    expect(pin, 'the package site is on screen').not.toBeNull();
    if (pin) {
      expect(Math.abs(pin.at[0] - pin.width / 2)).toBeLessThan(pin.width * 0.05);
      expect(Math.abs(pin.at[1] - pin.height / 2)).toBeLessThan(pin.height * 0.05);
    }
    // picked in the field, the site is flown to (its card closed again to keep the view clear)
    {
      await pw.getByRole('combobox', { name: 'Find a site' }).click();
      const sites = pw.getByTestId('globe-sites');
      await sites
        .getByRole('option', { name: new RegExp(SITE.name.replace(/[()]/g, '\\$&')) })
        .click();
      await expect(sites).toHaveCount(0);
      const card = pw.getByTestId('globe-card');
      await expect(card).toContainText(SITE.name);
      await settle(
        pw,
        "the flight to the package's site ended",
        (s) => !s.flying && s.cameraHeight < 5000,
      );
      await card.getByRole('button', { name: 'Close' }).click();
      await expect(card).toHaveCount(0);
    }

    // the Map menu lists the package's pack (listed under its package id)
    await pw.getByTestId('globe-map-button').click();
    const menu = pw.getByTestId('globe-map-menu');
    await expect(menu).toBeVisible();
    const packsOn = menu.getByTestId('map-ontop-packs').getByRole('switch');
    if ((await packsOn.getAttribute('aria-checked')) !== 'true') await packsOn.click();
    await expect(packsOn).toHaveAttribute('aria-checked', 'true');
    const option = menu.getByTestId('map-pack').locator(`option[value="${PACKAGE_RASTER_ID}"]`);
    await expect(option).toHaveCount(1);
    await expect(option).toHaveText(IMAGERY_LABEL);
    await expect(menu.getByTestId('map-pack').locator('option')).toHaveCount(2);
    await packsOn.focus();
    await pw.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // and draws it from inside the package: the pack's magenta near the site
    await settle(
      pw,
      "the package's imagery tiles loaded",
      (s) => s.imagery.includes(PACKAGE_RASTER_ID) && s.tilesLoaded && s.imageryTiles > 0,
    );
    const px = await sampleAt(pw, 0.44, 0.62);
    expect(px?.[0], JSON.stringify(px)).toBeGreaterThan(150);
    expect(px?.[1], JSON.stringify(px)).toBeLessThan(100);
    expect(px?.[2], JSON.stringify(px)).toBeGreaterThan(110);

    // the site card: the package's name and its tileset
    await pw.getByRole('combobox', { name: 'Find a site' }).click();
    const list = pw.getByTestId('globe-sites');
    await expect(list).toBeVisible();
    await list
      .getByRole('option', { name: new RegExp(SITE.name.replace(/[()]/g, '\\$&')) })
      .click();
    const card = pw.getByTestId('globe-card');
    await expect(card).toContainText(SITE.name);
    await expect(card).toContainText('1 tileset');

    // processing stays closed in a package
    await pw.keyboard.press('Control+K');
    const palette = pw.getByRole('dialog', { name: 'Command search' });
    await expect(palette).toBeVisible();
    await pw.keyboard.type('Processing');
    await palette.getByText('Processing', { exact: true }).click();
    const drawer = pw.getByTestId('processing-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('proc-none')).toHaveText(
      'A read-only package has no processing of its own.',
    );
    await expect(drawer.getByTestId('create-maps')).toHaveCount(0);
    await drawer.getByTestId('proc-close').click();
    const started = await pw.evaluate(
      (project) =>
        window.aio.invoke('jobs:start', {
          pipeline: 'tiles.mesh',
          project,
          params: { src: 'models/site.glb', name: 'Site grid' },
        }),
      file,
    );
    expect(started.ok).toBe(false);

    // nothing written next to the package or into the projects folder
    expect(await listing(outDir)).toEqual(pkgFolderBefore);
    expect(await listing(join(customer.root, 'projects'))).toEqual(projectsBefore);
    expect(await network.outbound(), 'the player made network requests').toEqual([]);
  } finally {
    await player.close();
    await rm(customer.base, { recursive: true, force: true });
  }
});
