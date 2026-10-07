#!/usr/bin/env node
/* eslint-disable no-console -- build script output */
// The photo processing demo (M10, stream G8): a bundled synthetic project to process drone photos
// in, made from the synthetic photogrammetry set (python/tests/photo_synth.py). It holds:
//
//   photos layer `photos`      the photo set (DJI-style EXIF and XMP of the synthetic camera,
//                              standard GNSS geotags with an altitude datum offset the
//                              manifest's verticalDatum corrects), imported the way the builder
//                              imports photos; the corrupt photo stays out
//   survey/gcp.csv             5 control points and 4 checkpoints (id, x, y, z, role; EPSG:32639)
//   survey/gcp-blunder.csv     the same plus GCP6, stated 1 m off
//   photogrammetry/<run>/      a precomputed GNSS-only alignment (run.json, gcp.json with the
//                              points imported and their predicted marks, report/accuracy.json,
//                              sparse/ as a COLMAP text model), so the GCP marker and the report
//                              can be used without waiting for photo.align
//   tiles/ + tilesets.json     the expected surface (true mesh and cloud) as 3D Tiles, hidden
//   truth.json                 the generator's truth (poses, targets, volumes)
//
// Two photo sets (PHOTO_SETS):
//   mini   (default, the bundled demo) 14 photos at 960 x 720: a 3 x 3 block of nadir photos over
//          the middle of the site and the five bad ones; 13 in the layer. GCP5, CHK1 and CHK2 are
//          in view (GCP2 only in the photo without GPS); the other points of the survey file lie
//          outside the block. About 9 MB, so the installer stays within M10 decision 6.
//   quick  (development and CI only, never bundled) 63 photos at 1600 x 1200 with the oblique
//          ring and every point in view; about 51 MB. tools/demo/ensure-demo.mjs rebuilds a demo
//          made from it before a release.
//
//   node tools/demo/photo-demo.mjs [--out apps/desktop/demo] [--photo-set mini|quick] [--quick]
//                                  [--python <python>] [--cache <render cache>]
//                                  [--set <an existing photo set>]
//
// build-demo.mjs calls buildPhotoDemo() for the full demo set; run alone, this script adds (or
// replaces) <out>/demo-photo-processing/ and lists it in <out>/demo.json. The set is
// --photo-set, else QUADRION_PHOTO_DEMO_SET, else mini (with --set: the set that folder holds).
// Renders are cached by seed, size and generator hash (default: python/.pytest_cache/d/photo-synth,
// shared with pytest; or QUADRION_PHOTO_SYNTH_CACHE). --quick is accepted for symmetry with the
// other demos: the content is the same.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { envVar } from '../../packages/brand/src/env.ts';
import { treeHash, treeSize } from './build-change-demo.mjs';

export const PHOTO_ID = 'demo-photo-processing';
export const PHOTO_NAME = 'Photo processing demo';
/** The precomputed run's id (a run folder under photogrammetry/). */
export const PHOTO_RUN = '20260314-1000';
/**
 * The photo sets the demo can be made from (python/tests/photo_synth.py) and the size budget of
 * each on disk. The bundled demo is the mini set: M10 decision 6 allows the installer 15 MB over
 * 0.9.0 for everything M10 adds (CesiumJS about 4 MB compressed, 3DTilesRendererJS), and JPEG
 * photos do not compress. The quick set is for development and CI only.
 */
export const PHOTO_SETS = Object.freeze({
  mini: Object.freeze({ synthArgs: ['--mini'], budgetMb: 12, bundled: true }),
  quick: Object.freeze({ synthArgs: [], budgetMb: 60, bundled: false }),
});
/** The set of the bundled demo (and the default). */
export const PHOTO_SET_DEFAULT = 'mini';
/** A ground point needs this many registered photos of the layer to be marked and checked. */
const MIN_VIEWS = 2;
/** Drone altitudes of the standard geotags are this far below the ellipsoid (photo_synth.py). */
const ALT_OFFSET_M = 21.7;

const repo = fileURLToPath(new URL('../..', import.meta.url));
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

let libsCache = null;
async function libs() {
  if (libsCache) return libsCache;
  const projectRequire = createRequire(join(repo, 'packages', 'project', 'package.json'));
  const { createJiti } = projectRequire('jiti');
  const jiti = createJiti(import.meta.url);
  libsCache = {
    schema: await jiti.import(join(repo, 'packages', 'schema', 'src', 'index.ts')),
    builder: await jiti.import(join(repo, 'packages', 'project', 'src', 'builder', 'index.ts')),
  };
  return libsCache;
}

/** The pipeline Python (python/.venv after `uv sync`), or the one given. */
export function pipelinePython(given) {
  const p = given ?? envVar(process.env, 'DEMO_PYTHON') ?? envVar(process.env, 'E2E_PYTHON');
  if (p) return p;
  const venv =
    process.platform === 'win32'
      ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
      : join(repo, 'python', '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  throw new Error(`No pipeline Python at ${venv}. Run "uv sync" in python/ or pass --python.`);
}

/** The photo set to build: the one asked for, else QUADRION_PHOTO_DEMO_SET, else mini. */
export function photoSetName(given) {
  const name = given ?? envVar(process.env, 'PHOTO_DEMO_SET') ?? PHOTO_SET_DEFAULT;
  if (!Object.hasOwn(PHOTO_SETS, name))
    throw new Error(`Unknown photo set "${name}" (${Object.keys(PHOTO_SETS).join(' or ')}).`);
  return name;
}

/** Generate a synthetic photo set (mini or quick, standard geotags) into `dir`. */
export function generatePhotoSet(
  dir,
  { photoSet = PHOTO_SET_DEFAULT, python, cache, log = () => undefined } = {},
) {
  const args = [
    join(repo, 'python', 'tests', 'photo_synth.py'),
    '--out',
    dir,
    ...PHOTO_SETS[photoSet].synthArgs,
  ];
  const c =
    cache ??
    envVar(process.env, 'PHOTO_SYNTH_CACHE') ??
    join(repo, 'python', '.pytest_cache', 'd', 'photo-synth');
  args.push('--cache', c);
  log(`photo set ${photoSet}: rendering (cache ${relative(repo, c) || c})`);
  const r = spawnSync(pipelinePython(python), args, {
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0) throw new Error('photo_synth.py failed');
  return dir;
}

const resizeJpeg = async (src, dst, maxPx) => {
  await sharp(src)
    .resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: false })
    .toFile(dst);
};

async function removeEmptyDirs(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }))
    if (e.isDirectory()) await removeEmptyDirs(join(dir, e.name));
  if ((await readdir(dir)).length === 0) await rmdir(dir);
}

/**
 * The run files of the precomputed alignment, from the set's alignment.json, in the project's
 * terms (photo ids of the photos layer). Validated with the M10 schemas.
 */
export function precomputedRun(schema, { truth, alignment, ids, capture, gcpCsv }) {
  const createdAt = '2026-03-14T10:00:00Z';
  const crs = { epsg: truth.site.crs.epsg };
  const heights = {
    source: 'ellipsoidal',
    geoid: 'none',
    absAltOffsetM: ALT_OFFSET_M,
    note: 'Synthetic demo: drone altitudes are 21.7 m below the ellipsoid; heights are ellipsoidal.',
  };
  const idOf = (name) => ids.get(name) ?? name;
  const rmse = (rows) => ({
    n: rows.length,
    horizontalM: round(
      Math.sqrt(rows.reduce((s, r) => s + r[0] ** 2 + r[1] ** 2, 0) / rows.length),
    ),
    verticalM: round(Math.sqrt(rows.reduce((s, r) => s + r[2] ** 2, 0) / rows.length)),
  });
  const registered = alignment.registered.filter((n) => ids.has(n));
  // a point in fewer than MIN_VIEWS registered photos of the layer cannot be marked or checked:
  // it stays in the GCP file (the survey has it) but has no residual in the report
  const registeredSet = new Set(registered);
  const views = (id) =>
    (alignment.predictions[id] ?? []).filter((q) => registeredSet.has(q.photo)).length;
  const seen = gcpCsv.filter((p) => views(p.id) >= MIN_VIEWS && alignment.residuals[p.id]);
  const unseen = gcpCsv.filter((p) => !seen.includes(p));
  const res = (role) => seen.filter((p) => p.role === role).map((p) => alignment.residuals[p.id]);
  const rmseOf = (role) => (res(role).length ? { [role]: rmse(res(role)) } : {});
  const warnings = [
    {
      code: 'few-marks',
      message:
        'No marks yet: these residuals are the GNSS-only alignment. Mark the points, then adjust.',
    },
    ...unseen.map((p) => ({
      code: 'few-marks',
      point: p.id,
      message: `${p.id} is in fewer than ${String(MIN_VIEWS)} photos of this flight: it cannot be marked or checked.`,
    })),
  ];
  const rejected = alignment.rejected
    .filter((r) => ids.has(r.name))
    .map((r) => ({ name: idOf(r.name), reason: r.reason }));
  const stage = (name, seconds) => ({ name, state: 'done', seconds });
  const run = schema.PhotoRun.parse({
    schema: 'aio.photo-run/1',
    id: PHOTO_RUN,
    createdAt,
    status: 'aligned',
    preset: 'standard',
    photos: {
      source: { layer: 'photos' },
      count: ids.size,
      registered: registered.length,
      rejected,
    },
    cameras: [
      {
        id: 'syn-20',
        make: 'Stratlas Synthetic',
        model: 'SYN-20',
        widthPx: truth.camera.width,
        heightPx: truth.camera.height,
        focalMm: truth.camera.focalMm,
        sensorWidthMm: truth.camera.sensorWidthMm,
        calibration: 'FULL_OPENCV',
        photos: registered.length,
      },
    ],
    crs,
    heights,
    settings: {
      precomputed: true,
      note: 'Precomputed by tools/demo/photo-demo.mjs from the synthetic truth; not a pipeline run.',
    },
    ...(capture ? { capture } : {}),
    stages: [
      stage('inspect', 4),
      stage('features', 95),
      stage('match', 140),
      stage('sfm', 210),
      stage('georef', 6),
      stage('report', 2),
    ],
    outputs: {
      layers: [],
      tilesets: [],
      files: ['cameras.txt', 'images.txt', 'points3D.txt'].map(
        (f) => `photogrammetry/${PHOTO_RUN}/sparse/${f}`,
      ),
    },
    accuracy: {
      ...rmseOf('control'),
      ...rmseOf('check'),
      meanReprojPx: alignment.meanReprojPx,
      gsdCm: alignment.gsdCm,
      warnings: warnings.length,
    },
    versions: { pack: '0.4.0', generator: 'photo_synth/1 (precomputed)' },
    warnings: [
      'A precomputed alignment of the synthetic demo; process the photos to make a real one.',
    ],
  });
  const gcp = schema.GcpFile.parse({
    schema: 'aio.gcp/1',
    crs,
    heights: { source: 'ellipsoidal', geoid: 'none' },
    importedFrom: 'gcp.csv',
    points: gcpCsv.map((p) => ({
      id: p.id,
      role: p.role,
      xyz: p.xyz,
      accuracy: { horizontalM: 0.01, verticalM: 0.015 },
      marks: [],
      predicted: (alignment.predictions[p.id] ?? [])
        .filter((q) => ids.has(q.photo))
        .map((q) => ({ photo: idOf(q.photo), px: q.px, radiusPx: q.radiusPx })),
    })),
  });
  const accuracy = schema.AccuracyReport.parse({
    schema: 'aio.photo-accuracy/1',
    run: PHOTO_RUN,
    createdAt,
    crs,
    heights,
    gsdCm: alignment.gsdCm,
    images: { total: ids.size, registered: registered.length },
    meanReprojPx: alignment.meanReprojPx,
    points: seen.map((p) => {
      const r = alignment.residuals[p.id];
      return { id: p.id, role: p.role, dxM: r[0], dyM: r[1], dzM: r[2], reprojPx: 0, marks: 0 };
    }),
    rmse: { ...rmseOf('control'), ...rmseOf('check') },
    cameraResiduals: alignment.cameraResiduals,
    checkpointsInAdjustment: false,
    warnings,
  });
  return { run, gcp, accuracy };
}

/** Parse the set's gcp.csv (id, x, y, z, role). */
export function readGcpCsv(text) {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  return rows.map((r) => {
    const v = r.split(',');
    const at = (k) => v[cols.indexOf(k)];
    return { id: at('id'), role: at('role'), xyz: ['x', 'y', 'z'].map((k) => Number(at(k))) };
  });
}

/**
 * Build the photo demo into `<out>/demo-photo-processing/`. Returns { root, truth, bytes,
 * photoSet }.
 * @param {{ out: string, quick?: boolean, log?: (m: string) => void, python?: string, cache?: string, set?: string, photoSet?: 'mini' | 'quick' }} o
 *   `set`: an existing photo set folder (skips generating one; the set it holds wins).
 *   `photoSet`: see photoSetName().
 */
export async function buildPhotoDemo({ out, log, python, cache, set, photoSet: asked }) {
  log ??= () => undefined;
  const { schema, builder } = await libs();
  const work = await mkdtemp(join(tmpdir(), 'quadrion-photo-demo-'));
  try {
    const setDir =
      set ??
      generatePhotoSet(join(work, 'set'), { photoSet: photoSetName(asked), python, cache, log });
    const truth = JSON.parse(await readFile(join(setDir, 'truth.json'), 'utf8'));
    const photoSet = photoSetName(truth.generator?.set);
    const alignment = JSON.parse(
      await readFile(join(setDir, 'alignment', 'alignment.json'), 'utf8'),
    );
    const origin = truth.site.origin;
    const { root, manifest } = await builder.createProject(
      join(work, 'data'),
      {
        name: 'Demo photo processing',
        customer: 'Demo customer (fictional)',
        site: 'Fictional site in open desert (synthetic photogrammetry data)',
        type: 'fusion',
        epsg: truth.site.crs.epsg,
        origin,
        captureDate: truth.photos[0].takenAt.slice(0, 10),
        severityTemplate: builder.GENERAL_TEMPLATE.id,
        verticalDatum: {
          absAltOffsetM: ALT_OFFSET_M,
          note: 'Synthetic drone altitudes: 21.7 m below the WGS 84 ellipsoid.',
        },
      },
      builder.GENERAL_TEMPLATE,
    );
    if (manifest.id !== PHOTO_ID) throw new Error(`project id ${manifest.id}`);
    log(`project ${PHOTO_ID}: importing photos`);
    const files = truth.photos
      .filter((p) => p.kind !== 'corrupt')
      .map((p) => join(setDir, 'photos', p.name));
    const imported = await builder.importRawFiles(root, files, {
      images: { resizeJpeg },
      jobs: builder.NO_PIPELINE,
    });
    const failed = imported.items.filter((i) => i.status !== 'imported');
    if (failed.length) throw new Error(`photo import: ${JSON.stringify(failed)}`);
    const m = await builder.readManifestFile(root);
    m.name = PHOTO_NAME;
    const layer = m.layers.find((l) => l.kind === 'photos');
    if (!layer || layer.id !== 'photos') throw new Error('no photos layer');
    layer.name = 'Drone photos (synthetic)';
    await builder.writeManifestFile(root, m);
    // file name in the set -> photo id in the layer (the import slugs names: SYN_0001.JPG -> syn-0001)
    const ids = new Map(
      truth.photos
        .filter((p) => p.kind !== 'corrupt')
        .map((p, i) => [p.name, layer.items[i]?.id ?? '']),
    );
    for (const [name, id] of ids)
      if (id !== builder.slug(name.replace(/\.jpg$/i, '')))
        throw new Error(`photo ${name} imported as ${id}`);

    // the GCP survey files a person imports in the wizard
    await mkdir(join(root, 'survey'), { recursive: true });
    for (const f of ['gcp.csv', 'gcp-blunder.csv'])
      await cp(join(setDir, f), join(root, 'survey', f));
    const gcpCsv = readGcpCsv(await readFile(join(setDir, 'gcp.csv'), 'utf8'));

    // the precomputed alignment
    const runDir = join(root, 'photogrammetry', PHOTO_RUN);
    await mkdir(join(runDir, 'report'), { recursive: true });
    await mkdir(join(runDir, 'sparse'), { recursive: true });
    const { run, gcp, accuracy } = precomputedRun(schema, {
      truth,
      alignment,
      ids,
      capture: m.captures[0]?.id,
      gcpCsv,
    });
    await writeFile(join(runDir, 'run.json'), json(run));
    await writeFile(join(runDir, 'gcp.json'), json(gcp));
    await writeFile(join(runDir, 'report', 'accuracy.json'), json(accuracy));
    for (const f of ['cameras.txt', 'points3D.txt'])
      await cp(join(setDir, 'alignment', 'sparse', f), join(runDir, 'sparse', f));
    // COLMAP image names: the project's copies (photos/syn-0001.jpg)
    const images = (await readFile(join(setDir, 'alignment', 'sparse', 'images.txt'), 'utf8'))
      .split('\n')
      .map((l) => {
        const v = l.split(' ');
        return !l.startsWith('#') && v.length === 10 && ids.has(v[9])
          ? [...v.slice(0, 9), `${ids.get(v[9])}.jpg`].join(' ')
          : l;
      })
      .join('\n');
    await writeFile(join(runDir, 'sparse', 'images.txt'), images);

    // the expected surface as 3D Tiles (hidden until a person shows it)
    await cp(join(setDir, 'tiles'), join(root, 'tiles'), { recursive: true });
    const tilesets = schema.TilesetsFile.parse({
      schema: 'aio.tilesets/1',
      entries: [
        {
          id: 'truth-mesh',
          name: 'Expected surface, mesh (synthetic truth)',
          kind: 'mesh',
          src: 'tiles/truth-mesh/tileset.json',
          visible: false,
        },
        {
          id: 'truth-cloud',
          name: 'Expected surface, points (synthetic truth)',
          kind: 'points',
          src: 'tiles/truth-cloud/tileset.json',
          visible: false,
        },
      ],
    });
    await writeFile(join(root, 'tilesets.json'), json(tilesets));
    await cp(join(setDir, 'truth.json'), join(root, 'truth.json'));

    // tidy: backups and the empty folders the wizard made
    for (const f of await readdir(root)) if (f.endsWith('.bak')) await rm(join(root, f));
    await removeEmptyDirs(root);

    const dest = join(out, PHOTO_ID);
    await rm(dest, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    await cp(root, dest, { recursive: true });
    const bytes = await treeSize(dest);
    const { budgetMb } = PHOTO_SETS[photoSet];
    log(
      `photo demo written (${photoSet} set, ${String(ids.size)} photos): ${(bytes / 1e6).toFixed(1)} MB`,
    );
    if (bytes > budgetMb * 1e6)
      throw new Error(
        `The photo demo (${photoSet} set) is ${(bytes / 1e6).toFixed(1)} MB, over its ${String(budgetMb)} MB budget.`,
      );
    return { root: dest, truth, bytes, photoSet };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ CLI

async function cli() {
  const argv = process.argv.slice(2);
  const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const out = resolve(opt('out', join(repo, 'apps', 'desktop', 'demo')));
  const quick = argv.includes('--quick');
  const t0 = Date.now();
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${m}`);
  const { photoSet } = await buildPhotoDemo({
    out,
    quick,
    log,
    python: opt('python'),
    cache: opt('cache'),
    set: opt('set'),
    photoSet: opt('photo-set'),
  });
  const infoFile = join(out, 'demo.json');
  let info = null;
  try {
    info = JSON.parse(await readFile(infoFile, 'utf8'));
  } catch {
    // no full demo here yet
  }
  const projects = [...new Set([...(info?.projects ?? []), PHOTO_ID])];
  const build = await treeHash(out, (rel) => rel === 'demo.json');
  await writeFile(
    infoFile,
    json({
      schema: 'aio.demo/1',
      ...(info ?? {}),
      build,
      quick: Boolean(info?.quick) || quick,
      photoSet,
      generator: info?.generator ?? 'partial',
      primary: info?.primary ?? PHOTO_ID,
      projects,
      note: info?.note ?? 'Synthetic demo data made by tools/demo. No client data.',
    }),
  );
  log(`listed in ${relative(repo, infoFile) || infoFile}`);
  const check = spawnSync(
    process.execPath,
    [join(repo, 'tools', 'demo', 'check-no-client-data.mjs'), join(out, PHOTO_ID)],
    { stdio: 'inherit' },
  );
  if (check.status !== 0) throw new Error('The photo demo failed the client data check.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cli().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
