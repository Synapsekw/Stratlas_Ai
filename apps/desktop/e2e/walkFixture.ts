/**
 * A project to place a walk in (walk-place*.spec.ts), written into a test's own data root, never
 * into the shared fixtures: a local grid (no map) or a UTM frame, one survey date, one picture
 * drawing that is placed (`drawings/ground-floor/`, optional), and one walk folder `walks/w1/` as
 * a W1 import leaves it, with the synthetic `raw-path.json` of
 * `packages/schema/src/__fixtures__/walk/` beside it (optional: a walk never processed has none).
 *
 * The video is a small equirectangular test pattern made by ffmpeg, unless a spec brings its own
 * (`video`). It runs 64 s because the synthetic path walks from 4 s to 62 s, and Place walk seeks
 * to those moments.
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
  /** The playback copy (default: a 256 x 128 test pattern of `VIDEO_S`). */
  video?: WalkVideo;
}

/** A playback copy a spec makes itself, with the numbers `walk.json` records for it. */
export interface WalkVideo {
  /** Write the MP4 to `out`. */
  make: (out: string) => Promise<void> | void;
  width: number;
  height: number;
  durationS: number;
  fps: number;
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
  const video = opts.video ?? {
    make: (out: string) => {
      makeEquirect(out, VIDEO_S);
    },
    width: 256,
    height: 128,
    durationS: VIDEO_S,
    fps: 10,
  };
  await video.make(join(walkDir, 'playback.mp4'));
  if (processed) await copyFile(RAW_PATH, join(walkDir, 'raw-path.json'));
  const walk = WalkFile.parse({
    schema: 'aio.walk/1',
    id: WALK_ID,
    name: WALK_NAME,
    createdAt: '2026-03-05T10:00:00Z',
    source: {
      file: 'Ground floor walk.mp4',
      layout: 'equirect',
      streams: [{ width: video.width, height: video.height, codec: 'avc1', fps: video.fps }],
    },
    video: {
      src: `walks/${WALK_ID}/playback.mp4`,
      width: video.width,
      height: video.height,
      durationS: video.durationS,
      fps: video.fps,
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
  // sample times are milliseconds (`aio.flight/1`); the walking runs from 4 s to 62 s
  const s = pose.samples.filter((x) => x.t >= 4_000 && x.t <= 62_000);
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
export async function walkRow(win: Page, layer: string = WALK_LAYER): Promise<Locator> {
  const row = win.getByTestId(`tree-row-${layer}`);
  if (!(await row.isVisible())) {
    for (const folder of await win.locator('[data-testid^="date-folder-"]').all())
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
  layer: string = WALK_LAYER,
): Promise<void> {
  const row = await walkRow(win, layer);
  await row.hover();
  await win.getByTestId(`walk-${kind}-${layer}`).click();
}

// ---------------------------------------------------------------- two walks to compare

export const WALK2_ID = 'w2';
export const WALK2_LAYER = `walk-${WALK2_ID}`;
export const WALK2_NAME = 'Ground floor walk (April)';
/** The orthos of both dates lie flat this far below the model origin, metres. */
export const ORTHO_Y = -6;
const WALK1_START_S = 4;
/** The second walk stands still until this second, 8 s longer than the first. */
export const WALK2_START_S = 12;
const WALK_END_S = 62;
/** How much faster the second walk goes the same L (it ends at the same second). */
const PACE = (WALK_END_S - WALK1_START_S) / (WALK_END_S - WALK2_START_S);
/** The second of the second walk at the place the first walk is at `leadT` (off its detour). */
export const pairedT = (leadT: number): number =>
  leadT <= WALK1_START_S ? WALK2_START_S : WALK2_START_S + (leadT - WALK1_START_S) / PACE;
/**
 * Between these seconds the second walk leaves the L sideways (about 14 m at the middle) and comes
 * back: a detour, where no frame of the first walk is near.
 */
export const DETOUR_S = { from: 30, to: 46 } as const;
/** Where the second walk is placed: 2 m east and 2 m south of the first, so the two stay near. */
const WALK2_OFFSET: [number, number] = [2, 2];

type V3 = [number, number, number];
interface RawStill {
  t: number;
  pos?: V3;
}

/** The first walk's raw position at `t`, between its stills. */
function rawAt(stills: readonly RawStill[], t: number): V3 {
  const placed = stills.flatMap((s) => (s.pos ? [{ t: s.t, pos: s.pos }] : []));
  const first = placed[0];
  if (!first) throw new Error('raw path without positions');
  let prev = first;
  for (const s of placed) {
    if (s.t >= t) {
      if (s.t === prev.t) return s.pos;
      const k = (t - prev.t) / (s.t - prev.t);
      const a = prev.pos;
      return [
        a[0] + k * (s.pos[0] - a[0]),
        a[1] + k * (s.pos[1] - a[1]),
        a[2] + k * (s.pos[2] - a[2]),
      ];
    }
    prev = s;
  }
  return prev.pos;
}

/** The second walk's raw path: the first's L, started later, walked faster, with the detour. */
async function writeSecondRawPath(to: string): Promise<void> {
  const raw = JSON.parse(await readFile(RAW_PATH, 'utf8')) as {
    walk: string;
    stills: RawStill[];
    walking?: { startT: number; endT: number };
  };
  const src = raw.stills;
  // the raw frame's first leg runs along (0.88, -0.665); the detour goes off square to it, up to
  // 3.2 raw units (the fit scales the raw frame about 4.4 times)
  const side = [0.603, 0.798] as const;
  raw.stills = src.map((s) => {
    const srcT =
      s.t <= WALK2_START_S ? 0 : Math.min(WALK_END_S, WALK1_START_S + (s.t - WALK2_START_S) * PACE);
    const p = rawAt(src, srcT);
    const d =
      s.t > DETOUR_S.from && s.t < DETOUR_S.to
        ? 3.2 * Math.sin((Math.PI * (s.t - DETOUR_S.from)) / (DETOUR_S.to - DETOUR_S.from))
        : 0;
    return { ...s, pos: [p[0] + d * side[0], p[1], p[2] + d * side[1]] };
  });
  raw.walk = WALK2_ID;
  raw.walking = { startT: WALK2_START_S, endT: WALK_END_S };
  await writeFile(to, JSON.stringify(raw, null, 2));
}

/** A fake ortho, 100 x 80 m: fields, a road, a pad and some buildings (April adds two). */
export async function orthoPng(april = false): Promise<Buffer> {
  const extra = april
    ? '<rect x="380" y="560" width="240" height="140" fill="#cfc6b0" stroke="#6b6050" stroke-width="4"/>' +
      '<circle cx="560" cy="230" r="40" fill="#a08f72"/>'
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800">
  <defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse">
  <rect width="40" height="40" fill="#7d8a5a"/><circle cx="10" cy="12" r="6" fill="#6f7c4e"/>
  <circle cx="30" cy="28" r="8" fill="#889563"/></pattern></defs>
  <rect width="1000" height="800" fill="url(#g)"/>
  <rect x="120" y="120" width="560" height="420" fill="#b9ad94"/>
  <path d="M0 640 L1000 600" stroke="#5c5c58" stroke-width="70"/>
  <path d="M300 640 L300 300 L700 200" stroke="#a39a86" stroke-width="40" fill="none"/>
  <rect x="200" y="160" width="160" height="110" fill="#d9d4ca" stroke="#555" stroke-width="4"/>
  <rect x="480" y="300" width="150" height="160" fill="#8f99a3" stroke="#444" stroke-width="4"/>
  <rect x="740" y="120" width="200" height="140" fill="#c4c0b6" stroke="#555" stroke-width="4"/>
  <circle cx="820" cy="420" r="70" fill="#9a8f7c" stroke="#6b6050" stroke-width="6"/>
  ${extra}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * The walk project with a second date (walk-compare.spec.ts): the first walk on 5 March, a second
 * walk on 16 April that goes the same L (placed 2 m off it, later and faster, with a detour), both
 * at `ORTHO_Y` under them. A UTM frame, so the map works; the placed drawing only with `drawing`.
 * at `ORTHO_Y` under them. A UTM frame, so the map works; no drawing. Answers the project folder.
 */
export async function createWalkCompareProject(
  root: string,
  opts: { video?: WalkVideo; drawing?: boolean } = {},
): Promise<string> {
  const dir = await createWalkProject(root, {
    crs: 'utm',
    drawing: opts.drawing ?? false,
    ...(opts.video ? { video: opts.video } : {}),
  });
  const w1Dir = join(dir, 'walks', WALK_ID);
  const w2Dir = join(dir, 'walks', WALK2_ID);
  await mkdir(w2Dir, { recursive: true });
  await copyFile(join(w1Dir, 'playback.mp4'), join(w2Dir, 'playback.mp4'));
  await writeSecondRawPath(join(w2Dir, 'raw-path.json'));
  const w1 = WalkFile.parse(JSON.parse(await readFile(join(w1Dir, 'walk.json'), 'utf8')));
  const w2 = WalkFile.parse({
    ...w1,
    id: WALK2_ID,
    name: WALK2_NAME,
    createdAt: '2026-04-16T10:00:00Z',
    source: { ...w1.source, file: 'April walk.mp4' },
    video: { ...w1.video, src: `walks/${WALK2_ID}/playback.mp4` },
  });
  await writeFile(join(w2Dir, 'walk.json'), JSON.stringify(w2, null, 2));

  await mkdir(join(dir, 'rasters'), { recursive: true });
  await writeFile(join(dir, 'rasters', 'ortho-mar.png'), await orthoPng());
  await writeFile(join(dir, 'rasters', 'ortho-apr.png'), await orthoPng(true));
  const corners: RasterCorners = {
    tl: [-30, ORTHO_Y, -50],
    tr: [70, ORTHO_Y, -50],
    bl: [-30, ORTHO_Y, 30],
  };
  const m = ProjectManifest.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
  const captures = [
    { id: 'capture-1', label: 'March survey', date: '2026-03-05' },
    { id: 'capture-2', label: 'April survey', date: '2026-04-16' },
  ];
  // the pins stand at the origin's height: drawn on the ortho, the walks lie 6 m below them
  const place = (startT: number, off: readonly [number, number]) => ({
    pins: [
      { t: startT, surface: '@model', at: [WALK_START[0] + off[0], WALK_START[1] + off[1]], y: 0 },
      { t: WALK_END_S, surface: '@model', at: [WALK_END[0] + off[0], WALK_END[1] + off[1]], y: 0 },
    ],
    yawOffsetDeg: 0,
    quality: 'good',
    placedOn: '@model',
  });
  const layers = m.layers.map((l) =>
    l.kind === 'walk' && l.id === WALK_LAYER
      ? { ...l, capture: 'capture-1', place: place(WALK1_START_S, [0, 0]) }
      : l,
  );
  const second = walkLayerFor(
    w2,
    { ...m, captures },
    { raw: true, orientation: false, points: false },
  );
  const ortho = (id: string, name: string, file: string, capture: string) => ({
    kind: 'raster',
    id,
    name,
    visible: true,
    role: 'ortho',
    format: 'image',
    capture,
    src: { path: `rasters/${file}` },
    corners,
  });
  const out = ProjectManifest.parse({
    ...m,
    captures,
    layers: [
      ...layers,
      { ...second, capture: 'capture-2', place: place(WALK2_START_S, WALK2_OFFSET) },
      ortho('ortho-mar', 'Ortho 5 Mar 2026', 'ortho-mar.png', 'capture-1'),
      ortho('ortho-apr', 'Ortho 16 Apr 2026', 'ortho-apr.png', 'capture-2'),
    ],
  });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(out, null, 2));
  return dir;
}
