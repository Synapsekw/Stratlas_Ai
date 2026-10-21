/**
 * A project to edit photo positions in (photo-position-edit.spec.ts), written into a test's own
 * data root as `pinFixture.ts` does, so the pinned-media specs keep their counts: one survey date
 * (1 Oct 2026) with a 30 x 30 m flat ground, an offline street map pack and a photos layer
 * `photos-pos` holding `g1` and `g2` (GPS photos with a place and a level camera) and `pn` (a
 * photo pinned on the ground). The site is on EPSG 32639 with its origin at height 0, so the
 * panel's X, Y, Z of a model point (x, y, z) are x, -z and y.
 *
 * Also the synthetic XT2-style photos of the thermal twin and re-read cases: the XT2 heads of
 * `@aio/project/builder/testing` put on real JPEG pixels, so the import can make its review
 * copies and thumbnails from them.
 */
import { cameraQuatFromGimbal, fromWgs84, toWgs84 } from '@aio/geo';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput, type Vec3 } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { pmtilesArchive, tilesOver } from '../src/main/testing';
import { expect, tinyGlb } from './fixtures';

export const POS_PROJECT = { id: 'e2e-position', name: 'E2E photo position' } as const;
export const POS_LAYER = 'photos-pos';
/** Where the photos stand (model frame: x east, y up, z south). */
export const G1_POS: Vec3 = [-8, 20, 6];
export const G2_POS: Vec3 = [8, 22, 6];
export const PN_GROUND: Vec3 = [0, 0, -8];
/** The site, lon and lat. */
export const SITE: [number, number] = [47.98, 29.38];
export const EPSG = 32639;
/** The e2e 1 m quad stretched to a 30 x 30 m ground centred on the origin (pinFixture.ts). */
const GROUND = [30, 0, 0, 0, 0, 1, 0, 0, 0, 0, 30, 0, -15, 0, 15, 1];

const jpegOf = (rgb: [number, number, number], width = 64, height = 48) =>
  sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .jpeg()
    .toBuffer();

/**
 * Real JPEG pixels under a synthetic head: the APP segments of `head` (an XT2-style header-only
 * JPEG) go in after the pixels' SOI; the head's own SOF and EOI are dropped.
 */
export async function onPixels(
  head: Uint8Array,
  rgb: [number, number, number] = [120, 120, 120],
): Promise<Buffer> {
  const px = await jpegOf(rgb);
  const segs: Uint8Array[] = [];
  let at = 2;
  while (at + 4 <= head.length && head[at] === 0xff) {
    const marker = head[at + 1] ?? 0;
    if (marker < 0xe0 || marker > 0xef) break;
    const len = ((head[at + 2] ?? 0) << 8) | (head[at + 3] ?? 0);
    segs.push(head.subarray(at, at + 2 + len));
    at += 2 + len;
  }
  return Buffer.concat([px.subarray(0, 2), ...segs, px.subarray(2)]);
}

/** Lon and lat of a model point of the project. */
export function lonLatOf(p: Vec3): [number, number] {
  const o = fromWgs84([SITE[0], SITE[1], 0], EPSG);
  const ll = toWgs84([o[0] + p[0], o[1] - p[2], 0], EPSG);
  return [ll[0], ll[1]];
}

export interface PositionProjectOptions {
  /** More layers to add (the re-read case), with the files they need under the project. */
  extraLayers?: ProjectManifestInput['layers'];
  files?: Record<string, Uint8Array>;
}

/** Write `projects/e2e-position/` into `root` (a data root); returns the project folder. */
export async function createPositionProject(
  root: string,
  opts: PositionProjectOptions = {},
): Promise<string> {
  const dir = join(root, 'projects', POS_PROJECT.id);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'photos'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(join(dir, 'photos', 'g1.jpg'), await jpegOf([200, 140, 90]));
  await writeFile(join(dir, 'photos', 'g2.jpg'), await jpegOf([90, 200, 140]));
  await writeFile(join(dir, 'photos', 'pn.jpg'), await jpegOf([140, 90, 200]));
  for (const [rel, bytes] of Object.entries(opts.files ?? {})) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), bytes);
  }

  const origin = fromWgs84([SITE[0], SITE[1], 0], EPSG);
  const level = cameraQuatFromGimbal(0, 0, 0);
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: POS_PROJECT.id,
    name: POS_PROJECT.name,
    customer: 'E2E',
    site: 'Synthetic site, photo positions',
    crs: { epsg: EPSG },
    origin: [origin[0], origin[1], 0],
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
        kind: 'photos',
        id: POS_LAYER,
        name: 'Photos',
        capture: 'c1',
        items: [
          {
            id: 'g1',
            src: { path: 'photos/g1.jpg' },
            takenAt: '2026-10-01T09:00:00Z',
            pos: G1_POS,
            q: level,
          },
          {
            id: 'g2',
            src: { path: 'photos/g2.jpg' },
            takenAt: '2026-10-01T09:01:00Z',
            pos: G2_POS,
            q: level,
          },
          {
            id: 'pn',
            src: { path: 'photos/pn.jpg' },
            takenAt: '2026-10-01T09:02:00Z',
            pos: [PN_GROUND[0], 1.6, PN_GROUND[2]],
            q: level,
            pin: { ground: PN_GROUND, eyeM: 1.6, headingDeg: 0 },
          },
        ],
      },
      ...(opts.extraLayers ?? []),
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
  await writeFile(join(root, 'packs', 'e2e-position.pmtiles'), archive);
  await writeFile(
    join(root, 'packs', 'e2e-position.json'),
    JSON.stringify({
      id: 'e2e-position',
      label: 'E2E position site',
      bbox,
      maxZoom: 14,
      sizeBytes: archive.length,
    }),
  );
  return dir;
}

/** A photo of the manifest as the specs read it. */
export interface PosItem {
  id: string;
  src: { path: string };
  takenAt?: string;
  pos?: [number, number, number];
  q?: number[];
  pin?: unknown;
}

interface PosManifest {
  layers: { id: string; kind: string; items?: PosItem[] }[];
}

/** The project's manifest on disk. */
export async function readManifest(dir: string): Promise<PosManifest> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as PosManifest;
}

/** Item `id` of layer `layerId` on disk, or undefined. */
export async function itemOf(
  dir: string,
  layerId: string,
  id: string,
): Promise<PosItem | undefined> {
  const m = await readManifest(dir);
  return m.layers.find((l) => l.id === layerId)?.items?.find((i) => i.id === id);
}

export interface Correction {
  yawDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;
  offsetM?: [number, number, number];
}

/** `orientation.json` of the project, empty when it does not exist yet. */
export async function readOrientation(
  dir: string,
): Promise<{ photos: Record<string, Record<string, Correction> | undefined> }> {
  try {
    return JSON.parse(await readFile(join(dir, 'orientation.json'), 'utf8')) as {
      photos: Record<string, Record<string, Correction> | undefined>;
    };
  } catch {
    return { photos: {} };
  }
}

/** The correction of one photo on disk, or undefined. */
export async function correctionOf(
  dir: string,
  layerId: string,
  id: string,
): Promise<Correction | undefined> {
  return (await readOrientation(dir)).photos[layerId]?.[id];
}

/** Open the position project from the projects list and wait until it is the open project. */
export async function openPositionProject(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: POS_PROJECT.name }).first().click();
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
    .toBe(POS_PROJECT.id);
}
