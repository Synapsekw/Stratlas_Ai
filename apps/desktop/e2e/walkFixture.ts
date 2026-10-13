/**
 * A project to place a walk in (walk-place*.spec.ts), written into a test's own data root, never
 * into the shared fixtures: a local grid (no map) or a UTM frame, one survey date, one picture
 * drawing that is placed (`drawings/ground-floor/`, optional), and one walk folder `walks/w1/` as
 * a W1 import leaves it, with the synthetic `raw-path.json` of
 * `packages/schema/src/__fixtures__/walk/` beside it (optional: a walk never processed has none).
 *
 * The video is a small equirectangular test pattern made by ffmpeg. It runs 64 s because the
 * synthetic path walks from 4 s to 62 s, and Place walk seeks to those moments.
 */
import { placementFor, walkLayerFor } from '@aio/project/builder';
import {
  ProjectManifest,
  SCHEMA_VERSION,
  WalkFile,
  type ProjectManifestInput,
  type RasterCorners,
} from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, tinyGlb } from './fixtures';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

export const WALK_PROJECT = { id: 'e2e-walk', name: 'E2E walk project' } as const;
export const WALK_ID = 'w1';
export const WALK_LAYER = `walk-${WALK_ID}`;
export const WALK_NAME = 'Ground floor walk';
export const SHEET_LAYER = 'sheet-ground-floor';
/** The drawing's picture, pixels. */
export const SHEET_PX = { width: 400, height: 200 } as const;
/** 0.2 m per pixel, north up: the sheet spans 80 m east to west and 40 m north to south. */
const CORNERS: RasterCorners = { tl: [-40, 0, -20], tr: [40, 0, -20], bl: [-40, 0, 20] };
export const VIDEO_S = 64;

/** The UTM frame of `crs: 'utm'`: zone 33 north, the model origin at this easting and northing. */
export const UTM = { epsg: 32633, origin: [500_000, 4_000_000, 0] as const };

/**
 * The model point (x east, z south) of the synthetic walk at its start (t 4) and end (t 62): it
 * stands at the origin, then walks 40 m east and 30 m north (`tools/fixtures/walk-truth.mjs`).
 */
export const WALK_START: [number, number] = [0, 0];
export const WALK_END: [number, number] = [40, -30];

export interface WalkProjectOptions {
  /** `local` (default): a site grid, no map. `utm`: EPSG 32633 with an origin, so the map works. */
  crs?: 'local' | 'utm';
  /** The placed drawing (default true). */
  drawing?: boolean;
  /** The raw path `walk.process` writes (default true); false: a walk never processed. */
  processed?: boolean;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const RAW_PATH = join(
  import.meta.dirname,
  '../../../packages/schema/src/__fixtures__/walk/raw-path.synthetic.json',
);

/** ffmpeg is there and encodes H.264. */
export function ffmpegReady(): boolean {
  try {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return r.status === 0 && /\slibx264\s/.test(r.stdout);
  } catch {
    return false;
  }
}

/** A 2:1 test pattern of `seconds`, small and at 10 frames a second, so it is made in a moment. */
function makeEquirect(out: string, seconds: number): void {
  const r = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=256x128:r=10:d=${String(seconds)}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '10',
      '-an',
      '-f',
      'mp4',
      out,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** The drawing's picture and its placement, in `sheetDir`. */
async function writeSheet(sheetDir: string): Promise<void> {
  await mkdir(sheetDir, { recursive: true });
  await writeFile(
    join(sheetDir, 'plan.png'),
    await sharp({
      create: {
        width: SHEET_PX.width,
        height: SHEET_PX.height,
        channels: 3,
        background: '#f4f4f0',
      },
    })
      .png()
      .toBuffer(),
  );
  await writeFile(
    join(sheetDir, 'placement.json'),
    JSON.stringify(
      placementFor('ground-floor.png', CORNERS, SHEET_PX.width, SHEET_PX.height, false),
      null,
      2,
    ),
  );
}

/** Write `projects/e2e-walk/` into the data root `root`; answers the project folder. */
export async function createWalkProject(
  root: string,
  opts: WalkProjectOptions = {},
): Promise<string> {
  const utm = opts.crs === 'utm';
  const drawing = opts.drawing ?? true;
  const processed = opts.processed ?? true;
  const dir = join(root, 'projects', WALK_PROJECT.id);
  const walkDir = join(dir, 'walks', WALK_ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(walkDir, { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );

  // the drawing, placed
  if (drawing) await writeSheet(join(dir, 'drawings', 'ground-floor'));

  // the walk, as a W1 import of a stitched MP4 leaves it, plus the path walk.process would write
  makeEquirect(join(walkDir, 'playback.mp4'), VIDEO_S);
  if (processed) await copyFile(RAW_PATH, join(walkDir, 'raw-path.json'));
  const walk = WalkFile.parse({
    schema: 'aio.walk/1',
    id: WALK_ID,
    name: WALK_NAME,
    createdAt: '2026-03-05T10:00:00Z',
    source: {
      file: 'Ground floor walk.mp4',
      layout: 'equirect',
      streams: [{ width: 256, height: 128, codec: 'avc1', fps: 10 }],
    },
    video: {
      src: `walks/${WALK_ID}/playback.mp4`,
      width: 256,
      height: 128,
      durationS: VIDEO_S,
      fps: 10,
      audio: false,
    },
  });
  await writeFile(join(walkDir, 'walk.json'), JSON.stringify(walk, null, 2));

  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: WALK_PROJECT.id,
    name: WALK_PROJECT.name,
    customer: 'E2E',
    site: 'Synthetic site',
    // a local grid: no map to place on; a UTM frame: the map works
    ...(utm
      ? { crs: { epsg: UTM.epsg }, origin: [...UTM.origin] }
      : { crs: { wkt: 'LOCAL_CS["Site grid",UNIT["metre",1]]' }, origin: [0, 0, 0] }),
    captures: [{ id: 'capture-1', label: 'Walk survey', date: '2026-03-05' }],
    layers: [
      {
        kind: 'mesh',
        id: 'quad',
        name: 'Unit quad',
        src: { path: 'models/quad.glb' },
        transform: IDENTITY,
      },
      ...(drawing
        ? [
            {
              kind: 'raster' as const,
              id: SHEET_LAYER,
              name: 'Ground floor.png',
              visible: true,
              src: { path: 'drawings/ground-floor/plan.png' },
              role: 'plan' as const,
              format: 'image' as const,
              corners: CORNERS,
            },
          ]
        : []),
    ],
    severityModels: [],
    classCatalogues: [],
  };
  const base = ProjectManifest.parse(input);
  // no survey date on the walk yet: Place walk offers one
  const layer = walkLayerFor(walk, base, { raw: processed, orientation: false, points: false });
  const manifest = ProjectManifest.parse({ ...base, layers: [...base.layers, layer] });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * The saved pose's bend: the largest distance of a sample from the line through the first and
 * last walking samples, metres. The synthetic L puts its corner 24 m off that line.
 */
export async function poseBendM(dir: string): Promise<number> {
  const pose = JSON.parse(await readFile(join(dir, 'walks', WALK_ID, 'pose.json'), 'utf8')) as {
    samples: { t: number; pos: [number, number, number] }[];
  };
  const s = pose.samples.filter((x) => x.t >= 4 && x.t <= 62);
  const a = s[0]?.pos;
  const b = s.at(-1)?.pos;
  if (!a || !b) return 0;
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dz);
  if (!(len > 0)) return 0;
  return Math.max(...s.map((x) => Math.abs(dx * (x.pos[2] - a[2]) - dz * (x.pos[0] - a[0])) / len));
}

/** Open the walk project from the projects list; the 3D view is up. */
export async function openWalkProject(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: WALK_PROJECT.name }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
}

/** The walk's row in the Datasets list, with its folder opened when the date put it in one. */
export async function walkRow(win: Page): Promise<Locator> {
  const row = win.getByTestId(`tree-row-${WALK_LAYER}`);
  if (!(await row.isVisible())) {
    const folder = win.getByTestId('date-folder-capture-1');
    if ((await folder.getAttribute('aria-expanded')) === 'false')
      await folder.getByRole('button').first().click();
  }
  await expect(row).toBeVisible();
  return row;
}

/** Press one of the row's action buttons; they show on hover or focus. */
export async function rowAction(
  win: Page,
  kind: 'open' | 'place' | 'edit' | 'unplace' | 'remove',
): Promise<void> {
  const row = await walkRow(win);
  await row.hover();
  await win.getByTestId(`walk-${kind}-${WALK_LAYER}`).click();
}
