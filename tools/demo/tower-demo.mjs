#!/usr/bin/env node
/* eslint-disable no-console -- build script output */
// The Demo tower (telecom finalize, item 64): a fictional 40 m lattice tower in open desert, as a
// Telecom towers project with a photogrammetry-like point cloud and posed drone photos of its
// crown, and no antenna list yet (no telecom/antennas.json), so Detect antennas has a whole tower
// to find.
//
//   node tools/demo/tower-demo.mjs [--out apps/desktop/demo] [--quick] [--python <python>]
//                                  [--write-truth]
//
// The cloud is the tower the telecom specs generate (python/tests/antenna_synth.py), the lattice
// kind: four legs and their bracing, a ring headframe with mount pipes and nine units (three
// panels with 2, 4 and 6 degrees of downtilt, three short units, one wide panel, a dish and a
// small radio), plus the ground. The photos are rendered from that same cloud (point splats, the
// units drawn lighter than the steel), so a unit's box projects onto what the photo shows.
//
// tower-truth.json beside this file is the known truth of the units in the project's terms
// (grid azimuth, downtilt, centre altitude, size): the build fails when the generated tower no
// longer matches it (--write-truth rewrites it; run prettier on it after), and writes it into the
// project as truth.json.
// Byte for byte reproducible: fixed seeds, no clock, no temp path in any file. --quick is
// accepted for symmetry with the other demos: the content is the same.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';
import { treeHash, treeSize } from './build-change-demo.mjs';
import { prng } from './noise.mjs';
import { pipelinePython } from './photo-demo.mjs';
import { lookAtQuat, rotate } from './render.mjs';
import { writePhoto, writePngCloud } from './writers.mjs';

export const TOWER_ID = 'demo-tower';
export const TOWER_NAME = 'Demo tower';
/** The synth's tower: kind, seed and density (2500 per m2: dense enough for the small radio). */
export const TOWER_SYNTH = Object.freeze({ kind: 'lattice', seed: 3, pointsPerM2: 2500 });
/** Fictional place: open desert (Tanezrouft), 5 km east of the tank farm demo. */
export const TOWER_PLACE = Object.freeze({ lat: 23.4012, lon: 1.2537, h: 386, epsg: 32631 });
export const TOWER_DAY = '2026-04-14';
/** Size budget on disk (the demo ships in the installer). */
export const TOWER_BUDGET_MB = 25;
export const TRUTH_FILE = fileURLToPath(new URL('./tower-truth.json', import.meta.url));

const repo = fileURLToPath(new URL('../..', import.meta.url));
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

let libsCache = null;
async function libs() {
  if (libsCache) return libsCache;
  const projectRequire = createRequire(join(repo, 'packages', 'project', 'package.json'));
  const { createJiti } = projectRequire('jiti');
  const jiti = createJiti(import.meta.url);
  libsCache = {
    schema: await jiti.import(join(repo, 'packages', 'schema', 'src', 'index.ts')),
    builder: await jiti.import(join(repo, 'packages', 'project', 'src', 'builder', 'index.ts')),
    geo: await jiti.import(join(repo, 'packages', 'geo', 'src', 'index.ts')),
  };
  return libsCache;
}

/** Run antenna_synth.py: the cloud (x east, y up, z south, metres, base at 0) and its truth. */
export async function generateTowerCloud(work, { python } = {}) {
  const out = join(work, 'tower.f32');
  const r = spawnSync(
    pipelinePython(python),
    [
      join(repo, 'python', 'tests', 'antenna_synth.py'),
      '--kind',
      TOWER_SYNTH.kind,
      '--seed',
      String(TOWER_SYNTH.seed),
      '--points-per-m2',
      String(TOWER_SYNTH.pointsPerM2),
      '--out',
      out,
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
  );
  if (r.status !== 0)
    throw new Error(`antenna_synth.py failed: ${r.stderr || r.error?.message || ''}`);
  const raw = await readFile(out);
  const xyz = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const synth = JSON.parse(await readFile(`${out}.json`, 'utf8'));
  return { xyz: Float32Array.from(xyz), synth };
}

/**
 * The truth file of the Demo tower from the synth's truth: one entry per unit in the project's
 * terms. Azimuths are grid azimuths (what the inventory stores; true = grid + convergenceDeg),
 * downtilt is positive down, the centre altitude is the project Z of the unit's box centre
 * (origin height plus its height above the tower base), sizes are the box in metres (a dish:
 * its diameter, its elevation instead of a downtilt).
 */
export function towerTruth(synth, { origin, epsg, convergenceDeg }) {
  const units = synth.units.map((u) => {
    const [x, y, z] = u.centre;
    const base = {
      name: u.name,
      kind: u.kind,
      azimuthDeg: round(u.azimuthDeg, 3),
      ...(u.kind === 'dish'
        ? { elevationDeg: round(u.elevationDeg, 3), diameterM: round(u.diameterM, 3) }
        : { downtiltDeg: round(u.downtiltDeg, 3), plumbDeg: round(u.plumbDeg, 3) }),
      centreAltitudeM: round(origin[2] + y, 3),
      heightAboveBaseM: round(y, 3),
      centre: [round(origin[0] + x, 3), round(origin[1] - z, 3), round(origin[2] + y, 3)],
      widthM: round(u.widthM, 3),
      heightM: round(u.heightM, 3),
      depthM: round(u.depthM, 3),
    };
    return base;
  });
  return {
    kind: 'demo-tower-truth',
    note: 'Synthetic truth of the Demo tower (tools/demo/tower-demo.mjs). No client data.',
    synth: { ...TOWER_SYNTH, generator: 'python/tests/antenna_synth.py' },
    crs: { epsg },
    origin,
    north: 'grid',
    convergenceDeg: round(convergenceDeg, 4),
    axis: { point: [origin[0], origin[1], origin[2]], dir: [0, 0, 1] },
    towerHeightM: synth.height,
    units,
  };
}

// ------------------------------------------------------------------ colours and photos

const STEEL = [150, 156, 162];
const UNIT = [226, 228, 224];
const SAND = [196, 170, 128];

/** (across, up, normal) of a unit, as antenna_synth.py `unit_axes`. */
function unitAxes(az, dt, pl) {
  let across = [1, 0, 0];
  let up = [0, 1, 0];
  let normal = [0, 0, -1];
  const d = (dt * Math.PI) / 180;
  const p = (pl * Math.PI) / 180;
  const mix = (a, ka, b, kb) => a.map((v, i) => v * ka + b[i] * kb);
  [normal, up] = [
    mix(normal, Math.cos(d), up, -Math.sin(d)),
    mix(up, Math.cos(d), normal, Math.sin(d)),
  ];
  [up, across] = [
    mix(up, Math.cos(p), across, -Math.sin(p)),
    mix(across, Math.cos(p), up, Math.sin(p)),
  ];
  const t = (az * Math.PI) / 180;
  const rotY = (v) => [
    v[0] * Math.cos(t) - v[2] * Math.sin(t),
    v[1],
    v[0] * Math.sin(t) + v[2] * Math.cos(t),
  ];
  return [rotY(across), rotY(up), rotY(normal)];
}

/** Per point colour: sand ground, light units (inside a truth box, a little padded), grey steel. */
export function colourCloud(xyz, synth) {
  const boxes = synth.units.map((u) =>
    u.kind === 'dish'
      ? { c: u.centre, r: u.diameterM / 2 + 0.03 }
      : {
          c: u.centre,
          axes: unitAxes(u.azimuthDeg, u.downtiltDeg, u.plumbDeg),
          half: [u.widthM / 2 + 0.02, u.heightM / 2 + 0.02, u.depthM / 2 + 0.02],
        },
  );
  const n = xyz.length / 3;
  const col = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]];
    let c = p[1] < 0.05 ? SAND : STEEL;
    if (p[1] > 10)
      for (const b of boxes) {
        const d = [p[0] - b.c[0], p[1] - b.c[1], p[2] - b.c[2]];
        const inside = b.r
          ? Math.hypot(...d) <= b.r
          : b.axes.every((a, k) => Math.abs(d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) <= b.half[k]);
        if (inside) {
          c = UNIT;
          break;
        }
      }
    // a little deterministic speckle, as a photogrammetry cloud has
    const s = ((i * 2654435761) >>> 24) / 255 - 0.5;
    for (let k = 0; k < 3; k++)
      col[3 * i + k] = Math.max(0, Math.min(255, Math.round(c[k] + s * 18)));
  }
  return col;
}

/** Render the cloud from a pinhole camera as depth-tested point splats on a sky gradient. */
export function renderSplats(xyz, col, cam) {
  const { width: W, height: H } = cam;
  const r = rotate(cam.q, [1, 0, 0]);
  const u = rotate(cam.q, [0, 1, 0]);
  const b = rotate(cam.q, [0, 0, 1]);
  const f = W / 2 / Math.tan((cam.hfovDeg * Math.PI) / 360);
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const t = y / H;
    for (let x = 0; x < W; x++) {
      const o = 3 * (y * W + x);
      rgb[o] = Math.round(150 + 60 * t);
      rgb[o + 1] = Math.round(184 + 40 * t);
      rgb[o + 2] = Math.round(222 + 20 * t);
    }
  }
  const depth = new Float32Array(W * H).fill(Infinity);
  const n = xyz.length / 3;
  for (let i = 0; i < n; i++) {
    const dx = xyz[3 * i] - cam.pos[0];
    const dy = xyz[3 * i + 1] - cam.pos[1];
    const dz = xyz[3 * i + 2] - cam.pos[2];
    const zc = -(dx * b[0] + dy * b[1] + dz * b[2]);
    if (zc < 0.3) continue;
    const sx = W / 2 + (f * (dx * r[0] + dy * r[1] + dz * r[2])) / zc;
    const sy = H / 2 - (f * (dx * u[0] + dy * u[1] + dz * u[2])) / zc;
    // a splat about the point spacing (2 cm) wide, at least one pixel
    const half = Math.max(0, Math.min(3, Math.round((f * 0.012) / zc)));
    const cx = Math.round(sx);
    const cy = Math.round(sy);
    if (cx < -half || cy < -half || cx >= W + half || cy >= H + half) continue;
    const shade = Math.max(0.55, Math.min(1, 1.15 - zc / 120));
    for (let yy = Math.max(0, cy - half); yy <= Math.min(H - 1, cy + half); yy++)
      for (let xx = Math.max(0, cx - half); xx <= Math.min(W - 1, cx + half); xx++) {
        const k = yy * W + xx;
        if (zc >= depth[k]) continue;
        depth[k] = zc;
        rgb[3 * k] = Math.round(col[3 * i] * shade);
        rgb[3 * k + 1] = Math.round(col[3 * i + 1] * shade);
        rgb[3 * k + 2] = Math.round(col[3 * i + 2] * shade);
      }
  }
  return rgb;
}

/** The drone photos: eight round the crown, 9 m out, and two of the whole tower. */
export function photoPoses(crownY) {
  const target = [0, crownY, 0];
  const poses = [];
  for (let k = 0; k < 8; k++) {
    const az = 22.5 + 45 * k;
    const t = (az * Math.PI) / 180;
    poses.push({
      id: `crown-${String(k + 1).padStart(2, '0')}`,
      eye: [9 * Math.sin(t), crownY + 1.5, -9 * Math.cos(t)],
      target,
      hfovDeg: 62,
    });
  }
  for (const [k, az] of [150, 330].entries()) {
    const t = (az * Math.PI) / 180;
    poses.push({
      id: `tower-${String(k + 1).padStart(2, '0')}`,
      eye: [48 * Math.sin(t), 20, -48 * Math.cos(t)],
      target: [0, 20, 0],
      hfovDeg: 72,
    });
  }
  return poses;
}

async function removeEmptyDirs(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }))
    if (e.isDirectory()) await removeEmptyDirs(join(dir, e.name));
  if ((await readdir(dir)).length === 0) await rmdir(dir);
}

/**
 * Build the Demo tower into `<out>/demo-tower/`. Returns { id, root, bytes, truth, points, photos }.
 * @param {{ out: string, quick?: boolean, python?: string, log?: (m: string) => void, writeTruth?: boolean }} o
 */
export async function buildTowerDemo({ out, python, log = () => undefined, writeTruth = false }) {
  const { schema, builder, geo } = await libs();
  const work = await mkdtemp(join(tmpdir(), 'quadrion-tower-demo-'));
  try {
    const { xyz, synth } = await generateTowerCloud(work, { python });
    log(`${TOWER_ID}: tower generated (${String(xyz.length / 3)} points)`);
    const [E, N] = geo
      .fromWgs84([TOWER_PLACE.lon, TOWER_PLACE.lat, 0], TOWER_PLACE.epsg)
      .map((v) => Math.round(v));
    const origin = [E, N, TOWER_PLACE.h];
    const ll = geo.toWgs84(origin, TOWER_PLACE.epsg);
    const convergenceDeg = geo.gridConvergenceDeg(ll[0], ll[1], TOWER_PLACE.epsg);
    const truth = towerTruth(synth, { origin, epsg: TOWER_PLACE.epsg, convergenceDeg });
    if (writeTruth) await writeFile(TRUTH_FILE, json(truth));
    const known = await readFile(TRUTH_FILE, 'utf8').then(JSON.parse, () => null);
    if (!isDeepStrictEqual(known, JSON.parse(JSON.stringify(truth))))
      throw new Error(
        `The generated tower no longer matches ${relative(repo, TRUTH_FILE)}; check the synth, then rebuild with --write-truth.`,
      );

    // made as the New project wizard makes a Telecom towers project
    const { root, manifest } = await builder.createProject(
      join(work, 'data'),
      {
        name: TOWER_NAME,
        customer: 'Demo customer (fictional)',
        site: 'Fictional lattice tower in open desert (synthetic demo data)',
        purpose: 'telecom',
        epsg: TOWER_PLACE.epsg,
        origin,
        captureDate: TOWER_DAY,
        severityTemplate: builder.GENERAL_TEMPLATE.id,
      },
      builder.GENERAL_TEMPLATE,
    );
    if (manifest.id !== TOWER_ID) throw new Error(`project id ${manifest.id}`);
    const capture = manifest.captures[0]?.id;

    const col = colourCloud(xyz, synth);
    const pc = await writePngCloud(root, 'clouds/tower', xyz, col, prng(TOWER_SYNTH.seed + 101));
    const layers = [
      {
        kind: 'pointcloud',
        id: 'tower-cloud',
        name: `Tower point cloud ${TOWER_DAY}`,
        visible: true,
        ...(capture ? { capture } : {}),
        src: { path: pc.index },
        format: 'png-packed',
        pointCount: pc.points,
      },
    ];
    log(`${TOWER_ID}: point cloud ${String(pc.points)} points`);

    const PW = 1280;
    const PH = 960;
    const crownY = (synth.units.find((u) => u.kind === 'panel')?.centre[1] ?? 37.5) - 0.2;
    const items = [];
    const poses = photoPoses(crownY);
    for (const [k, p] of poses.entries()) {
      const q = lookAtQuat(p.eye, p.target);
      const rgb = renderSplats(xyz, col, {
        pos: p.eye,
        q,
        hfovDeg: p.hfovDeg,
        width: PW,
        height: PH,
      });
      await writePhoto(root, `photos/${p.id}.jpg`, rgb, PW, PH);
      items.push({
        id: p.id,
        src: { path: `photos/${p.id}.jpg` },
        takenAt: new Date(Date.UTC(2026, 3, 14, 8, 10 + k, 0)).toISOString(),
        pos: p.eye.map((v) => round(v)),
        q: q.map((v) => round(v, 6)),
        lens: { model: 'pinhole', hfovDeg: p.hfovDeg, aspect: round(PW / PH, 4) },
      });
      if (k === poses.length - 1)
        await sharp(Buffer.from(rgb), { raw: { width: PW, height: PH, channels: 3 } })
          .resize(1280, 720, { fit: 'cover' })
          .jpeg({ quality: 84 })
          .toFile(join(root, 'thumbnail.jpg'));
    }
    layers.push({
      kind: 'photos',
      id: 'photos',
      name: 'Drone photos of the tower',
      visible: true,
      ...(capture ? { capture } : {}),
      items,
    });
    log(`${TOWER_ID}: ${String(items.length)} photos`);

    const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    m.layers = layers;
    const parsed = schema.parseManifest(m);
    if (!parsed.ok) throw new Error(`manifest: ${parsed.error}`);
    await writeFile(join(root, 'manifest.json'), json(m));
    await writeFile(join(root, 'truth.json'), json(truth));
    await writeFile(
      join(root, 'README.txt'),
      [
        `${TOWER_NAME}: synthetic telecom data (python/tests/antenna_synth.py, tools/demo/tower-demo.mjs).`,
        'No client data: a fictional lattice tower, procedural antenna units, photos rendered from the cloud.',
        'truth.json holds the azimuth, downtilt, centre altitude and size of every unit.',
        '',
      ].join('\n'),
    );
    for (const f of await readdir(root)) if (f.endsWith('.bak')) await rm(join(root, f));
    // no antenna list yet: Detect antennas makes it
    await rm(join(root, 'telecom', 'antennas.json'), { force: true });
    await removeEmptyDirs(root);

    const dest = join(out, TOWER_ID);
    await rm(dest, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    await cp(root, dest, { recursive: true });
    const bytes = await treeSize(dest);
    log(`${TOWER_ID}: ${(bytes / 1e6).toFixed(1)} MB`);
    if (bytes > TOWER_BUDGET_MB * 1e6)
      throw new Error(
        `${TOWER_ID} is ${(bytes / 1e6).toFixed(1)} MB, over its ${String(TOWER_BUDGET_MB)} MB budget.`,
      );
    return { id: TOWER_ID, root: dest, bytes, truth, points: pc.points, photos: items.length };
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
  await buildTowerDemo({
    out,
    quick,
    log,
    python: opt('python'),
    writeTruth: argv.includes('--write-truth'),
  });
  // list it in demo.json beside any other demo projects
  const infoFile = join(out, 'demo.json');
  let info = null;
  try {
    info = JSON.parse(await readFile(infoFile, 'utf8'));
  } catch {
    // no full demo here yet
  }
  const projects = [...new Set([...(info?.projects ?? []), TOWER_ID])];
  const build = await treeHash(out, (rel) => rel === 'demo.json');
  await writeFile(
    infoFile,
    json({
      schema: 'aio.demo/1',
      ...(info ?? {}),
      build,
      quick: Boolean(info?.quick) || quick,
      generator: info?.generator ?? 'partial',
      primary: info?.primary ?? TOWER_ID,
      projects,
      note: info?.note ?? 'Synthetic demo data made by tools/demo. No client data.',
    }),
  );
  log(`listed in ${relative(repo, infoFile) || infoFile}`);
  const check = spawnSync(
    process.execPath,
    [
      join(repo, 'tools', 'demo', 'check-no-client-data.mjs'),
      join(out, TOWER_ID),
      '--max-mb',
      String(TOWER_BUDGET_MB),
    ],
    { stdio: 'inherit' },
  );
  if (check.status !== 0) throw new Error('The Demo tower failed the client data check.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cli().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
