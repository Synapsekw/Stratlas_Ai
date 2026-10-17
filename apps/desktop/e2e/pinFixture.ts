/**
 * A project to pin photos and 360s in (pinned-media*.spec.ts), written into a test's own data
 * root: one survey date (1 Oct 2026) with a 30 x 30 m flat ground as its model, a panoramas layer
 * `panos-2026-10-01` holding `p1` (a 64 x 32 equirect with no place) and a photos layer
 * `photos-2026-10-01` holding `ph1` (a 4:3 JPEG with no place), `ph2` (a 2:1 JPEG, for Treat as
 * 360, no place) and `ph3` (a GPS photo with a place and a level camera looking north).
 *
 * `crs: 'utm'` puts the site on EPSG 32639 so the map works; `basemap` adds the empty pmtiles
 * pack of `photo-align.spec.ts` over it, so the map draws offline.
 */
import { cameraQuatFromGimbal, fromWgs84, toWgs84 } from '@aio/geo';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput, type Vec3 } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { pmtilesArchive, tilesOver } from '../src/main/testing';
import { expect, tinyGlb } from './fixtures';
import { solidPng } from './panoFixtures';

export const PIN_PROJECT = { id: 'e2e-pins', name: 'E2E pinned media' } as const;
export const PANO_LAYER = 'panos-2026-10-01';
export const PHOTO_LAYER = 'photos-2026-10-01';
/** Where the GPS photo `ph3` stands (model frame: x east, y up, z south). */
export const PH3_POS: Vec3 = [-30, 1.6, 30];
/** The site of `crs: 'utm'`, lon and lat. */
const SITE: [number, number] = [47.98, 29.38];
const EPSG = 32639;
/**
 * The e2e 1 m quad (x 0 to 1, z -1 to 0) stretched to a 30 x 30 m ground centred on the origin,
 * so the 3D view may look down from high enough to see 10 m around a pin there (a 1 m model
 * keeps the camera close). Outside it (x or z beyond 15 m) the site has no height.
 */
const GROUND = [30, 0, 0, 0, 0, 1, 0, 0, 0, 0, 30, 0, -15, 0, 15, 1];
/** Half the width of that ground, metres. */
export const GROUND_HALF_M = 15;

export interface PinProjectOptions {
  /** `local` (default): a site grid, no map. `utm`: EPSG 32639 with an origin, so the map works. */
  crs?: 'local' | 'utm';
  /** An offline street map pack over the site (needs `crs: 'utm'`). */
  basemap?: boolean;
}

const jpeg = (width: number, height: number, rgb: [number, number, number]) =>
  sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .jpeg()
    .toBuffer();

/** Write `projects/e2e-pins/` into `root` (a data root); returns the project folder. */
export async function createPinProject(
  root: string,
  opts: PinProjectOptions = {},
): Promise<string> {
  const utm = opts.crs === 'utm';
  const dir = join(root, 'projects', PIN_PROJECT.id);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'panoramas'), { recursive: true });
  await mkdir(join(dir, 'photos'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(join(dir, 'panoramas', 'p1.png'), solidPng(64, 32, [90, 130, 200]));
  await writeFile(join(dir, 'photos', 'ph1.jpg'), await jpeg(64, 48, [200, 140, 90]));
  await writeFile(join(dir, 'photos', 'ph2.jpg'), await jpeg(256, 128, [90, 200, 140]));
  await writeFile(join(dir, 'photos', 'ph3.jpg'), await jpeg(64, 48, [140, 90, 200]));

  const origin = fromWgs84([SITE[0], SITE[1], 0], EPSG);
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: PIN_PROJECT.id,
    name: PIN_PROJECT.name,
    customer: 'E2E',
    site: 'Synthetic site, media to pin',
    ...(utm
      ? { crs: { epsg: EPSG }, origin: [origin[0], origin[1], 0] as Vec3 }
      : { crs: { wkt: 'LOCAL_CS["Site grid",UNIT["metre",1]]' }, origin: [0, 0, 0] as Vec3 }),
    captures: [{ id: 'c1', label: '1 Oct 2026', date: '2026-10-01' }],
    layers: [
      {
        kind: 'mesh',
        id: 'quad',
        name: 'Unit quad',
        capture: 'c1',
        src: { path: 'models/quad.glb' },
        transform: GROUND,
      },
      {
        kind: 'panoramas',
        id: PANO_LAYER,
        name: 'Panoramas',
        capture: 'c1',
        items: [{ id: 'p1', src: { path: 'panoramas/p1.png' }, headingDeg: 0 }],
      },
      {
        kind: 'photos',
        id: PHOTO_LAYER,
        name: 'Photos',
        capture: 'c1',
        items: [
          { id: 'ph1', src: { path: 'photos/ph1.jpg' }, takenAt: '2026-10-01T09:00:00Z' },
          { id: 'ph2', src: { path: 'photos/ph2.jpg' }, takenAt: '2026-10-01T09:01:00Z' },
          {
            id: 'ph3',
            src: { path: 'photos/ph3.jpg' },
            takenAt: '2026-10-01T09:02:00Z',
            pos: PH3_POS,
            q: cameraQuatFromGimbal(0, 0, 0),
          },
        ],
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );

  if (opts.basemap) {
    const bbox: [number, number, number, number] = [
      SITE[0] - 0.03,
      SITE[1] - 0.03,
      SITE[0] + 0.03,
      SITE[1] + 0.03,
    ];
    const archive = pmtilesArchive({
      tiles: tilesOver(bbox, 0, 14, () => Buffer.alloc(0)),
      bbox,
      minZoom: 0,
      maxZoom: 14,
    });
    await mkdir(join(root, 'packs'), { recursive: true });
    await writeFile(join(root, 'packs', 'e2e-pins.pmtiles'), archive);
    await writeFile(
      join(root, 'packs', 'e2e-pins.json'),
      JSON.stringify({
        id: 'e2e-pins',
        label: 'E2E pins site',
        bbox,
        maxZoom: 14,
        sizeBytes: archive.length,
      }),
    );
  }
  return dir;
}

/** Lon and lat of a model point of the `crs: 'utm'` project. */
export function lonLatOf(p: Vec3): [number, number] {
  const o = fromWgs84([SITE[0], SITE[1], 0], EPSG);
  const ll = toWgs84([o[0] + p[0], o[1] - p[2], 0], EPSG);
  return [ll[0], ll[1]];
}

/** Make the next native open dialog return these files (Electron main process). */
export async function nextOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

/** A photo or 360 of the manifest as the specs read it. */
export interface MediaItem {
  id: string;
  src: { path: string };
  pos?: [number, number, number];
  q?: number[];
  headingDeg?: number;
  pin?: { ground: [number, number, number]; eyeM: number; headingDeg?: number };
}

export interface PinManifest {
  layers: { id: string; kind: string; items?: MediaItem[] }[];
}

/** The project's manifest on disk. */
export async function readPinManifest(dir: string): Promise<PinManifest> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as PinManifest;
}

/** Item `id` of layer `layerId` on disk, or undefined. */
export async function itemOf(
  dir: string,
  layerId: string,
  id: string,
): Promise<MediaItem | undefined> {
  const m = await readPinManifest(dir);
  return m.layers.find((l) => l.id === layerId)?.items?.find((i) => i.id === id);
}

/** Open the pin project from the projects list and wait until it is the open project. */
export async function openPinProject(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: PIN_PROJECT.name }).first().click();
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            (
              window as unknown as {
                __stratlas: {
                  workspace: { getState(): { project: { manifest: { id: string } } | null } };
                };
              }
            ).__stratlas.workspace.getState().project?.manifest.id ?? null,
        ),
      { timeout: 30_000 },
    )
    .toBe(PIN_PROJECT.id);
}

/** Go to the Media screen. */
export async function openMedia(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Media' }).first().click();
}

/** The "Not placed" chip of item `id` on its Media tile. */
export const notPlaced = (win: Page, id: string) =>
  win.locator(`[data-testid="media-not-placed"][data-item="${id}"]`);

/** Right-click a Media tile (a photo's or a 360's) and choose `item` from its menu. */
export async function tileAction(
  win: Page,
  tile: { photo: string } | { pano: string },
  item: string,
): Promise<void> {
  const sel = 'photo' in tile ? `[data-photo="${tile.photo}"]` : `[data-pano="${tile.pano}"]`;
  const el = win.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  await el.click({ button: 'right' });
  await win.getByRole('menuitem', { name: item, exact: true }).click();
}
