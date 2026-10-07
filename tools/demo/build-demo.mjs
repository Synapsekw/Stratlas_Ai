#!/usr/bin/env node
/* eslint-disable no-console -- build script output */
// Build the publishable demo projects from nothing but this generator (no client data, no
// downloads): a fictional tank farm with a stockyard and a fictional access road in open desert.
//
//   node tools/demo/build-demo.mjs [--out apps/desktop/demo] [--seed 20261005] [--quick]
//                                  [--python <pipeline python>] [--keep-work]
//                                  [--photo-set mini|quick]
//
// Output (git-ignored, bundled by electron-builder `extraResources`, see electron-builder.yml):
//   <out>/demo.json                 which project the welcome opens, and the build stamp
//   <out>/demo-tank-farm/           fusion: model, drone video with poses, ortho + DSM, point
//                                   cloud, issues with photos, two stockpiles on two dates
//   <out>/demo-access-road/         a road survey: ortho, centreline, defects, PCI units
//   <out>/demo-change-site/         M8: a site on two dates with known changes, a DXF plan, a
//                                   test detector and truth.json (build-change-demo.mjs)
//   <out>/demo-photo-processing/    M10: drone photos of a synthetic site with GCPs, a
//                                   precomputed alignment and truth.json (photo-demo.mjs; the
//                                   mini set unless --photo-set or QUADRION_PHOTO_DEMO_SET says
//                                   quick, which is for development only and never released)
//
// The 3D model is procedural (geometry.mjs, scene.mjs) and written as GLB; every image (video
// frames, photos, orthos) is rendered from that same geometry by a small software rasteriser
// (render.mjs), so video-on-model fusion lines up exactly. The stockpile and road parts run the
// real pipelines (volumetric.build, road.build) on synthetic GeoTIFFs (pipelines.py). The result
// is checked by check-no-client-data.mjs before it is used.
//
// --quick renders the video at 10 fps without supersampling (CI); the content is the same.
// Needs ffmpeg with libx264 on the PATH and the pipeline Python (python/.venv after `uv sync`).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { writeGlb } from './glb.mjs';
import { prng } from './noise.mjs';
import { Renderer, lookAtQuat, projectPoint, rotate } from './render.mjs';
import { ROAD, EXTENT as ROAD_EXTENT, buildRoad } from './road.mjs';
import { EPOCHS, SITE, SUN, TANKS, YARD, yardHeight, yardMesh } from './scene.mjs';
import { createWorld } from './world.mjs';
import { generatorStamp } from './stamp.mjs';
import { CHANGE_ID, buildChangeDemo } from './build-change-demo.mjs';
import { PHOTO_ID, buildPhotoDemo } from './photo-demo.mjs';
import { writePhoto, writePngCloud, writePyramid } from './writers.mjs';
import { envVar } from '../../packages/brand/src/env.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const OUT = opt('out', join(repo, 'apps', 'desktop', 'demo'));
const SEED = Number(opt('seed', '20261005'));
const QUICK = flag('quick');
const KEEP = flag('keep-work');

/** Fictional location: open desert (Tanezrouft), thousands of km from any site we surveyed. */
const LOCATION = { lat: 23.4012, lon: 1.2047, h: 386, epsg: 32631 };
const SURVEY_DAY = '2026-04-13';
const AUTHOR = 'Demo inspector';
const PRIMARY = 'demo-tank-farm';

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${m}`);

// ------------------------------------------------------------------ TypeScript packages (jiti)
const projectRequire = createRequire(join(repo, 'packages', 'project', 'package.json'));
const { createJiti } = projectRequire('jiti');
const jiti = createJiti(import.meta.url);
const schema = await jiti.import(join(repo, 'packages', 'schema', 'src', 'index.ts'));
const builder = await jiti.import(join(repo, 'packages', 'project', 'src', 'builder', 'index.ts'));
const geo = await jiti.import(join(repo, 'packages', 'geo', 'src', 'index.ts'));

function pipelinePython() {
  const given = opt(
    'python',
    envVar(process.env, 'DEMO_PYTHON') ?? envVar(process.env, 'E2E_PYTHON'),
  );
  if (given) return given;
  const venv =
    process.platform === 'win32'
      ? join(repo, 'python', '.venv', 'Scripts', 'python.exe')
      : join(repo, 'python', '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  throw new Error(`No pipeline Python at ${venv}. Run "uv sync" in python/ or pass --python.`);
}

function requireFfmpeg() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (r.status !== 0 || !/libx264/.test(r.stdout))
    throw new Error('ffmpeg with libx264 is required on the PATH.');
}

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const r3 = (p) => p.map((v) => round(v));
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

async function main() {
  requireFfmpeg();
  const python = pipelinePython();
  const scratch = join(tmpdir(), `quadrion-demo-${String(process.pid)}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  // The pipelines resolve their input paths (Path.resolve): on Windows that expands 8.3 short
  // names (the CI runner's TEMP is C:\Users\RUNNER~1\..., resolved to the full account name), on
  // macOS it follows /var to /private/var. Work in the resolved form too, so tidy() recognises
  // every path under it and strips it from the published job file.
  const work = await realpath(scratch);
  const dataRoot = join(work, 'data');
  const [E, N] = geo
    .fromWgs84([LOCATION.lon, LOCATION.lat, 0], LOCATION.epsg)
    .map((v) => Math.round(v));
  const origin = [E, N, LOCATION.h];
  const roadOrigin = [E + 1800, N - 2600, LOCATION.h - 4];
  log(`origin E ${E} N ${N} (EPSG:${LOCATION.epsg}), work ${work}`);

  // 1. the two projects, made as the new project wizard makes them
  const site = await builder.createProject(
    dataRoot,
    {
      name: 'Demo tank farm',
      customer: 'Demo customer (fictional)',
      site: 'Fictional site in open desert (synthetic demo data)',
      type: 'fusion',
      epsg: LOCATION.epsg,
      origin,
      severityTemplate: builder.GENERAL_TEMPLATE.id,
    },
    builder.GENERAL_TEMPLATE,
  );
  const road = await builder.createProject(
    dataRoot,
    {
      name: 'Demo access road',
      customer: 'Demo customer (fictional)',
      site: 'Fictional desert access road (synthetic demo data)',
      type: 'road',
      epsg: LOCATION.epsg,
      origin: roadOrigin,
      severityTemplate: builder.ROAD_TEMPLATE.id,
    },
    builder.ROAD_TEMPLATE,
  );
  log(`projects ${relative(dataRoot, site.root)}, ${relative(dataRoot, road.root)}`);

  // 2. the world on both survey dates
  const worlds = {};
  worlds.e2 = createWorld(SEED, 'e2');
  worlds.e1 = createWorld(SEED, 'e1', { sand: worlds.e2.sand, site: worlds.e2.site });
  log('world built');

  // 3. stockyard surveys: DSM (0.1 m) and ortho (4 cm) per date, as raw rasters for the pipeline
  const spec = { work, epsg: LOCATION.epsg };
  spec.volumetric = { project: site.root, title: 'Demo stockyard', epochs: [] };
  for (const ep of EPOCHS) {
    const res = 0.1;
    const w = Math.round((YARD.x1 - YARD.x0) / res);
    const h = Math.round((YARD.z1 - YARD.z0) / res);
    const dsm = new Float32Array(w * h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++)
        dsm[j * w + i] =
          origin[2] + yardHeight(YARD.x0 + (i + 0.5) * res, YARD.z0 + (j + 0.5) * res, ep.id, SEED);
    const dsmFile = join(work, `yard-${ep.id}.f32`);
    await writeFile(dsmFile, Buffer.from(dsm.buffer));
    const ores = 0.04;
    const ow = Math.round((YARD.x1 - YARD.x0) / ores);
    const oh = Math.round((YARD.z1 - YARD.z0) / ores);
    const world = worlds[ep.id];
    const fine = new Renderer([...world.parts, yardMesh(ep.id, SEED, 0.2)], {
      sun: SUN,
      ground: world.ground,
      shadow: { x0: YARD.x0 - 4, z0: YARD.z0 - 4, x1: YARD.x1 + 4, z1: YARD.z1 + 4, size: 4096 },
    });
    const { rgb } = fine.render({ ortho: { ...YARD }, width: ow, height: oh }, { ss: 1 });
    const rgba = Buffer.alloc(ow * oh * 4, 255);
    for (let k = 0; k < ow * oh; k++) {
      rgba[4 * k] = rgb[3 * k];
      rgba[4 * k + 1] = rgb[3 * k + 1];
      rgba[4 * k + 2] = rgb[3 * k + 2];
    }
    const orthoFile = join(work, `yard-${ep.id}.rgba`);
    await writeFile(orthoFile, rgba);
    spec.volumetric.epochs.push({
      id: ep.id,
      date: ep.date,
      dsm: { raw: dsmFile, width: w, height: h, x0: E + YARD.x0, y1: N - YARD.z0, res },
      ortho: { raw: orthoFile, width: ow, height: oh, x0: E + YARD.x0, y1: N - YARD.z0, res: ores },
    });
  }
  log('stockyard surveys rendered');

  // 4. the road: ortho, centreline and defects (lon/lat)
  const rd = buildRoad(SEED, worlds.e2.sand);
  const toLonLat = (x, z, o) => {
    const ll = geo.toWgs84([o[0] + x, o[1] - z, 0], LOCATION.epsg);
    return [round(ll[0], 8), round(ll[1], 8)];
  };
  const roadOrthoFile = join(work, 'road.rgba');
  await writeFile(roadOrthoFile, rd.rgba);
  const centrelineFile = join(work, 'centreline.geojson');
  await writeFile(
    centrelineFile,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            name: 'Demo access road',
            chainageKm: rd.centreline.map((p) => round(p.km, 4)),
          },
          geometry: {
            type: 'LineString',
            coordinates: rd.centreline.map((p) => toLonLat(p.x, p.z, roadOrigin)),
          },
        },
      ],
    }),
  );
  const defectsFile = join(work, 'defects.geojson');
  await writeFile(
    defectsFile,
    JSON.stringify({
      type: 'FeatureCollection',
      features: rd.defects.map((d) => ({
        type: 'Feature',
        properties: { type: d.classId, severity: d.severity },
        geometry:
          d.kind === 'LineString'
            ? {
                type: 'LineString',
                coordinates: d.local.map(([x, z]) => toLonLat(x, z, roadOrigin)),
              }
            : {
                type: 'Polygon',
                coordinates: [d.local.map(([x, z]) => toLonLat(x, z, roadOrigin))],
              },
      })),
    }),
  );
  spec.road = {
    project: road.root,
    ortho: {
      raw: roadOrthoFile,
      width: rd.width,
      height: rd.height,
      x0: roadOrigin[0] + ROAD_EXTENT.x0,
      y1: roadOrigin[1] - ROAD_EXTENT.z0,
      res: ROAD.res,
    },
    centreline: centrelineFile,
    defects: defectsFile,
    lanes: ROAD.lanes,
    laneWidth: ROAD.laneWidth,
    name: 'Demo access road',
  };
  log(`road painted: ${rd.width} x ${rd.height} px, ${rd.defects.length} defects`);

  // 5. the pipelines (volumetric.build, road.build) on those rasters
  const specFile = join(work, 'spec.json');
  await writeFile(specFile, JSON.stringify(spec));
  const py = spawnSync(python, [join(repo, 'tools', 'demo', 'pipelines.py'), specFile], {
    stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  if (py.status !== 0) throw new Error(`pipelines.py failed (exit ${String(py.status)})`);
  log('pipelines done');

  // 6. the tank farm: model, site ortho and DSM, point cloud, video, photos, issues
  const world = worlds.e2;
  const layers = [];
  const { parts, defects } = world.asset;
  await mkdir(join(site.root, 'models'), { recursive: true });
  await writeFile(
    join(site.root, 'models', 'tank-farm.glb'),
    writeGlb(parts, { root: 'DemoTankFarm', generator: 'Quadrion AI demo builder' }),
  );
  layers.push({
    kind: 'mesh',
    id: 'model',
    name: 'Tank farm model (synthetic)',
    visible: true,
    src: { path: 'models/tank-farm.glb' },
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    tags: parts.map((p) => ({ node: p.name, tag: p.tag, area: p.area })),
  });
  log(`model: ${parts.length} parts`);

  // site ortho (6.25 cm) and DSM relief (12.5 cm)
  const OW = 2048;
  const ortho = world.renderer.render(
    { ortho: { ...SITE }, width: OW, height: OW },
    { ss: QUICK ? 1 : 2, heights: true },
  );
  const corners = {
    tl: [SITE.x0, 0.02, SITE.z0],
    tr: [SITE.x1, 0.02, SITE.z0],
    bl: [SITE.x0, 0.02, SITE.z1],
  };
  await writePyramid(site.root, 'rasters/site-ortho', ortho.rgb, OW, OW, corners);
  layers.push({
    kind: 'raster',
    id: 'site-ortho',
    name: `Site orthomosaic ${SURVEY_DAY}`,
    visible: true,
    src: { path: 'rasters/site-ortho/tiles.json' },
    role: 'ortho',
    format: 'kit-pyramid',
    corners,
  });
  const relief = reliefImage(ortho.heights, OW, 2);
  await writePyramid(site.root, 'rasters/site-dsm', relief, OW / 2, OW / 2, {
    ...corners,
    tl: [SITE.x0, 0.03, SITE.z0],
    tr: [SITE.x1, 0.03, SITE.z0],
    bl: [SITE.x0, 0.03, SITE.z1],
  });
  layers.push({
    kind: 'raster',
    id: 'site-dsm',
    name: `Site DSM ${SURVEY_DAY} (shaded relief)`,
    visible: false,
    src: { path: 'rasters/site-dsm/tiles.json' },
    role: 'dsm',
    format: 'kit-pyramid',
    corners: {
      tl: [SITE.x0, 0.03, SITE.z0],
      tr: [SITE.x1, 0.03, SITE.z0],
      bl: [SITE.x0, 0.03, SITE.z1],
    },
  });
  log('site ortho and DSM');

  // point cloud sampled from the model and the ground, colours as the sun lit them
  const cloud = samplePointCloud(world, SEED);
  const pc = await writePngCloud(site.root, 'clouds/site', cloud.pos, cloud.col, prng(SEED + 3));
  layers.push({
    kind: 'pointcloud',
    id: 'cloud',
    name: `Photogrammetry point cloud ${SURVEY_DAY}`,
    visible: false,
    src: { path: pc.index },
    format: 'png-packed',
    pointCount: pc.points,
  });
  log(`point cloud: ${pc.points} points`);

  // drone video with its pose track
  const video = await renderVideo(site.root, world);
  layers.push(video.layer);
  log(`video: ${video.frames} frames`);

  // photos: one per defect plus three overviews
  const photoItems = [];
  const issues = [];
  const PW = 1600;
  const PH = 1200;
  const lensPhoto = { model: 'pinhole', hfovDeg: 55, aspect: round(PW / PH, 4) };
  const takenAt = (m) => new Date(Date.UTC(2026, 3, 13, 9, 30 + m, 0)).toISOString();
  const statuses = ['reviewed', 'draft', 'approved', 'reviewed', 'draft', 'closed'];
  for (let k = 0; k < defects.length; k++) {
    const d = defects[k];
    const m = d.mapping;
    const c = m.at(d.offset[0], d.offset[1]);
    const n = m.normal;
    const ext = Math.max(...d.extent);
    const dist = Math.max(3.2, ext * 2.8);
    // stand off along the normal, a little up and to the side, like a drone photo
    const side = Math.hypot(n[0], n[2]) > 0.1 ? [-n[2], 0, n[0]] : [0.6, 0, 0.8];
    const eye = [
      c[0] + n[0] * dist + side[0] * dist * 0.25,
      c[1] + n[1] * dist + 0.35 * dist,
      c[2] + n[2] * dist + side[2] * dist * 0.25,
    ];
    const q = lookAtQuat(eye, c);
    const cam = { pos: eye, q, hfovDeg: lensPhoto.hfovDeg, width: PW, height: PH };
    const { rgb } = world.renderer.render(cam, { ss: QUICK ? 1 : 2 });
    const id = `d${String(k + 1).padStart(2, '0')}`;
    await writePhoto(site.root, `photos/${id}.jpg`, rgb, PW, PH);
    photoItems.push({
      id,
      src: { path: `photos/${id}.jpg` },
      takenAt: takenAt(k),
      pos: r3(eye),
      q: q.map((v) => round(v, 6)),
      lens: lensPhoto,
    });
    const box = boxOf(cam, m, d);
    const sightings = [
      { on: 'image', layer: 'photos', photo: id, geom: { type: 'box', ...box } },
      { on: 'mesh', layer: 'model', geom: { type: 'spoint', p: r3(c), n: r3(n) } },
    ];
    const track = video.track(m, d);
    if (track.length) sightings.push({ on: 'video', layer: video.layer.id, track });
    const at = takenAt(30 + k);
    issues.push({
      id: `demo-${d.code.toLowerCase()}`,
      code: d.code,
      classId: d.classId,
      severityModelId: builder.GENERAL_TEMPLATE.model.id,
      severity: d.severity,
      status: statuses[k % statuses.length],
      title: d.title,
      note: d.note,
      author: AUTHOR,
      createdAt: at,
      updatedAt: at,
      sightings,
      ...(d.classId === 'crack'
        ? { measurements: [{ kind: 'distance', value: 1.9, unit: 'm' }] }
        : {}),
      source: 'human',
    });
  }
  const overviews = [
    [-46, 38, 40],
    [36, 42, -40],
    [-30, 55, -52],
  ];
  for (let k = 0; k < overviews.length; k++) {
    const eye = overviews[k];
    const q = lookAtQuat(eye, [-2, 2, -2]);
    const lens = { model: 'pinhole', hfovDeg: 72, aspect: round(PW / PH, 4) };
    const { rgb } = world.renderer.render(
      { pos: eye, q, hfovDeg: lens.hfovDeg, width: PW, height: PH },
      { ss: QUICK ? 1 : 2 },
    );
    const id = `o${String(k + 1).padStart(2, '0')}`;
    await writePhoto(site.root, `photos/${id}.jpg`, rgb, PW, PH);
    photoItems.push({
      id,
      src: { path: `photos/${id}.jpg` },
      takenAt: takenAt(10 + k),
      pos: r3(eye),
      q: q.map((v) => round(v, 6)),
      lens,
    });
  }
  layers.push({
    kind: 'photos',
    id: 'photos',
    name: 'Inspection photos',
    visible: true,
    items: photoItems,
  });
  log(`photos: ${photoItems.length}, issues: ${issues.length}`);

  // library poster
  {
    const eye = [-52, 30, 44];
    const { rgb } = world.renderer.render(
      { pos: eye, q: lookAtQuat(eye, [8, 0, -6]), hfovDeg: 68, width: 1280, height: 720 },
      { ss: QUICK ? 1 : 2 },
    );
    await sharp(Buffer.from(rgb), { raw: { width: 1280, height: 720, channels: 3 } })
      .jpeg({ quality: 84 })
      .toFile(join(site.root, 'thumbnail.jpg'));
  }
  {
    const crop = {
      left: Math.round(rd.width * 0.3),
      top: 0,
      width: Math.round(rd.height * 1.7778),
      height: rd.height,
    };
    await sharp(rd.rgba, { raw: { width: rd.width, height: rd.height, channels: 4 } })
      .extract(crop)
      .removeAlpha()
      .resize(1280, 720)
      .jpeg({ quality: 84 })
      .toFile(join(road.root, 'thumbnail.jpg'));
  }

  // 7. manifests and issues: merge into what the pipelines wrote, validate with the schema
  const m = JSON.parse(await readFile(join(site.root, 'manifest.json'), 'utf8'));
  m.layers = [
    ...layers.filter((l) => l.kind === 'mesh'),
    ...m.layers,
    ...layers.filter((l) => l.kind !== 'mesh'),
  ];
  const parsed = schema.parseManifest(m);
  if (!parsed.ok) throw new Error(`site manifest: ${parsed.error}`);
  await writeFile(join(site.root, 'manifest.json'), json(m));
  const issueFile = JSON.parse(await readFile(join(site.root, 'issues.json'), 'utf8'));
  issueFile.issues = [...issueFile.issues, ...issues];
  for (const is of issueFile.issues) {
    const r = schema.Issue.safeParse(is);
    if (!r.success) throw new Error(`issue ${is.code}: ${r.error.issues[0]?.message}`);
    const model = m.severityModels.find((s) => s.id === is.severityModelId);
    const v = schema.validateIssueAgainstModel(r.data, model);
    if (!v.ok) throw new Error(v.error);
  }
  await writeFile(join(site.root, 'issues.json'), json(issueFile));
  const rm2 = schema.parseManifest(
    JSON.parse(await readFile(join(road.root, 'manifest.json'), 'utf8')),
  );
  if (!rm2.ok) throw new Error(`road manifest: ${rm2.error}`);
  for (const root of [site.root, road.root]) await tidy(root, work);

  // 8. publish into the output folder with the build stamp
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (const p of [site, road]) await cp(p.root, join(OUT, p.manifest.id), { recursive: true });
  // the change and modelling demo: a separate project with its own budget (founder decision 6)
  await buildChangeDemo({ out: OUT, seed: SEED, quick: QUICK, log });
  // M10: the photo processing demo (synthetic photogrammetry set, its own seed and budget)
  const photo = await buildPhotoDemo({
    out: OUT,
    quick: QUICK,
    log,
    python,
    photoSet: opt('photo-set'),
  });
  const stamp = await treeHash(OUT);
  await writeFile(
    join(OUT, 'demo.json'),
    json({
      schema: 'aio.demo/1',
      build: stamp,
      seed: SEED,
      quick: QUICK,
      photoSet: photo.photoSet,
      generator: generatorStamp(),
      primary: PRIMARY,
      projects: [site.manifest.id, road.manifest.id, CHANGE_ID, PHOTO_ID],
      note: 'Synthetic demo data made by tools/demo/build-demo.mjs. No client data.',
    }),
  );
  if (!KEEP) await rm(work, { recursive: true, force: true });
  const size = await treeSize(OUT);
  log(`demo written to ${OUT}: ${(size / 1e6).toFixed(1)} MB, build ${stamp.slice(0, 12)}`);

  const check = spawnSync(
    process.execPath,
    [join(repo, 'tools', 'demo', 'check-no-client-data.mjs'), OUT],
    { stdio: 'inherit' },
  );
  if (check.status !== 0) throw new Error('The demo failed the client data check.');
  const change = spawnSync(
    process.execPath,
    [join(repo, 'tools', 'demo', 'check-change-demo.mjs'), OUT],
    { stdio: 'inherit' },
  );
  if (change.status !== 0) throw new Error('The change demo failed its checks.');
}

/** Shaded relief of the DSM (heights in local metres), downsampled by `f`. */
function reliefImage(heights, size, f) {
  const n = size / f;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let m = -Infinity;
      for (let b = 0; b < f; b++)
        for (let a = 0; a < f; a++) {
          const v = heights[(j * f + b) * size + i * f + a];
          if (v > m) m = v;
        }
      h[j * n + i] = Number.isFinite(m) ? m : 0;
    }
  const px = (SITE.x1 - SITE.x0) / n;
  const out = new Uint8Array(n * n * 3);
  const ramp = [
    [0, [38, 84, 124]],
    [0.6, [64, 150, 120]],
    [2.5, [190, 200, 90]],
    [7, [226, 140, 60]],
    [14, [200, 70, 60]],
    [18, [250, 250, 250]],
  ];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const v = h[j * n + i];
      const dx = (h[j * n + Math.min(n - 1, i + 1)] - h[j * n + Math.max(0, i - 1)]) / (2 * px);
      const dz = (h[Math.min(n - 1, j + 1) * n + i] - h[Math.max(0, j - 1) * n + i]) / (2 * px);
      const nx = -dx,
        ny = 1,
        nz = -dz;
      const nl = Math.hypot(nx, ny, nz);
      const shade = 0.55 + 0.45 * Math.max(0, (nx * SUN[0] + ny * SUN[1] + nz * SUN[2]) / nl);
      let c = ramp[ramp.length - 1][1];
      for (let k = 0; k + 1 < ramp.length; k++)
        if (v <= ramp[k + 1][0]) {
          const t = Math.max(0, (v - ramp[k][0]) / (ramp[k + 1][0] - ramp[k][0]));
          c = ramp[k][1].map((a, q) => a + (ramp[k + 1][1][q] - a) * t);
          break;
        }
      const o = (j * n + i) * 3;
      for (let q = 0; q < 3; q++) out[o + q] = Math.round(Math.min(255, c[q] * shade));
    }
  return out;
}

/** Points on the model surfaces and the site ground, lit like the photos (photogrammetry look). */
function samplePointCloud(world, seed) {
  const rnd = prng(seed + 2);
  const pos = [];
  const col = [];
  const sun = SUN;
  const tmp = new Float32Array(3);
  const light = (p, n, c) => {
    const ndl = Math.max(0, n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]);
    const lit =
      ndl > 0 ? world.renderer.lit(p[0] + n[0] * 0.3, p[1] + n[1] * 0.3, p[2] + n[2] * 0.3) : 0;
    const k = 0.3 * (0.5 + 0.5 * n[1]) + 0.12 + 0.78 * ndl * lit;
    return c.map((v) => Math.max(0, Math.min(255, Math.round(v * k * 255))));
  };
  const jitter = () => (rnd() + rnd() + rnd() - 1.5) * 0.012;
  const PER_M2 = 18;
  for (const part of world.parts) {
    const { pos: P, nrm: Nn, col: C, idx } = part;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const A = [P[3 * a], P[3 * a + 1], P[3 * a + 2]];
      const B = [P[3 * b], P[3 * b + 1], P[3 * b + 2]];
      const Cc = [P[3 * c], P[3 * c + 1], P[3 * c + 2]];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const v = [Cc[0] - A[0], Cc[1] - A[1], Cc[2] - A[2]];
      const area =
        0.5 *
        Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      let count = area * PER_M2;
      while (count > 0) {
        if (count < 1 && rnd() > count) break;
        count -= 1;
        let s = rnd();
        let r = rnd();
        if (s + r > 1) {
          s = 1 - s;
          r = 1 - r;
        }
        const p = [0, 1, 2].map((k) => A[k] + u[k] * s + v[k] * r + jitter());
        const w = 1 - s - r;
        const n = [0, 1, 2].map((k) => Nn[3 * a + k] * w + Nn[3 * b + k] * s + Nn[3 * c + k] * r);
        const cc = [0, 1, 2].map((k) => C[3 * a + k] * w + C[3 * b + k] * s + C[3 * c + k] * r);
        pos.push(...p);
        col.push(...light(p, n, cc));
      }
    }
  }
  const groundPts = Math.round((SITE.x1 - SITE.x0) * (SITE.z1 - SITE.z0) * PER_M2 * 0.9);
  for (let k = 0; k < groundPts; k++) {
    const x = SITE.x0 + rnd() * (SITE.x1 - SITE.x0);
    const z = SITE.z0 + rnd() * (SITE.z1 - SITE.z0);
    // points under a tank or the building are hidden from the drone
    if (TANKS.some((t) => Math.hypot(x - t.cx, z - t.cz) < t.R)) continue;
    world.ground(x, z, 0.05, tmp);
    const p = [x, jitter(), z];
    pos.push(...p);
    col.push(...light(p, [0, 1, 0], [tmp[0], tmp[1], tmp[2]]));
  }
  return { pos: new Float32Array(pos), col: new Uint8Array(col) };
}

/** The drone video: an orbit of the tank farm, rendered by worker threads and encoded by ffmpeg. */
async function renderVideo(root, world) {
  const W = 1280;
  const H = 720;
  const FPS = QUICK ? 10 : 25;
  const SECONDS = 24;
  const SS = QUICK ? 1 : 2;
  const lens = { model: 'pinhole', hfovDeg: 70, aspect: round(W / H, 4) };
  const startUtcMs = Date.UTC(2026, 3, 13, 9, 20, 0);
  const frames = FPS * SECONDS;
  const centre = [-2, 0, -4];
  const pose = (tSec) => {
    const s = tSec / SECONDS;
    const ease = s * s * (3 - 2 * s) * 0.3 + s * 0.7;
    const phi = ((152 - 124 * ease) * Math.PI) / 180;
    const R = 50 - 6 * s;
    const alt = 31 - 5 * s + 0.4 * Math.sin(tSec * 0.9);
    const eye = [centre[0] + R * Math.cos(phi), alt, centre[2] + R * Math.sin(phi)];
    const target = [centre[0] + 6 * Math.cos(phi + 0.6) * s, 2.5, centre[2] - 4 + 3 * s];
    let q = lookAtQuat(eye, target);
    // a little hand-flown wobble
    const wob = (a, f, ph) => a * Math.sin(tSec * f + ph);
    const yaw = (wob(0.35, 1.3, 0.2) * Math.PI) / 180;
    const pitch = (wob(0.25, 1.7, 1.1) * Math.PI) / 180;
    q = mulQ(q, [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)]);
    q = mulQ(q, [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    return { pos: eye, q };
  };
  const samples = [];
  for (let i = 0; i < frames; i++) {
    const p = pose(i / FPS);
    samples.push({
      t: Math.round((i * 1000) / FPS),
      pos: r3(p.pos),
      q: p.q.map((v) => round(v, 6)),
    });
  }
  await mkdir(join(root, 'flights'), { recursive: true });
  await writeFile(
    join(root, 'flights', 'flight-01.json'),
    json({ schema: 'aio.flight/1', startUtcMs, lens, samples }),
  );

  // frames: workers render, the main thread feeds ffmpeg in order
  await mkdir(join(root, 'video'), { recursive: true });
  const ff = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${W}x${H}`,
      '-r',
      String(FPS),
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      QUICK ? '28' : '23',
      '-pix_fmt',
      'yuv420p',
      '-g',
      String(FPS),
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      '-an',
      join(root, 'video', 'flight-01.mp4'),
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const ffDone = new Promise((res, rej) =>
    ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)))),
  );
  const nWorkers = Math.max(1, Math.min(QUICK ? 4 : 12, availableParallelism() - 1, frames));
  let next = 0;
  let written = 0;
  const pending = new Map();
  let poster = null;
  await new Promise((resolve, reject) => {
    const workers = [];
    const feed = (w) => {
      if (next >= frames || next - written > nWorkers * 3) return false;
      const i = next++;
      const p = pose(i / FPS);
      w.busy = true;
      w.postMessage({
        index: i,
        cam: { pos: p.pos, q: p.q, hfovDeg: lens.hfovDeg, width: W, height: H },
      });
      return true;
    };
    const drain = () => {
      while (pending.has(written)) {
        const rgb = pending.get(written);
        pending.delete(written);
        if (written === 0) poster = Buffer.from(rgb);
        ff.stdin.write(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength));
        written++;
        if (written % 100 === 0) log(`  frame ${written} of ${frames}`);
      }
      for (const w of workers) if (!w.busy) feed(w);
      if (written === frames) {
        for (const w of workers) w.postMessage({ stop: true });
        resolve();
      }
    };
    for (let k = 0; k < nWorkers; k++) {
      const w = new Worker(new URL('./frames-worker.mjs', import.meta.url), {
        workerData: { seed: SEED, epoch: 'e2', ss: SS },
      });
      w.busy = false;
      w.on('message', (msg) => {
        if (msg.ready) {
          feed(w);
          return;
        }
        w.busy = false;
        pending.set(msg.index, msg.rgb);
        drain();
      });
      w.on('error', reject);
      workers.push(w);
    }
  });
  ff.stdin.end();
  await ffDone;
  await mkdir(join(root, 'posters'), { recursive: true });
  await sharp(poster, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 84 })
    .toFile(join(root, 'posters', 'flight-01.jpg'));

  const layer = {
    kind: 'video',
    id: 'flight-01',
    name: 'Drone video: orbit of the tank farm',
    visible: true,
    src: { path: 'video/flight-01.mp4' },
    flight: { src: { path: 'flights/flight-01.json' }, startUtcMs },
    lens,
    offsetMs: 0,
    poster: { path: 'posters/flight-01.jpg' },
  };
  /** Keyframes (every half second) of a defect's box while the drone sees it face on. */
  const track = (m, d) => {
    const out = [];
    for (let t = 0; t <= SECONDS - 0.5; t += 0.5) {
      const p = pose(t);
      const cam = { pos: p.pos, q: p.q, hfovDeg: lens.hfovDeg, width: W, height: H };
      const c = m.at(d.offset[0], d.offset[1]);
      const view = [c[0] - p.pos[0], c[1] - p.pos[1], c[2] - p.pos[2]];
      const facing =
        -(view[0] * m.normal[0] + view[1] * m.normal[1] + view[2] * m.normal[2]) /
        Math.hypot(...view);
      const fwd = rotate(p.q, [0, 0, -1]);
      if (facing < 0.35 || view[0] * fwd[0] + view[1] * fwd[1] + view[2] * fwd[2] <= 0) {
        if (out.length) break;
        continue;
      }
      const b = boxOf(cam, m, d, 0.02);
      if (
        !b ||
        b.x < 4 ||
        b.y < 4 ||
        b.x + b.w > W - 4 ||
        b.y + b.h > H - 4 ||
        occluded(world, p.pos, c)
      ) {
        if (out.length) break;
        continue;
      }
      out.push({ t: round(t, 2), geom: { type: 'box', ...b } });
    }
    return out.length >= 2 ? out : [];
  };
  return { layer, frames, track };
}

/** Is the line from the eye to the point blocked by a tank (cylinder test, enough for the demo)? */
function occluded(world, eye, p) {
  for (const t of TANKS) {
    const ex = eye[0] - t.cx;
    const ez = eye[2] - t.cz;
    const dx = p[0] - eye[0];
    const dz = p[2] - eye[2];
    const a = dx * dx + dz * dz;
    const b = 2 * (ex * dx + ez * dz);
    const c = ex * ex + ez * ez - t.R * t.R;
    const disc = b * b - 4 * a * c;
    if (disc <= 0) continue;
    const s = (-b - Math.sqrt(disc)) / (2 * a);
    if (s > 0.02 && s < 0.98) {
      const y = eye[1] + (p[1] - eye[1]) * s;
      if (y < t.H + 0.3) return true;
    }
  }
  void world;
  return false;
}

/** The image box of a defect's extent, padded, in pixels; null when it is not in front. */
function boxOf(cam, m, d, pad = 0.06) {
  const [ex, ey] = d.extent;
  const pts = [];
  for (const a of [-0.5, 0, 0.5])
    for (const b of [-0.5, 0, 0.5]) {
      const p = projectPoint(cam, m.at(d.offset[0] + a * ex, d.offset[1] + b * ey));
      if (!p) return null;
      pts.push(p);
    }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const px = (x1 - x0) * pad + 4;
  const py = (y1 - y0) * pad + 4;
  x0 = Math.max(0, x0 - px);
  y0 = Math.max(0, y0 - py);
  x1 = Math.min(cam.width, x1 + px);
  y1 = Math.min(cam.height, y1 + py);
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.max(1, Math.round(x1 - x0)),
    h: Math.max(1, Math.round(y1 - y0)),
  };
}

function mulQ(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * Remove what the pipelines leave for a resumable job (jobs/, .bak files) and make the kept job
 * file portable: no path of the build machine in a published project.
 */
async function tidy(root, work) {
  await rm(join(root, 'jobs'), { recursive: true, force: true });
  for (const f of await readdir(root)) if (f.endsWith('.bak')) await rm(join(root, f));
  const job = join(root, 'volumetric', 'job.json');
  if (existsSync(job)) {
    const text = await readFile(job, 'utf8');
    const j = JSON.parse(text);
    const strip = (v) => {
      if (typeof v === 'string' && (v.startsWith(work) || v.includes(work.replace(/\\/g, '/'))))
        return `sources/${v.split(/[\\/]/).pop()}`;
      if (Array.isArray(v)) return v.map(strip);
      if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]));
      return v;
    };
    await writeFile(job, json(strip(j)));
  }
}

async function treeFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await treeFiles(p)));
    else out.push(p);
  }
  return out.sort();
}

async function treeHash(dir) {
  const h = createHash('sha256');
  for (const f of await treeFiles(dir)) {
    h.update(relative(dir, f).replace(/\\/g, '/'));
    h.update(await readFile(f));
  }
  return h.digest('hex');
}

async function treeSize(dir) {
  let n = 0;
  for (const f of await treeFiles(dir)) n += (await stat(f)).size;
  return n;
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
