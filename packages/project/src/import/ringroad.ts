import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import sharp from 'sharp';
import { fromWgs84, toWgs84 } from '@aio/geo';
import type { Layer, PhotoRef, ProjectManifestInput, Vec3 } from '@aio/schema';
import type { ImportOptions, ImportResult } from './hcl';
import { imageSize } from './image';
import { extractWindowJson } from './kitdata';
import { ISSUES_SCHEMA, validatePackage } from './package';
import { ImportReport, formatBytes } from './report';
import { buildOrthoPyramid, readPyramidRegion } from './ringroad-ortho';
import {
  ROAD_CATALOGUE,
  ROAD_SEVERITY_MODEL,
  RrCrops,
  RrData,
  RrGrid,
  STAGE_LABEL,
  buildPciIndex,
  buildRoadDoc,
  buildRoadIssue,
  classIdOf,
  closeupFrame,
  defectCode,
  pathToImagePolygon,
  pciUnitsGeojson,
  photoIdOf,
  readDefects,
  severityOfStage,
  type OrthoBlock,
  type RrDefect,
} from './ringroad-model';
import {
  SRC_TILE,
  bestShift,
  levelCorners,
  parseRrtBundle,
  planPyramid,
  tileToSource,
  worldPxToLonLat,
  type PyramidPlan,
} from './ringroad-tiles';
import { PackageWriter } from './writer';

const EPSG = 32638;
/** Pixel size of source zoom 22 at the corridor (about 3.25 cm) and the package pyramid. */
const FINEST_M = 0.0325;
const TILE_PX = 1024;
const LEVELS = 8;
const FINEST_SRC_ZOOM = 22;
/** Bump when the resampling changes, so a re-run rebuilds the ortho. */
const ORTHO_ALGO = 'rr-ortho-3';
/** Viewer navy under no-data pixels (the 3D view draws ortho tiles opaque). */
const NO_DATA: [number, number, number] = [20, 29, 45];
const CREATED_AT = '2024-04-02T00:00:00+03:00';
const AUTHOR = 'MPW defect shapefile (2 Apr 2024)';
const CAPTURE_DATE = '2024-03-31';
const LEGACY_DIR = 'legacy';
const STAGE_COLOR: Record<number, string> = { 1: '#fad34b', 2: '#ff7a2d', 3: '#ee3f4b' };
/**
 * Georeferencing of the two 1.25 cm GeoTIFF blocks the close-ups were cut from (ModelTiepoint and
 * ModelPixelScale of `1st Ring Road\Orthomosaic\*.tif`, pixel is area), in the order the build
 * draws them. Used only to check the ortho against the close-ups.
 */
const ORTHO_BLOCKS: OrthoBlock[] = [
  {
    name: 'Block 2',
    ox: 787311.4358901078,
    oy: 3252970.739499368,
    sx: 0.0124165,
    sy: 0.0124165,
    w: 162603,
    h: 134291,
  },
  {
    name: 'Block 1',
    ox: 789202.26390585,
    oy: 3254474.190344988,
    sx: 0.0125837,
    sy: 0.0125837,
    w: 144942,
    h: 246095,
  },
];

const toLonLat = (e: number, n: number): [number, number] => {
  const [lon, lat] = toWgs84([e, n, 0], EPSG);
  return [lon, lat];
};
const toProject = (lon: number, lat: number): [number, number] => {
  const [e, n] = fromWgs84([lon, lat, 0], EPSG);
  return [e, n];
};

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Every tile of the review's `ortho/b*` script bundles, keyed `z/x/y`, and the bundle files. */
function readOrthoBundles(src: string): { tiles: Map<string, Uint8Array>; files: string[] } {
  const index = extractWindowJson(
    readFileSync(join(src, 'ortho', 'index.js'), 'utf8'),
    'RR_ORTHO_INDEX',
  ) as Record<string, [number, number][]>;
  const tiles = new Map<string, Uint8Array>();
  const files: string[] = [];
  for (const [z, list] of Object.entries(index)) {
    for (const [x, y] of list) {
      const f = join(src, 'ortho', `b${z}`, `${x}_${y}.js`);
      if (!existsSync(f)) continue;
      files.push(f);
      for (const [k, v] of parseRrtBundle(readFileSync(f, 'utf8'))) tiles.set(k, v);
    }
  }
  return { tiles, files };
}

/** UTM box of the z18 bundles (the corridor). */
function corridorBounds(tiles: ReadonlyMap<string, Uint8Array>) {
  const b = { minE: Infinity, minN: Infinity, maxE: -Infinity, maxN: -Infinity };
  for (const k of tiles.keys()) {
    const [z, x, y] = k.split('/').map(Number) as [number, number, number];
    if (z !== 18) continue;
    for (const [cx, cy] of [
      [x, y],
      [x + 1, y],
      [x, y + 1],
      [x + 1, y + 1],
    ] as const) {
      const [lon, lat] = worldPxToLonLat(cx * SRC_TILE, cy * SRC_TILE, 18);
      const [e, n] = toProject(lon, lat);
      b.minE = Math.min(b.minE, e);
      b.maxE = Math.max(b.maxE, e);
      b.minN = Math.min(b.minN, n);
      b.maxN = Math.max(b.maxN, n);
    }
  }
  if (!Number.isFinite(b.minE)) throw new Error('No z18 ortho tiles in the review bundles');
  return b;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Viewer folder `ortho-hd/` (plain `{z}/{x}/{y}.webp`) and its index, rebuilt from the bundles. */
function writeLegacyOrtho(w: PackageWriter, tiles: ReadonlyMap<string, Uint8Array>) {
  const listed: Record<string, [number, number][]> = {};
  let minZ = Infinity;
  let maxZ = -Infinity;
  const checkZ = 18;
  for (const [k, v] of tiles) {
    const [z, x, y] = k.split('/').map(Number) as [number, number, number];
    w.write(`${LEGACY_DIR}/ortho-hd/${z}/${x}/${y}.webp`, v);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    if (z <= checkZ) (listed[String(z)] ??= []).push([x, y]);
  }
  for (const l of Object.values(listed)) l.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const index = { format: 'files', dir: 'ortho-hd', minZ, maxZ, checkZ, tiles: listed };
  w.write(`${LEGACY_DIR}/ortho-hd/index.js`, `window.RR_ORTHO_INDEX=${JSON.stringify(index)};\n`);
  return { minZ, maxZ };
}

interface LandingCheck {
  code: string;
  km: number;
  dxCm: number;
  dyCm: number;
  score: number;
}

/**
 * Compare the package ortho with the defect close-ups (cut by the review build straight from the
 * 1.25 cm GeoTIFF over a UTM box): best shift by normalised cross correlation, 3.25 cm pixels.
 */
async function landingChecks(
  root: string,
  plan: PyramidPlan,
  defects: readonly RrDefect[],
  crops: Map<number, [number, number, number, number]>,
  closeups: (fid: number) => string | null,
): Promise<LandingCheck[]> {
  const level = plan.levels[plan.levels.length - 1];
  if (!level) return [];
  const withCrop = defects.filter((d) => crops.has(d.id) && closeups(d.id));
  const big = withCrop
    .filter((d) => d.stage === 3)
    .sort((a, b) => b.area - a.area)
    .slice(0, 6);
  const byKm = [...withCrop].sort((a, b) => a.km - b.km);
  const spread = Array.from(
    { length: Math.min(6, byKm.length) },
    (_, i) => byKm[Math.floor(((i + 0.5) * byKm.length) / Math.min(6, byKm.length))],
  ).filter((d): d is RrDefect => d !== undefined);
  const picks = [...new Map([...big, ...spread].map((d) => [d.id, d])).values()];
  const out: LandingCheck[] = [];
  const mpp = level.metresPerPx;
  for (const d of picks) {
    const box = crops.get(d.id);
    const file = closeups(d.id);
    if (!box || !file) continue;
    // the ground the close-up really shows (whole GeoTIFF pixels around the crop box)
    const f = closeupFrame(box, ORTHO_BLOCKS);
    const [e0, n0, e1, n1] = [f.left, f.bottom, f.right, f.top];
    const x0 = Math.round((e0 - plan.left) / mpp);
    const y0 = Math.round((plan.top - n1) / mpp);
    const w = Math.round((e1 - e0) / mpp);
    const h = Math.round((n1 - n0) / mpp);
    if (w < 24 || h < 24) continue;
    const ortho = await readPyramidRegion(root, level, x0, y0, w, h);
    const grey = new Float32Array(w * h);
    let opaque = 0;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      grey[i] =
        0.299 * (ortho.data[o] ?? 0) +
        0.587 * (ortho.data[o + 1] ?? 0) +
        0.114 * (ortho.data[o + 2] ?? 0);
      if ((ortho.data[o + 3] ?? 0) > 128) opaque++;
    }
    if (opaque < w * h * 0.5) continue;
    const cu = await sharp(readFileSync(file))
      .resize(w, h, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();
    const ref = Float32Array.from(cu);
    const s = bestShift(ref, grey, w, h, Math.min(10, Math.floor(Math.min(w, h) / 4)));
    // the window starts on a whole level pixel; the crop box starts `fx`, `fy` px later
    const fx = (e0 - plan.left) / mpp - x0;
    const fy = (plan.top - n1) / mpp - y0;
    out.push({
      code: defectCode(d.id),
      km: d.km,
      dxCm: (s.sx - fx) * mpp * 100,
      dyCm: (s.sy - fy) * mpp * 100,
      score: s.score,
    });
  }
  return out;
}

/** Library poster: the ortho over the corridor with the defects by stage and the centreline. */
async function writeThumbnail(
  w: PackageWriter,
  plan: PyramidPlan,
  bounds: { minE: number; minN: number; maxE: number; maxN: number },
  defects: readonly RrDefect[],
  centreline: readonly [number, number][],
) {
  const level = plan.levels.find((l) => l.cols === 4) ?? plan.levels[0];
  if (!level) return;
  const mpp = level.metresPerPx;
  const x0 = Math.max(0, Math.floor((bounds.minE - plan.left) / mpp));
  const y0 = Math.max(0, Math.floor((plan.top - bounds.maxN) / mpp));
  const wpx = Math.ceil((bounds.maxE - bounds.minE) / mpp);
  const hpx = Math.ceil((bounds.maxN - bounds.minN) / mpp);
  const region = await readPyramidRegion(w.root, level, x0, y0, wpx, hpx);
  const px = (e: number, n: number) =>
    [((e - plan.left) / mpp - x0).toFixed(1), ((plan.top - n) / mpp - y0).toFixed(1)].join(',');
  const line = centreline.map(([lon, lat]) => px(...toProject(lon, lat))).join(' ');
  const dots = [...defects]
    .sort((a, b) => a.stage - b.stage)
    .map((d) => {
      const [x, y] = px(d.utm[0], d.utm[1]).split(',');
      return `<circle cx="${x}" cy="${y}" r="${d.stage === 3 ? 9 : d.stage === 2 ? 7 : 5}" fill="${STAGE_COLOR[d.stage] ?? '#fff'}"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${wpx}" height="${hpx}"><polyline points="${line}" fill="none" stroke="#ffffff" stroke-opacity="0.8" stroke-width="5" stroke-dasharray="14 10"/>${dots}</svg>`;
  const img = await sharp(Buffer.from(region.data.buffer), {
    raw: { width: wpx, height: hpx, channels: 4 },
  })
    .flatten({ background: '#141d2d' })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
  const jpg = await sharp(img)
    .resize({ width: 1280, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  w.write('thumbnail.jpg', jpg);
}

export async function importRingroad(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log ?? (() => undefined);
  const src = (...p: string[]) => join(opts.src, ...p);
  const w = new PackageWriter(opts.out);
  const rep = new ImportReport('1st Ring Road (MPW, Kuwait): import report');
  const layers: Layer[] = [];

  const html = readdirSync(opts.src).find((f) => /road review\.html$/i.test(f));
  if (!html) throw new Error(`No "... Road Review.html" in ${opts.src}`);
  const data = RrData.parse(
    extractWindowJson(readFileSync(src('data', 'defects.js'), 'utf8'), 'RR_DATA'),
  );
  const grid = RrGrid.parse(
    extractWindowJson(readFileSync(src('data', 'grid.js'), 'utf8'), 'RR_GRID'),
  );
  const defects = readDefects(data);
  const cropsFile = src('_build', 'crops.json');
  const crops = new Map<number, [number, number, number, number]>(
    existsSync(cropsFile)
      ? RrCrops.parse(JSON.parse(readFileSync(cropsFile, 'utf8'))).map(([id, ...b]) => [id, b])
      : [],
  );

  // Ortho ----------------------------------------------------------------------------------------
  const { tiles, files: bundleFiles } = readOrthoBundles(opts.src);
  log(`ortho: ${tiles.size} source tiles in ${bundleFiles.length} bundles`);
  const bounds = corridorBounds(tiles);
  const origin: Vec3 = [
    Math.round((bounds.minE + bounds.maxE) / 2),
    Math.round((bounds.minN + bounds.maxN) / 2),
    0,
  ];
  const plan = planPyramid(bounds, {
    finestM: FINEST_M,
    tileSize: TILE_PX,
    levels: LEVELS,
    finestSrcZoom: FINEST_SRC_ZOOM,
  });
  const stamp = createHash('sha256')
    .update(
      JSON.stringify([
        ORTHO_ALGO,
        plan,
        bundleFiles.map((f) => {
          const s = statSync(f);
          return [relative(opts.src, f), s.size, Math.round(s.mtimeMs)];
        }),
      ]),
    )
    .digest('hex');
  const ortho = await buildOrthoPyramid({
    tiles,
    plan,
    toLonLat,
    w,
    stamp,
    fill: NO_DATA,
    completeUpTo: 16,
    log,
  });
  if (ortho.reused) log('ortho: source unchanged, tiles of the previous run kept');
  const corners = levelCorners(plan, origin);
  w.writeJson('rasters/ortho/tiles.json', {
    schema: 'aio.tiles/1',
    levels: plan.levels.map(({ z, tileSize, cols, rows, pattern }) => ({
      z,
      tileSize,
      cols,
      rows,
      pattern,
    })),
    corners,
    crs: { epsg: EPSG },
    topLeft: [plan.left, plan.top],
    metresPerPx: plan.levels.map((l) => r3(l.metresPerPx * 1000) / 1000),
    source:
      'Road review Web Mercator tiles z14 to z22 (ortho/b13, ortho/b18 bundles), resampled per tile',
  });
  layers.push({
    kind: 'raster',
    id: 'ortho',
    name: 'Orthomosaic (3.25 cm)',
    visible: true,
    src: { path: 'rasters/ortho/tiles.json' },
    role: 'ortho',
    format: 'kit-pyramid',
    corners,
  });

  // Close-ups ------------------------------------------------------------------------------------
  const photos: PhotoRef[] = [];
  const sizes = new Map<string, { width: number; height: number }>();
  const missing: number[] = [];
  for (const d of defects) {
    const id = photoIdOf(d.id);
    const file = src('closeups', `${id}.webp`);
    if (!existsSync(file)) {
      missing.push(d.id);
      continue;
    }
    const size = imageSize(readFileSync(file));
    if (!size) {
      missing.push(d.id);
      continue;
    }
    await w.copy(file, `photos/closeups/${id}.webp`);
    sizes.set(id, size);
    photos.push({ id, src: { path: `photos/closeups/${id}.webp` } });
  }
  if (missing.length) {
    rep.warn(
      `No close-up for ${missing.length} defect(s): ${missing.slice(0, 12).map(defectCode).join(', ')}${missing.length > 12 ? ', ...' : ''}; those issues have only the map sighting.`,
    );
  }
  layers.push({
    kind: 'photos',
    id: 'closeups',
    name: 'Defect close-ups (1.25 cm ortho crops)',
    visible: true,
    items: photos,
  });

  // Issues ---------------------------------------------------------------------------------------
  const pci = buildPciIndex(grid);
  const issues = defects.map((d) =>
    buildRoadIssue(d, {
      mapLayer: 'ortho',
      photosLayer: 'closeups',
      photoSize: (id) => sizes.get(id) ?? null,
      pciUnitAt: pci.at,
      createdAt: CREATED_AT,
      author: AUTHOR,
    }),
  );
  if (issues.length !== data.rows.length)
    throw new Error(`${issues.length} issues for ${data.rows.length} defects`);

  // Road model -----------------------------------------------------------------------------------
  const overlays = { centreline: 'road/centreline.geojson', pciUnits: 'road/pci-units.geojson' };
  w.writeJson('road.json', buildRoadDoc(data, grid, { origin, toProject, overlays }), false);
  const ticks: { km: number; at: [number, number] }[] = [];
  const lastKm = data.chainage[data.chainage.length - 1] ?? 0;
  for (let km = 0; km <= lastKm + 1e-9; km += 0.5) {
    const k = data.chainage.findIndex((v) => v >= km - 1e-9);
    const p = data.centerline[k];
    if (p) ticks.push({ km: Math.round(km * 10) / 10, at: p });
  }
  w.writeJson(overlays.centreline, {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: data.centerline },
        properties: { kind: 'centreline', chainageKm: data.chainage },
      },
      ...ticks.map((t) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: t.at },
        properties: { kind: 'chainage', km: t.km, label: `km ${t.km.toFixed(1)}` },
      })),
    ],
  });
  w.writeJson(overlays.pciUnits, pciUnitsGeojson(grid, toLonLat), false);

  // Legacy viewer --------------------------------------------------------------------------------
  await w.copy(src(html), `${LEGACY_DIR}/${html}`);
  for (const f of listFiles(src('lib')))
    await w.copy(f, `${LEGACY_DIR}/${relative(opts.src, f).replace(/\\/g, '/')}`);
  for (const f of ['defects.js', 'grid.js'])
    await w.copy(src('data', f), `${LEGACY_DIR}/data/${f}`);
  const closeupFiles = listFiles(src('closeups'));
  for (const f of closeupFiles) await w.copy(f, `${LEGACY_DIR}/closeups/${basename(f)}`);
  const legacyOrtho = writeLegacyOrtho(w, tiles);
  const hasBasemap = existsSync(src('basemap', 'index.js'));
  if (hasBasemap) {
    for (const f of listFiles(src('basemap')))
      await w.copy(f, `${LEGACY_DIR}/${relative(opts.src, f).replace(/\\/g, '/')}`);
  } else {
    w.write(`${LEGACY_DIR}/basemap/index.js`, 'window.RR_BASE_INDEX={};\n');
  }
  layers.push({
    kind: 'legacy',
    id: 'road-review',
    name: 'Road review (original viewer: PCI grid, filters, measure)',
    visible: true,
    viewer: 'road',
    entry: { path: `${LEGACY_DIR}/${html}` },
  });

  // Thumbnail, manifest ---------------------------------------------------------------------------
  await writeThumbnail(w, plan, bounds, defects, data.centerline);
  const meta = data.meta;
  const manifestInput: ProjectManifestInput = {
    schema: 'aio.project/1',
    id: 'ringroad',
    name: '1st Ring Road',
    customer:
      typeof meta.client === 'string' ? meta.client : 'Ministry of Public Works (MPW), Kuwait',
    site: '1st Ring Road, Kuwait City',
    crs: { epsg: EPSG },
    origin,
    captures: [
      {
        id: 'survey-2024',
        label:
          'Drone orthomosaic survey (blocks 1 and 2, 1.25 cm GSD) and delivered defect shapefile',
        date: CAPTURE_DATE,
      },
    ],
    layers,
    severityModels: [ROAD_SEVERITY_MODEL],
    classCatalogues: [ROAD_CATALOGUE],
  };
  const valid = validatePackage(manifestInput, issues);
  w.writeJson('manifest.json', valid.manifest);
  w.writeJson('issues.json', { schema: ISSUES_SCHEMA, issues: valid.issues });
  for (const dir of ['rasters', 'photos', 'road', LEGACY_DIR]) {
    for (const p of w.prune(dir)) rep.note(`Removed stale ${p}`);
  }

  // Checks ---------------------------------------------------------------------------------------
  const finest = plan.levels[plan.levels.length - 1];
  const whole = finest ? { ...finest, tileSize: finest.tileSize * finest.cols } : null;
  const singleAffineM =
    whole && finest ? tileToSource(plan, whole, 0, 0, toLonLat).err * finest.metresPerPx : 0;
  let roundTrip = 0;
  for (const d of defects) {
    const [e, n] = toProject(d.c[0], d.c[1]);
    roundTrip = Math.max(roundTrip, Math.hypot(e - d.utm[0], n - d.utm[1]));
  }
  // close-up outline (viewer path) against the defect polygon placed through the crop box
  let outlineMax = 0;
  let outlineSum = 0;
  let outlineN = 0;
  let windowMax = 0;
  let windowSum = 0;
  for (const d of defects) {
    const box = crops.get(d.id);
    const size = sizes.get(photoIdOf(d.id));
    if (!box || !size) continue;
    const poly = pathToImagePolygon(d.path, size.width, size.height);
    const ring = d.g.slice(0, -1);
    if (poly.length !== ring.length) continue;
    const [e0, n0, e1, n1] = box;
    const f = closeupFrame(box, ORTHO_BLOCKS);
    ring.forEach(([lon, lat], i) => {
      const [e, n] = toProject(lon, lat);
      const p = poly[i];
      if (!p) return;
      const dist = Math.hypot(
        ((e - e0) / (e1 - e0)) * size.width - p[0],
        ((n1 - n) / (n1 - n0)) * size.height - p[1],
      );
      outlineMax = Math.max(outlineMax, dist);
      outlineSum += dist;
      outlineN++;
      // where the vertex really is in the image (the image spans the whole-pixel window)
      const real = Math.hypot(
        ((e - f.left) / (f.right - f.left)) * size.width - p[0],
        ((f.top - n) / (f.top - f.bottom)) * size.height - p[1],
      );
      windowMax = Math.max(windowMax, real);
      windowSum += real;
    });
  }
  const landing = await landingChecks(opts.out, plan, defects, crops, (fid) => {
    const f = src('closeups', `${photoIdOf(fid)}.webp`);
    return existsSync(f) ? f : null;
  });

  // Report ---------------------------------------------------------------------------------------
  rep.count('Defects in data/defects.js', defects.length);
  rep.count('Issues written', valid.issues.length);
  rep.count(
    'Issues with a close-up sighting',
    valid.issues.filter((i) => i.sightings.some((s) => s.on === 'image')).length,
  );
  rep.count('Close-ups (photos layer)', photos.length);
  rep.count('PCI sample units', grid.pci.units.length);
  rep.count('Centreline vertices', data.centerline.length);
  rep.count('Source ortho tiles (z13 to z22)', tiles.size);
  rep.count(
    'Package ortho tiles',
    ortho.levels.reduce((a, l) => a + l.tiles, 0),
  );

  rep.section('Source', [
    `\`${opts.src}\` (copy of \`\\\\DanNas\\Work Data\\MPW Roads\\1st Ring Road\\Road Review\`). Read: \`${html}\`, \`data/defects.js\` (RR_DATA), \`data/grid.js\` (RR_GRID), \`_build/crops.json\` (close-up UTM boxes), \`ortho/index.js\` with the \`ortho/b13\` and \`ortho/b18\` tile bundles, \`closeups/\`, \`lib/\`.`,
    '',
    `The review page loads \`ortho-hd/index.js\` and \`basemap/index.js\`, but neither folder is in the source (\`_build/README.md\` lists \`ortho/\` as the retired z13 to z22 script bundles that it replaced). The bundles are the highest-resolution ortho in the folder: Web Mercator 256 px WebP tiles z13 to z22, z22 being ${(FINEST_M * 100).toFixed(2)} cm per pixel here (rendered from the 2.5 cm overview of the 1.25 cm GeoTIFFs). The full 1.25 cm GeoTIFFs (blocks 1 and 2, 34 GB) are on the NAS under \`1st Ring Road\\Orthomosaic\`, outside the review folder; a z23 rebuild from them is not part of this import.`,
  ]);
  rep.section('Frame', [
    `CRS EPSG:${EPSG} (WGS 84 / UTM 38N), origin E ${origin[0]}, N ${origin[1]}, H 0 (centre of the corridor). Local \`x = E - ${origin[0]}\`, \`z = -(N - ${origin[1]})\`, ground at \`y = 0\`. Defect polygons, the centreline and PCI cells are converted from lon/lat (or UTM) with the bundled proj4 definition.`,
  ]);
  const levelRows = plan.levels.map((l) => {
    const s = ortho.levels.find((x) => x.z === l.z);
    return `| ${l.z} | z${l.srcZoom} | ${(l.metresPerPx * 100).toFixed(2)} cm | ${l.cols} x ${l.rows} | ${((s?.errPx ?? 0) * l.metresPerPx * 100).toFixed(2)} cm | ${s?.tiles ?? 0}${s?.blank ? ` (${s.blank} no-data)` : ''} | ${formatBytes(s?.bytes ?? 0)} |`;
  });
  rep.section('Orthomosaic', [
    `\`rasters/ortho/tiles.json\` (\`aio.tiles/1\`, format \`kit-pyramid\`): a square of ${plan.size.toFixed(2)} m aligned to UTM 38N, top-left E ${plan.left}, N ${plan.top}, ${TILE_PX} px WebP tiles \`rasters/ortho/{z}/{x}_{y}.webp\`, no-data transparent over the viewer navy. Corners (local): tl ${JSON.stringify(corners.tl)}, tr ${JSON.stringify(corners.tr)}, bl ${JSON.stringify(corners.bl)}.`,
    '',
    `Why resampled and not just unpacked: the source tiles are Web Mercator. One affine for the whole Mercator grid (what a kit pyramid with one set of corners means) misses by ${singleAffineM.toFixed(2)} m at the corners of the square (about ${(singleAffineM / FINEST_M).toFixed(0)} px at z22). Each package tile instead gets its own affine to the source zoom (largest miss inside a tile per level in the table: well under a pixel, ${((ortho.levels.at(-1)?.errPx ?? 0) * FINEST_M * 1000).toFixed(2)} mm at level 7) and is resampled bilinearly on premultiplied colour, so the ortho sits on UTM to the source accuracy.`,
    '',
    '| Level | Source | Pixel | Grid | Tile affine miss | Tiles | Size |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...levelRows,
    '',
    `Level 7 (finest, 3.25 cm) streams in the 3D view below about ${(8 * TILE_PX * FINEST_M).toFixed(0)} m; the 2D map draws one level of at most 16 tiles (level 2, ${((plan.levels[2]?.metresPerPx ?? 0) * 100).toFixed(0)} cm).`,
  ]);
  const stageRows = [1, 2, 3].map((s) => {
    const sev = severityOfStage(s);
    const label = ROAD_SEVERITY_MODEL.levels.find((l) => l.value === sev)?.label ?? '';
    return `| ${STAGE_LABEL[s]} | ${sev} | ${label} | ${defects.filter((d) => d.stage === s).length} |`;
  });
  const classRows = ROAD_CATALOGUE.classes.map((c) => {
    const ds = defects.filter((d) => classIdOf(d.type) === c.id);
    return `| ${c.label} | ${ds.length} | ${ds.filter((d) => d.stage === 2).length} | ${ds.filter((d) => d.stage === 3).length} |`;
  });
  rep.section('Issues', [
    `One issue per delivered defect polygon (\`issues.json\`), code \`D\` + shapefile FID (D0000 to ${defectCode(Math.max(...defects.map((d) => d.id)))}), class = defect type, status reviewed, author "${AUTHOR}". Sightings: a map polygon (GeoJSON, lon/lat, on layer \`ortho\`) and, when the close-up exists, the viewer outline on it (photos layer \`closeups\`, polygon in image pixels: the viewer's 0 to 1000 path scaled to the image). Title "<type> at km <chainage>"; the note gives stage, mapped area, extent, cluster share, the PCI sample unit with its Low, Medium and High PCI, UTM and FID. Measurements: area (m2) and extent (m).`,
    '',
    `Severity model "${ROAD_SEVERITY_MODEL.name}" (\`${ROAD_SEVERITY_MODEL.id}\`). Mapping of the delivered stage:`,
    '',
    '| Stage (delivered) | Severity | ASTM D6433 | Defects |',
    '| --- | ---: | --- | ---: |',
    ...stageRows,
    '',
    'The stage is a screening grade: ASTM severity depends on crack width, rut and pothole depth, which a 2D ortho cannot measure (the review says the same and computes PCI for all three severities).',
    '',
    '| Class | Defects | Medium | High |',
    '| --- | ---: | ---: | ---: |',
    ...classRows,
  ]);
  rep.section('Road model and PCI', [
    `\`road.json\` (\`aio.road/1\`, for a native road panel): centreline (${data.centerline.length} vertices, local frame) with chainage 0 to ${lastKm.toFixed(3)} km; network PCI ${grid.pci.road.join(' / ')} (Low / Medium / High severity assumption, Medium is the headline); ${grid.pci.sections.length} sections of 250 m; ${grid.pci.units.length} ASTM D6433 sample units on the ${grid.pci.unit_m} m UTM grid (cell i, j spans x \`grid.origin.x + j * ${grid.pci.unit_m}\`, z \`grid.origin.z + i * ${grid.pci.unit_m}\`) with deducts; density grids at ${Object.keys(grid.density).join(', ')} m.`,
    `\`road/centreline.geojson\` (centreline and km ticks every 0.5 km) and \`road/pci-units.geojson\` (unit cells as lon/lat MultiPolygons with \`pciLow\`, \`pciMedium\`, \`pciHigh\`) are ready as map overlays.`,
  ]);
  rep.section('Legacy viewer', [
    `\`${LEGACY_DIR}/${html}\` (layer \`road-review\`, viewer \`road\`) with \`lib/\`, \`data/defects.js\`, \`data/grid.js\`, \`closeups/\` (${closeupFiles.length} files, close-ups and thumbnail sheets). The ortho folder the page expects is rebuilt as \`${LEGACY_DIR}/ortho-hd/{z}/{x}/{y}.webp\` (z${legacyOrtho.minZ} to z${legacyOrtho.maxZ}, ${tiles.size} tiles) with its \`index.js\` (format files, z18 ancestor check), so the page shows the ortho with no change to its code. ${hasBasemap ? 'The street basemap is copied.' : '`basemap/` is not in the source: `basemap/index.js` is an empty index, so the page runs without its street map.'} Not copied: \`_build/\` and the retired \`data/osm.js\`, \`heat/\`, \`tiles/\`, \`assets/\`, \`preview/\`.`,
  ]);
  const landingRows = landing.map(
    (c) =>
      `| ${c.code} | ${c.km.toFixed(3)} | ${c.dxCm.toFixed(1)} | ${c.dyCm.toFixed(1)} | ${c.score.toFixed(2)} |`,
  );
  const worstLanding = Math.max(0, ...landing.map((c) => Math.hypot(c.dxCm, c.dyCm)));
  const meanDx = landing.reduce((a, c) => a + c.dxCm, 0) / Math.max(1, landing.length);
  const meanDy = landing.reduce((a, c) => a + c.dyCm, 0) / Math.max(1, landing.length);
  rep.section('Checks', [
    `- \`parseManifest\` and every issue against its severity model: pass (\`validatePackage\`).`,
    `- Issues ${valid.issues.length} = defects in \`data/defects.js\` ${defects.length}.`,
    `- Viewer coordinates: every defect centroid (lon/lat as the review places it) converted to UTM lands within ${(roundTrip * 100).toFixed(1)} cm of the shapefile UTM centroid.`,
    `- Close-up outlines: the viewer path against the defect polygon placed through the crop box, ${outlineN} vertices, mean ${(outlineSum / Math.max(1, outlineN)).toFixed(2)} px, max ${outlineMax.toFixed(2)} px. The build stretches a window of whole GeoTIFF pixels around the crop box over each close-up (\`closeups.py\` reads \`int((X0 - ox) / rx)\` to \`ceil((X1 - ox) / rx)\`), so against the ground the image really shows, the viewer outline (kept as delivered for the image sightings) is off by mean ${(windowSum / Math.max(1, outlineN)).toFixed(2)} px, max ${windowMax.toFixed(2)} px.`,
    `- Ortho landing: the package ortho (level 7) against the close-ups, which the review cut straight from the 1.25 cm GeoTIFFs; each close-up's real ground window is rebuilt from the GeoTIFF tie points and pixel sizes (blocks 1 and 2) the way \`closeups.py\` reads it. Best shift by normalised cross correlation, search 10 px (32.5 cm), refined below a pixel. Worst offset ${worstLanding.toFixed(1)} cm, mean ${(landing.reduce((a, c) => a + Math.hypot(c.dxCm, c.dyCm), 0) / Math.max(1, landing.length)).toFixed(1)} cm (one package pixel is 3.25 cm); mean dx ${meanDx.toFixed(1)} cm, dy ${meanDy.toFixed(1)} cm. The resampling itself is exact to about 0.1 px (unit test with a synthetic dot), so the common offset is in the review tiles: it is about half a pixel of the 2.5 cm GeoTIFF overview their z22 level was rendered from (\`tiler.py\`, \`RR_LEVEL=1\`).`,
    '',
    '| Issue | km | dx (cm) | dy (cm) | Correlation |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...landingRows,
  ]);
  rep.section('Seams', [
    '- `MapView` has no GeoJSON overlay layer in the manifest (raster kinds only), so the centreline, chainage and PCI units are not drawn on the map yet; they wait in `road.json` and `road/*.geojson`.',
    '- `MapView` draws a kit pyramid at one coarse level (at most 16 tiles, here 1.04 m per pixel) and issues as points: cracks are visible in 3D and in the close-ups, not on the 2D map.',
    '- The 3D view shows no marker for map sightings (`sightingAnchor` in @aio/annotate reads mesh and point cloud sightings only), so defects are not pinned in 3D.',
    `- The 3D kit pyramid adapter plans tiles over every slot of a level (${(plan.levels[plan.levels.length - 1]?.cols ?? 0) ** 2} at level 7, measured 3.6 ms per update with 1024 px tiles against 17 ms with 512 px, hence 1024) and retries missing tiles; the corridor fills a small part of the square.`,
  ]);
  w.write('IMPORT-REPORT.md', rep.toMarkdown(opts.out));
  return {
    manifestPath: w.abs('manifest.json'),
    layers: valid.manifest.layers.length,
    issues: valid.issues.length,
    written: w.stats.written,
    skipped: w.stats.skipped,
    warnings: rep.warnings,
  };
}
