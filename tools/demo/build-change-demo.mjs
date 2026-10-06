#!/usr/bin/env node
/* eslint-disable no-console -- build script output */
// The change and modelling demo (M8, founder decision 6): a separate bundled synthetic project
// next to the two 0.7.0 demo projects, with its own size budget (BUDGET_MB). One small fictional
// site (change-scene.mjs) surveyed on two dates with known differences in every layer type, the
// inputs for the model builder (a DXF plot plan, the later point cloud as a scan) and the marker
// test detector, plus truth.json: every seeded change with counts and places, so each stream's
// tests can assert exact results.
//
//   node tools/demo/build-change-demo.mjs [--out apps/desktop/demo] [--seed 20261005] [--quick]
//
// build-demo.mjs calls buildChangeDemo() for the full demo set; run alone, this script adds (or
// replaces) <out>/demo-change-site/ and lists it in <out>/demo.json.
//
// Byte for byte reproducible: no clock, no temp path, no machine or tool version in any file; the
// video, clouds, grids and drawings are written by our own code (formats.mjs, h264.mjs, dxf.mjs).
// JPEG and WebP images go through sharp (the pinned libjpeg-turbo and libwebp builds).
// No ffmpeg and no pipeline Python needed. --quick renders smaller images (CI); the geometry, the
// counts and truth.json are the same.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  CONTROL,
  planRaster,
  plotPlan,
  plotPlanDxf,
  brokenDxf,
  unitlessDxf,
} from './change-drawing.mjs';
import {
  AREA,
  BOXES,
  CAPTURES,
  DEFECTS,
  DENT,
  LOCATION,
  MARKERS,
  MARKER_SIZE,
  PILE,
  PIPE,
  PIT,
  SHADOW,
  TANKS,
  TINT,
  VECTORS,
  applyTint,
  boxOn,
  changeWorld,
  defectMapping,
  streamOf,
  terrainHeight,
} from './change-scene.mjs';
import { encodePng, writeLas } from './formats.mjs';
import { writeGlb } from './glb.mjs';
import { encodeH264Pcm, muxMp4 } from './h264.mjs';
import { buildMarkerDetector } from './onnx-test-model.mjs';
import { lookAtQuat, projectPoint, rotate } from './render.mjs';
import { sandTextures, SUN } from './scene.mjs';
import { writePhoto, writePyramid } from './writers.mjs';

export const CHANGE_ID = 'demo-change-site';
/** Bundled size budget of the change demo (founder decision 6: about 25 MB or less). */
export const BUDGET_MB = 25;
const AUTHOR = 'Demo inspector';
const DSM_RES = 0.25;
const DSM_N = Math.round((AREA.x1 - AREA.x0) / DSM_RES);
const VIDEO = { fps: 2, seconds: 14 };

const repo = fileURLToPath(new URL('../..', import.meta.url));
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const r3 = (p) => p.map((v) => round(v));
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

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

// ------------------------------------------------------------------ point clouds

/** Points on the parts and the bare earth of one date, lit by the demo sun (photogrammetry look). */
function sampleCloud(world, date, seed) {
  const rnd = streamOf(seed, `cloud-${date}`);
  const dense = date === 'd2' ? 14 : 10; // the later flight was lower: denser
  const groundDense = date === 'd2' ? 3 : 2.5;
  const northKeep = date === 'd2' ? 0.7 : 0.3; // north faces are in shade and seen less
  const pos = [];
  const col = [];
  const cls = [];
  const jitter = () => (rnd() + rnd() + rnd() - 1.5) * 0.012;
  const light = (p, n, c) => {
    const ndl = Math.max(0, n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]);
    const lit =
      ndl > 0 ? world.renderer.lit(p[0] + n[0] * 0.3, p[1] + n[1] * 0.3, p[2] + n[2] * 0.3) : 0;
    const k = 0.3 * (0.5 + 0.5 * n[1]) + 0.12 + 0.78 * ndl * lit;
    return c.map((v) => Math.max(0, Math.min(255, Math.round(v * k * 255))));
  };
  for (const part of world.parts) {
    const { pos: P, nrm: Nn, col: C, idx } = part.arrays();
    const building = part.tag === 'B-01' || part.tag === 'S-01';
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const A = [P[3 * a], P[3 * a + 1], P[3 * a + 2]];
      const u = [0, 1, 2].map((k) => P[3 * b + k] - A[k]);
      const v = [0, 1, 2].map((k) => P[3 * c + k] - A[k]);
      const area =
        0.5 *
        Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      const fn = [Nn[3 * a], Nn[3 * a + 1], Nn[3 * a + 2]];
      if (fn[1] < -0.5) continue; // undersides are never seen from the air
      let count = area * dense * (fn[2] < -0.6 ? northKeep : 1);
      while (count > 0) {
        if (count < 1 && rnd() > count) break;
        count -= 1;
        let s = rnd();
        let r = rnd();
        if (s + r > 1) {
          s = 1 - s;
          r = 1 - r;
        }
        const w = 1 - s - r;
        const p = [0, 1, 2].map((k) => A[k] + u[k] * s + v[k] * r + jitter());
        const n = [0, 1, 2].map((k) => Nn[3 * a + k] * w + Nn[3 * b + k] * s + Nn[3 * c + k] * r);
        const cc = [0, 1, 2].map((k) => C[3 * a + k] * w + C[3 * b + k] * s + C[3 * c + k] * r);
        pos.push(...p);
        col.push(...light(p, n, cc));
        cls.push(building ? 6 : 1);
      }
    }
  }
  const covered = (x, z) =>
    TANKS.some((t) => Math.hypot(x - t.cx, z - t.cz) < t.R) ||
    BOXES.some((b0) => {
      const b = boxOn(b0, date);
      return b && Math.abs(x - b.c[0]) < b.size[0] / 2 && Math.abs(z - b.c[2]) < b.size[2] / 2;
    });
  const tmp = new Float32Array(3);
  const n = Math.round((AREA.x1 - AREA.x0) * (AREA.z1 - AREA.z0) * groundDense);
  for (let k = 0; k < n; k++) {
    const x = AREA.x0 + rnd() * (AREA.x1 - AREA.x0);
    const z = AREA.z0 + rnd() * (AREA.z1 - AREA.z0);
    if (covered(x, z)) continue;
    const y = terrainHeight(x, z, date);
    const e = 0.2;
    const nx = terrainHeight(x - e, z, date) - terrainHeight(x + e, z, date);
    const nz = terrainHeight(x, z - e, date) - terrainHeight(x, z + e, date);
    const l = Math.hypot(nx, 2 * e, nz);
    world.ground(x, z, 0.05, tmp);
    const p = [x, y + jitter(), z];
    pos.push(...p);
    col.push(...light(p, [nx / l, (2 * e) / l, nz / l], [tmp[0], tmp[1], tmp[2]]));
    cls.push(2);
  }
  return { pos: new Float64Array(pos), col: new Uint8Array(col), cls: new Uint8Array(cls) };
}

/** A png-packed cloud (packages/pointcloud/README.md) written with our own PNG encoder. */
async function writePngCloudExact(root, rel, pos, col, rnd) {
  const n = pos.length / 3;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const overview = Math.round(n * 0.25);
  const groups = [Array.from(order.subarray(0, overview))];
  const quads = [[], [], [], []];
  for (let k = overview; k < n; k++) {
    const i = order[k];
    quads[(pos[3 * i] >= 0 ? 1 : 0) + (pos[3 * i + 2] >= 0 ? 2 : 0)].push(i);
  }
  groups.push(...quads.filter((q) => q.length));
  const bounds = (ids) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const i of ids)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], pos[3 * i + a]);
        max[a] = Math.max(max[a], pos[3 * i + a]);
      }
    return { min: min.map((v) => round(v)), max: max.map((v) => round(v)) };
  };
  const chunks = [];
  await mkdir(join(root, rel), { recursive: true });
  for (let g = 0; g < groups.length; g++) {
    const ids = groups[g];
    const b = bounds(ids);
    const N = ids.length;
    const width = 1024;
    const height = Math.ceil(Math.ceil((9 * N) / 3) / width);
    const px = new Uint8Array(width * height * 3);
    for (let k = 0; k < N; k++) {
      const i = ids[k];
      for (let a = 0; a < 3; a++) {
        const span = b.max[a] - b.min[a] || 1;
        const q = Math.max(
          0,
          Math.min(65535, Math.round(((pos[3 * i + a] - b.min[a]) / span) * 65535)),
        );
        px[2 * a * N + k] = q & 0xff;
        px[(2 * a + 1) * N + k] = q >> 8;
      }
      px[6 * N + k] = col[3 * i];
      px[7 * N + k] = col[3 * i + 1];
      px[8 * N + k] = col[3 * i + 2];
    }
    const file = `${rel}/c${String(g).padStart(3, '0')}.png`;
    await writeFile(join(root, file), encodePng({ width, height, channels: 3, data: px }));
    chunks.push({ file, points: N, bounds: b, lod: g === 0 ? 0 : 1 });
  }
  await writeFile(
    join(root, rel, 'index.json'),
    json({ schema: 'aio.pngcloud/1', bounds: bounds(order), spacing: 0.25, chunks }),
  );
  return { index: `${rel}/index.json`, points: n };
}

// ------------------------------------------------------------------ rasters

/** Shaded relief of a height grid (local metres), as an RGB image of the same size. */
function relief(h, n, px) {
  const out = new Uint8Array(n * n * 3);
  const ramp = [
    [-2, [70, 60, 120]],
    [0, [64, 150, 120]],
    [2, [190, 200, 90]],
    [6, [226, 140, 60]],
    [12, [250, 250, 250]],
  ];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const v = h[j * n + i];
      const dx = (h[j * n + Math.min(n - 1, i + 1)] - h[j * n + Math.max(0, i - 1)]) / (2 * px);
      const dz = (h[Math.min(n - 1, j + 1) * n + i] - h[Math.max(0, j - 1) * n + i]) / (2 * px);
      const l = Math.hypot(dx, 1, dz);
      const shade = 0.55 + 0.45 * Math.max(0, (-dx * SUN[0] + SUN[1] - dz * SUN[2]) / l);
      let c = ramp[ramp.length - 1][1];
      if (v <= ramp[0][0]) c = ramp[0][1];
      else
        for (let k = 0; k + 1 < ramp.length; k++)
          if (v <= ramp[k + 1][0]) {
            const t = (v - ramp[k][0]) / (ramp[k + 1][0] - ramp[k][0]);
            c = ramp[k][1].map((a, q) => a + (ramp[k + 1][1][q] - a) * t);
            break;
          }
      for (let q = 0; q < 3; q++)
        out[(j * n + i) * 3 + q] = Math.round(Math.min(255, c[q] * shade));
    }
  return out;
}

/** Connected regions (4-neighbour) of a mask on an n x n grid. */
function components(mask, n) {
  const label = new Int32Array(n * n).fill(-1);
  const out = [];
  for (let s = 0; s < n * n; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const cells = [];
    const stack = [s];
    label[s] = out.length;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const i = c % n;
      const j = (c - i) / n;
      for (const [a, b] of [
        [i - 1, j],
        [i + 1, j],
        [i, j - 1],
        [i, j + 1],
      ]) {
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const k = b * n + a;
        if (mask[k] && label[k] < 0) {
          label[k] = out.length;
          stack.push(k);
        }
      }
    }
    out.push(cells);
  }
  return out;
}

// ------------------------------------------------------------------ cameras

const PHOTO_CAMS = [
  { id: 'p01', eye: [-40, 30, 46], target: [0, 0, 0], what: 'Overview from the south-west' },
  { id: 'p02', eye: [44, 28, -40], target: [0, 0, 0], what: 'Overview from the north-east' },
  { id: 'p03', eye: [2, 16, 46], target: [2, 0, 18], what: 'Containers and the shelter' },
  { id: 'p04', eye: [-14, 9, 6], target: [-10, 3, -15], what: 'South faces of T-201 and T-202' },
  { id: 'p05', eye: [17, 7, -6], target: [11.58, 2.5, -18.32], what: 'Tank T-203' },
  { id: 'p06', eye: [46, 14, 14], target: [30, 1.8, 6], what: 'Pump skid and the stockpile' },
];

function photoCams(date, seed) {
  const rnd = streamOf(seed, `photo-jitter-${date}`);
  return PHOTO_CAMS.map((c) => {
    if (date === 'd1') return c;
    return {
      ...c,
      eye: c.eye.map((v) => v + (rnd() - 0.5) * 1.0),
      target: c.target.map((v) => v + (rnd() - 0.5) * 0.6),
    };
  });
}

/** The flight of a date: an orbit at 10 Hz; the later flight is a little wider, lower, earlier. */
function flightPose(date) {
  const R = date === 'd2' ? 46.6 : 46;
  const alt = date === 'd2' ? 25.6 : 26;
  const phi0 = (date === 'd2' ? 0.06 : 0) + 2.4;
  return (tSec) => {
    const phi = phi0 + 0.16 * tSec;
    const eye = [R * Math.cos(phi), alt + 0.3 * Math.sin(tSec * 0.8), R * Math.sin(phi)];
    const target = [3 * Math.cos(phi + 1), 2, 3 * Math.sin(phi + 1)];
    return { pos: eye, q: lookAtQuat(eye, target) };
  };
}

const angleBetween = (qa, qb) => {
  const a = rotate(qa, [0, 0, -1]);
  const b = rotate(qb, [0, 0, -1]);
  return (
    (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI
  );
};

function occludedByTank(eye, p) {
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
    if (s > 0.02 && s < 0.98 && eye[1] + (p[1] - eye[1]) * s < t.H + t.rise) return true;
  }
  return false;
}

const boxOfPoints = (pts, w, h) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [
    Math.max(0, Math.floor(Math.min(...xs))),
    Math.max(0, Math.floor(Math.min(...ys))),
    Math.min(w, Math.ceil(Math.max(...xs))),
    Math.min(h, Math.ceil(Math.max(...ys))),
  ];
};

// ------------------------------------------------------------------ the build

/**
 * Build the change demo into `<out>/demo-change-site/` (replacing it). Returns the project folder,
 * truth.json's content and the size in bytes.
 */
export async function buildChangeDemo({ out, seed = 20261005, quick = false, log = undefined }) {
  log ??= () => undefined;
  const { schema, builder, geo } = await libs();
  const work = await mkdtemp(join(tmpdir(), 'stratlas-change-demo-'));
  try {
    const [E, N] = geo
      .fromWgs84([LOCATION.lon, LOCATION.lat, 0], LOCATION.epsg)
      .map((v) => Math.round(v));
    const H0 = LOCATION.h;
    const origin = [E, N, H0];
    const lonLat = (x, z) => {
      const ll = geo.toWgs84([E + x, N - z, 0], LOCATION.epsg);
      return [round(ll[0], 8), round(ll[1], 8)];
    };
    const ring = (pts) => [...pts.map(([x, z]) => lonLat(x, z)), lonLat(pts[0][0], pts[0][1])];
    const rect = (x0, z0, x1, z1) => [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ];

    const { root, manifest } = await builder.createProject(
      join(work, 'data'),
      {
        name: 'Demo change site',
        customer: 'Demo customer (fictional)',
        site: 'Fictional desert site, 2 survey dates (synthetic demo data)',
        type: 'fusion',
        epsg: LOCATION.epsg,
        origin,
        severityTemplate: builder.GENERAL_TEMPLATE.id,
      },
      builder.GENERAL_TEMPLATE,
    );
    if (manifest.id !== CHANGE_ID) throw new Error(`project id ${manifest.id}`);
    log(`origin E ${E} N ${N} (EPSG:${LOCATION.epsg})`);

    const sand = sandTextures(seed);
    const worlds = { d1: changeWorld(seed, 'd1', { sand }), d2: changeWorld(seed, 'd2', { sand }) };
    log('worlds built');

    const layers = [];
    const issues = [];
    const truth = {
      schema: 'aio.truth/1',
      project: CHANGE_ID,
      note: 'Every change seeded in this synthetic project, for tests. Local frame: metres, x east, y up, z south.',
      seed,
      captures: { from: 'd1', to: 'd2', list: CAPTURES },
      crs: { epsg: LOCATION.epsg },
      origin,
      layers: {},
      sources: {},
      changes: {},
    };
    const sizes = {
      ortho: quick ? 512 : 1024,
      // photos keep one size, so marker and issue boxes in truth.json are the same in --quick
      photo: [1024, 768],
      video: quick ? [256, 144] : [384, 216],
      ss: quick ? 1 : 2,
    };
    const corners = (y) => ({
      tl: [AREA.x0, y, AREA.z0],
      tr: [AREA.x1, y, AREA.z0],
      bl: [AREA.x0, y, AREA.z1],
    });
    const dsm = {};
    const photoRgb = {};
    const photoItems = {};
    const flights = {};

    for (const c of CAPTURES) {
      const d = c.id;
      const world = worlds[d];
      const L = (kind) => `${kind}-${d}`;
      truth.layers[d] = {};

      // model
      await writeFile(
        join(root, 'models', `${L('model')}.glb`),
        writeGlb(world.parts, { root: `DemoChangeSite_${d}`, generator: 'Stratlas demo builder' }),
      );
      layers.push({
        kind: 'mesh',
        id: L('model'),
        name: `Site model ${c.date}`,
        visible: d === 'd2',
        capture: d,
        src: { path: `models/${L('model')}.glb` },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        tags: world.parts.map((p) => ({ node: p.name, tag: p.tag, area: p.area })),
      });
      truth.layers[d].model = L('model');

      // ortho (tinted on the later date) and DSM
      const ortho = world.renderer.render(
        { ortho: { ...AREA }, width: sizes.ortho, height: sizes.ortho },
        { ss: sizes.ss },
      );
      applyTint(ortho.rgb, d);
      await writePyramid(
        root,
        `rasters/${L('ortho')}`,
        ortho.rgb,
        sizes.ortho,
        sizes.ortho,
        corners(0.02),
      );
      layers.push({
        kind: 'raster',
        id: L('ortho'),
        name: `Orthomosaic ${c.date}`,
        visible: d === 'd2',
        capture: d,
        src: { path: `rasters/${L('ortho')}/tiles.json` },
        role: 'ortho',
        format: 'kit-pyramid',
        corners: corners(0.02),
      });
      truth.layers[d].ortho = L('ortho');

      const grid = world.renderer.render(
        { ortho: { ...AREA }, width: DSM_N, height: DSM_N },
        { ss: 1, heights: true },
      ).heights;
      const clean = Float64Array.from(grid, (v) => (Number.isFinite(v) ? v : 0));
      dsm[d] = clean;
      const noise = streamOf(seed, `dsm-noise-${d}`);
      const elev = new Uint16Array(DSM_N * DSM_N);
      for (let i = 0; i < elev.length; i++)
        elev[i] = Math.max(
          1,
          Math.min(65535, Math.round((clean[i] + (noise() * 2 - 1) * 0.02 + 10) * 1000)),
        );
      await mkdir(join(root, 'sources'), { recursive: true });
      await writeFile(
        join(root, 'sources', `${L('dsm')}.png`),
        encodePng({ width: DSM_N, height: DSM_N, channels: 1, depth: 16, data: elev }),
      );
      await writeFile(
        join(root, 'sources', `${L('dsm')}.json`),
        json({
          schema: 'aio.grid/1',
          kind: 'dsm',
          layer: L('dsm'),
          capture: d,
          epsg: LOCATION.epsg,
          x0: E + AREA.x0,
          y1: N - AREA.z0,
          res: DSM_RES,
          width: DSM_N,
          height: DSM_N,
          file: `${L('dsm')}.png`,
          scale: 0.001,
          offset: H0 - 10,
          nodata: 0,
          note: 'Elevation H = offset + value * scale (metres, project CRS), north up, pixel is area. Noise of +-2 cm is added.',
        }),
      );
      truth.sources[L('dsm')] = `sources/${L('dsm')}.json`;
      const rel = relief(
        Float64Array.from({ length: 512 * 512 }, (_, k) => {
          const i = Math.min(DSM_N - 1, Math.floor(((k % 512) * DSM_N) / 512));
          const j = Math.min(DSM_N - 1, Math.floor((Math.floor(k / 512) * DSM_N) / 512));
          return clean[j * DSM_N + i];
        }),
        512,
        (AREA.x1 - AREA.x0) / 512,
      );
      await writePyramid(root, `rasters/${L('dsm')}`, rel, 512, 512, corners(0.03));
      layers.push({
        kind: 'raster',
        id: L('dsm'),
        name: `DSM ${c.date} (shaded relief)`,
        visible: false,
        capture: d,
        src: { path: `rasters/${L('dsm')}/tiles.json` },
        role: 'dsm',
        format: 'kit-pyramid',
        corners: corners(0.03),
      });
      truth.layers[d].dsm = L('dsm');
      log(`${d}: model, ortho, DSM`);

      // point cloud: png-packed for the viewer, LAS in the project CRS for the pipelines
      const cloud = sampleCloud(world, d, seed);
      const n = cloud.pos.length / 3;
      const pc = await writePngCloudExact(
        root,
        `clouds/${L('cloud')}`,
        cloud.pos,
        cloud.col,
        streamOf(seed, `cloud-order-${d}`),
      );
      const enh = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        enh[3 * i] = E + cloud.pos[3 * i];
        enh[3 * i + 1] = N - cloud.pos[3 * i + 2];
        enh[3 * i + 2] = H0 + cloud.pos[3 * i + 1];
      }
      await writeFile(
        join(root, 'sources', `${L('cloud')}.las`),
        writeLas({
          xyz: enh,
          rgb: cloud.col,
          classification: cloud.cls,
          epsg: LOCATION.epsg,
          date: c.date,
        }),
      );
      truth.sources[L('cloud')] = `sources/${L('cloud')}.las`;
      layers.push({
        kind: 'pointcloud',
        id: L('cloud'),
        name: `Point cloud ${c.date}`,
        visible: false,
        capture: d,
        src: { path: pc.index },
        format: 'png-packed',
        pointCount: pc.points,
      });
      truth.layers[d].cloud = L('cloud');
      truth.layers[d].cloudPoints = pc.points;
      log(`${d}: point cloud ${pc.points} points`);

      // photos
      const [PW, PH] = sizes.photo;
      const lens = { model: 'pinhole', hfovDeg: 60, aspect: round(PW / PH, 4) };
      photoItems[d] = [];
      photoRgb[d] = {};
      for (const [k, cam0] of photoCams(d, seed).entries()) {
        const q = lookAtQuat(cam0.eye, cam0.target);
        const cam = { pos: cam0.eye, q, hfovDeg: lens.hfovDeg, width: PW, height: PH };
        const { rgb } = world.renderer.render(cam, { ss: sizes.ss });
        applyTint(rgb, d);
        await writePhoto(root, `photos/${d}/${cam0.id}.jpg`, rgb, PW, PH);
        photoRgb[d][cam0.id] = { rgb, cam };
        photoItems[d].push({
          id: cam0.id,
          src: { path: `photos/${d}/${cam0.id}.jpg` },
          takenAt: `${c.date}T09:${String(40 + 2 * k).padStart(2, '0')}:00.000Z`,
          pos: r3(cam0.eye),
          q: q.map((v) => round(v, 6)),
          lens,
        });
      }
      layers.push({
        kind: 'photos',
        id: L('photos'),
        name: `Photos ${c.date}`,
        visible: true,
        capture: d,
        items: photoItems[d],
      });
      truth.layers[d].photos = L('photos');
      log(`${d}: ${photoItems[d].length} photos`);

      // video with its pose track
      const [VW, VH] = sizes.video;
      const vlens = { model: 'pinhole', hfovDeg: 70, aspect: round(VW / VH, 4) };
      const pose = flightPose(d);
      const startUtcMs = Date.parse(`${c.date}T09:20:00Z`);
      const samples = [];
      for (let t = 0; t <= VIDEO.seconds * 10; t++) {
        const p = pose(t / 10);
        samples.push({ t: t * 100, pos: r3(p.pos), q: p.q.map((v) => round(v, 6)) });
      }
      await mkdir(join(root, 'flights'), { recursive: true });
      await writeFile(
        join(root, 'flights', `${L('flight')}.json`),
        json({ schema: 'aio.flight/1', startUtcMs, lens: vlens, samples }),
      );
      const frames = [];
      const nFrames = VIDEO.seconds * VIDEO.fps + 1;
      flights[d] = [];
      for (let f = 0; f < nFrames; f++) {
        const t = f / VIDEO.fps;
        const p = pose(t);
        const { rgb } = world.renderer.render(
          { pos: p.pos, q: p.q, hfovDeg: vlens.hfovDeg, width: VW, height: VH },
          { ss: 1 },
        );
        frames.push(applyTint(rgb, d));
        flights[d].push({ t, pos: p.pos, q: p.q });
      }
      await mkdir(join(root, 'video'), { recursive: true });
      await writeFile(
        join(root, 'video', `${L('flight')}.mp4`),
        muxMp4(encodeH264Pcm(frames, VW, VH), { fps: VIDEO.fps }),
      );
      await mkdir(join(root, 'posters'), { recursive: true });
      await sharp(Buffer.from(frames[0]), { raw: { width: VW, height: VH, channels: 3 } })
        .jpeg({ quality: 84 })
        .toFile(join(root, 'posters', `${L('flight')}.jpg`));
      layers.push({
        kind: 'video',
        id: L('flight'),
        name: `Drone video ${c.date}`,
        visible: d === 'd2',
        capture: d,
        src: { path: `video/${L('flight')}.mp4` },
        flight: { src: { path: `flights/${L('flight')}.json` }, startUtcMs },
        lens: vlens,
        offsetMs: 0,
        poster: { path: `posters/${L('flight')}.jpg` },
      });
      truth.layers[d].video = L('flight');
      log(`${d}: video, ${nFrames} frames`);

      // map vectors
      const fc = {
        type: 'FeatureCollection',
        features: VECTORS[d].map((v) => ({
          type: 'Feature',
          id: v.id,
          properties: { id: v.id, ...v.props },
          geometry: v.ring
            ? { type: 'Polygon', coordinates: [ring(v.ring)] }
            : { type: 'LineString', coordinates: v.line.map(([x, z]) => lonLat(x, z)) },
        })),
      };
      await mkdir(join(root, 'vectors'), { recursive: true });
      await writeFile(join(root, 'vectors', `${L('site')}.geojson`), json(fc));
      layers.push({
        kind: 'vector',
        id: L('site'),
        name: `Site features ${c.date}`,
        visible: true,
        capture: d,
        src: { path: `vectors/${L('site')}.geojson` },
        format: 'geojson',
        style: {
          line: { color: '#d9822b', width: 2 },
          fill: { color: '#9aa5b1', opacity: 0.25 },
          label: { field: 'name' },
        },
      });
      truth.layers[d].vectors = L('site');
    }

    // ---------------------------------------------------------------- markers and detections
    truth.markers = {
      colour: [224, 32, 224],
      sizeM: MARKER_SIZE,
      world: MARKERS.map((m) => ({
        id: m.id,
        at: [m.x, 0, m.z],
        lonLat: lonLat(m.x, m.z),
        dates: m.dates,
      })),
      photos: {},
    };
    const passes = {};
    for (const c of CAPTURES) {
      const d = c.id;
      truth.markers.photos[`photos-${d}`] = {};
      const detections = [];
      for (const item of photoItems[d]) {
        const { rgb, cam } = photoRgb[d][item.id];
        const seen = [];
        for (const m of MARKERS.filter((x) => x.dates.includes(d))) {
          const h = MARKER_SIZE / 2;
          const pts = [
            [m.x - h, 0, m.z - h],
            [m.x + h, 0, m.z - h],
            [m.x + h, 0, m.z + h],
            [m.x - h, 0, m.z + h],
          ].map((p) => projectPoint(cam, p));
          const centre = projectPoint(cam, [m.x, 0, m.z]);
          if (!centre || pts.some((p) => !p)) continue;
          const inFrame = pts.map(
            (p) => p[0] >= 0 && p[1] >= 0 && p[0] < cam.width && p[1] < cam.height,
          );
          if (inFrame.some(Boolean) && !inFrame.every(Boolean))
            throw new Error(
              `marker ${m.id} is cut by the edge of photo ${d} ${item.id}: move it or the camera`,
            );
          const [cx, cy] = [Math.floor(centre[0]), Math.floor(centre[1])];
          if (cx < 2 || cy < 2 || cx >= cam.width - 2 || cy >= cam.height - 2) continue;
          const o = (cy * cam.width + cx) * 3;
          if (!(rgb[o] > 150 && rgb[o + 1] < 100 && rgb[o + 2] > 140)) continue;
          const bbox = boxOfPoints(pts, cam.width, cam.height);
          seen.push({ marker: m.id, bbox });
          detections.push({
            id: `${m.id}-${item.id}`,
            photo: item.id,
            class: 'marker',
            severity: 1,
            bbox,
            status: 'accepted',
            note: `Survey marker ${m.id}`,
          });
        }
        truth.markers.photos[`photos-${d}`][item.id] = seen;
      }
      passes[d] = {
        schema: 'aio.detections/1',
        source: 'human',
        producer: AUTHOR,
        createdAt: `${c.date}T12:00:00.000Z`,
        layer: `photos-${d}`,
        assessed: 'all',
        detections,
      };
      const r = schema.DetectionsFile.safeParse(passes[d]);
      if (!r.success) throw new Error(`detections ${d}: ${r.error.issues[0]?.message}`);
      await mkdir(join(root, 'detections'), { recursive: true });
      await writeFile(join(root, 'detections', `markers-${d}.json`), json(passes[d]));
    }
    const markerIds = (d) => new Set(passes[d].detections.map((x) => x.id.split('-')[0]));
    const m1 = markerIds('d1');
    const m2 = markerIds('d2');
    const detItems = [...new Set([...m1, ...m2])].sort().map((id) => ({
      marker: id,
      classId: 'marker',
      verdict: m1.has(id) && m2.has(id) ? 'unchanged' : m2.has(id) ? 'new' : 'resolved',
      count: {
        from: passes.d1.detections.filter((x) => x.id.startsWith(`${id}-`)).length,
        to: passes.d2.detections.filter((x) => x.id.startsWith(`${id}-`)).length,
      },
    }));
    truth.changes.detection = {
      passes: { d1: 'detections/markers-d1.json', d2: 'detections/markers-d2.json' },
      counts: { d1: passes.d1.detections.length, d2: passes.d2.detections.length },
      markers: { d1: m1.size, d2: m2.size },
      items: detItems,
      verdicts: tally(detItems),
    };
    for (const id of ['M1', 'M2', 'M3', 'M4'])
      if (!m1.has(id) && !m2.has(id)) throw new Error(`marker ${id} is in no photo`);

    // ---------------------------------------------------------------- issues
    const model = builder.GENERAL_TEMPLATE.model;
    for (const c of CAPTURES) {
      const d = c.id;
      for (const def of DEFECTS.filter((x) => x.date === d)) {
        const m = defectMapping(def);
        let centre = m.centre;
        if (def.part === 'ground') centre = [def.x, 0.01, def.z];
        if (def.dent) centre = centre.map((v, i) => v - m.normal[i] * DENT.depth);
        const r = Math.sqrt(def.area / Math.PI);
        const sightings = [
          {
            on: 'mesh',
            layer: `model-${d}`,
            geom: { type: 'spoint', p: r3(centre), n: r3(m.normal) },
          },
        ];
        let best = null;
        for (const item of photoItems[d]) {
          const { cam } = photoRgb[d][item.id];
          const eye = cam.pos;
          const view = [0, 1, 2].map((k) => eye[k] - centre[k]);
          if (view[0] * m.normal[0] + view[1] * m.normal[1] + view[2] * m.normal[2] <= 0) continue;
          if (occludedByTank(eye, centre)) continue;
          const pts = [];
          for (const a of [-1, 0, 1])
            for (const b of [-1, 0, 1]) pts.push(projectPoint(cam, m.at(a * r, b * r)));
          if (
            pts.some(
              (p) => !p || p[0] < 4 || p[1] < 4 || p[0] > cam.width - 4 || p[1] > cam.height - 4,
            )
          )
            continue;
          const bb = boxOfPoints(pts, cam.width, cam.height);
          const size = (bb[2] - bb[0]) * (bb[3] - bb[1]);
          if (!best || size > best.size) best = { item, bb, size };
        }
        if (best) {
          const [x0, y0, x1, y1] = best.bb;
          sightings.push({
            on: 'image',
            layer: `photos-${d}`,
            photo: best.item.id,
            geom: { type: 'box', x: x0 - 4, y: y0 - 4, w: x1 - x0 + 8, h: y1 - y0 + 8 },
          });
        }
        const at = `${c.date}T11:${String(issues.length).padStart(2, '0')}:00.000Z`;
        issues.push({
          id: `${d}-${def.code.toLowerCase()}`,
          code: def.code,
          classId: def.classId,
          severityModelId: model.id,
          severity: def.severity,
          status: 'reviewed',
          title: def.title,
          note: `Seen on ${c.label}.`,
          author: AUTHOR,
          createdAt: at,
          updatedAt: at,
          sightings,
          measurements: [{ kind: 'area', value: round(def.area, 2), unit: 'm2' }],
          source: 'human',
          capture: d,
        });
      }
    }
    const byTrack = (d, k) =>
      issues.find((i) => i.capture === d && DEFECTS.find((x) => x.code === i.code).track === k);
    const tracks = [...new Set(DEFECTS.map((x) => x.track))];
    const issueItems = tracks.map((k) => {
      const a = byTrack('d1', k);
      const b = byTrack('d2', k);
      const sa = a?.measurements[0].value;
      const sb = b?.measurements[0].value;
      const verdict = a && b ? (sb > sa * 1.2 ? 'grown' : 'unchanged') : b ? 'new' : 'resolved';
      return {
        track: k,
        verdict,
        from: a?.id,
        to: b?.id,
        classId: (a ?? b).classId,
        at: (b ?? a).sightings[0].geom.p,
        size: { from: sa, to: sb, unit: 'm2' },
        ...(verdict === 'resolved'
          ? { seenOnLater: issueSeenOn(a, photoItems.d2, photoRgb.d2) }
          : {}),
      };
    });
    truth.changes.issue = {
      items: issueItems,
      verdicts: tally(issueItems),
      counts: { d1: 5, d2: 5 },
    };

    // ---------------------------------------------------------------- model parts
    const partTags = (d) => worlds[d].parts.map((p) => p.tag);
    const comp = [...new Set([...partTags('d1'), ...partTags('d2')])].sort().map((tag) => {
      const inA = partTags('d1').includes(tag);
      const inB = partTags('d2').includes(tag);
      const b = BOXES.find((x) => x.tag === tag);
      if (inA && !inB)
        return { part: tag, verdict: 'removed', at: r3([b.c[0], b.size[1] / 2, b.c[2]]) };
      if (!inA && inB)
        return { part: tag, verdict: 'added', at: r3([b.c[0], b.size[1] / 2, b.c[2]]) };
      if (b?.moved)
        return { part: tag, verdict: 'moved', offsetM: b.moved, at: r3(boxOn(b, 'd2').c) };
      if (tag === DENT.tag) {
        const t = TANKS.find((x) => x.tag === tag);
        return {
          part: tag,
          verdict: 'changed',
          deviation: { maxM: DENT.depth, radiusM: DENT.radius },
          at: r3([t.cx + Math.cos(DENT.theta) * t.R, DENT.y, t.cz + Math.sin(DENT.theta) * t.R]),
        };
      }
      return { part: tag, verdict: 'unchanged' };
    });
    truth.changes.component = {
      layers: { from: 'model-d1', to: 'model-d2' },
      note: 'Painted defects differ by less than 2 cm off the surface: below the 5 cm threshold, so those parts are unchanged.',
      items: comp,
      verdicts: tally(comp),
    };

    // ---------------------------------------------------------------- surface (DSM of difference)
    const cell = DSM_RES * DSM_RES;
    const diff = Float64Array.from(dsm.d2, (v, i) => v - dsm.d1[i]);
    const mask = Uint8Array.from(diff, (v) => (Math.abs(v) >= 0.1 ? 1 : 0));
    const features = [
      {
        id: 'PL-01',
        what: 'Stockpile grew',
        b: [PILE.cx - PILE.d2.r, PILE.cz - PILE.d2.r, PILE.cx + PILE.d2.r, PILE.cz + PILE.d2.r],
      },
      { id: 'EX-01', what: 'New excavation', b: [PIT.x0, PIT.z0, PIT.x1, PIT.z1] },
      ...BOXES.flatMap((b0) => {
        const out = [];
        for (const [d, label] of [
          ['d1', 'old place'],
          ['d2', 'new place'],
        ]) {
          const b = boxOn(b0, d);
          const other = boxOn(b0, d === 'd1' ? 'd2' : 'd1');
          if (!b || (other && !b0.moved)) continue;
          const bounds = [
            b.c[0] - b.size[0] / 2,
            b.c[2] - b.size[2] / 2,
            b.c[0] + b.size[0] / 2,
            b.c[2] + b.size[2] / 2,
          ];
          const what = b0.moved
            ? `${b0.name} moved (${label})`
            : d === 'd1'
              ? `${b0.name} removed`
              : `${b0.name} added`;
          out.push({ id: b0.moved ? `${b0.tag} ${label}` : b0.tag, what, b: bounds });
        }
        return out;
      }),
    ];
    const regions = [];
    for (const cells of components(mask, DSM_N)) {
      if (cells.length * cell < 1) continue;
      let fill = 0;
      let cut = 0;
      let sx = 0;
      let sz = 0;
      const lo = [Infinity, Infinity];
      const hi = [-Infinity, -Infinity];
      for (const k of cells) {
        const v = diff[k];
        if (v > 0) fill += v * cell;
        else cut -= v * cell;
        const x = AREA.x0 + ((k % DSM_N) + 0.5) * DSM_RES;
        const z = AREA.z0 + (Math.floor(k / DSM_N) + 0.5) * DSM_RES;
        sx += x;
        sz += z;
        lo[0] = Math.min(lo[0], x - DSM_RES / 2);
        lo[1] = Math.min(lo[1], z - DSM_RES / 2);
        hi[0] = Math.max(hi[0], x + DSM_RES / 2);
        hi[1] = Math.max(hi[1], z + DSM_RES / 2);
      }
      const cx = sx / cells.length;
      const cz = sz / cells.length;
      const f = features.find(
        (g) => cx >= g.b[0] - 0.5 && cx <= g.b[2] + 0.5 && cz >= g.b[1] - 0.5 && cz <= g.b[3] + 0.5,
      );
      regions.push({
        id: f?.id ?? 'unknown',
        what: f?.what ?? 'unexpected',
        verdict: fill >= cut ? 'fill' : 'cut',
        areaM2: round(cells.length * cell, 2),
        volume: { cutM3: round(cut, 2), fillM3: round(fill, 2), netM3: round(fill - cut, 2) },
        at: [round(cx, 2), 0, round(cz, 2)],
        bounds: {
          min: [round(lo[0], 2), 0, round(lo[1], 2)],
          max: [round(hi[0], 2), 0, round(hi[1], 2)],
        },
        outline: ring(rect(lo[0], lo[1], hi[0], hi[1])),
      });
    }
    regions.sort((a, b) => a.id.localeCompare(b.id));
    const sum = (k) =>
      round(
        regions.reduce((s, r) => s + r.volume[k], 0),
        2,
      );
    truth.changes.surface = {
      inputs: {
        from: 'dsm-d1',
        to: 'dsm-d2',
        grids: ['sources/dsm-d1.json', 'sources/dsm-d2.json'],
      },
      thresholds: { minDepthM: 0.1, minAreaM2: 1 },
      noiseM: 0.02,
      note: 'Volumes from the noise-free surfaces on the 0.25 m grid, inside each region (cells changed by 10 cm or more). Expect a few per cent from the noise.',
      regions,
      totals: { cutM3: sum('cutM3'), fillM3: sum('fillM3'), netM3: sum('netM3') },
      verdicts: tally(regions),
    };
    if (regions.some((r) => r.id === 'unknown'))
      throw new Error('surface change outside the seeded features');

    // ---------------------------------------------------------------- clouds and orthos
    const boxRegion = (b, verdict, extra = {}) => ({
      id: b.tag,
      verdict,
      bounds: {
        min: r3([b.c[0] - b.size[0] / 2, 0, b.c[2] - b.size[2] / 2]),
        max: r3([b.c[0] + b.size[0] / 2, b.size[1], b.c[2] + b.size[2] / 2]),
      },
      ...extra,
    });
    const S01 = boxOn(
      BOXES.find((b) => b.tag === 'S-01'),
      'd2',
    );
    const C01 = boxOn(
      BOXES.find((b) => b.tag === 'C-01'),
      'd1',
    );
    const SKa = boxOn(
      BOXES.find((b) => b.tag === 'SK-01'),
      'd1',
    );
    const SKb = boxOn(
      BOXES.find((b) => b.tag === 'SK-01'),
      'd2',
    );
    const T202 = TANKS.find((t) => t.tag === DENT.tag);
    const dentAt = [
      T202.cx + Math.cos(DENT.theta) * T202.R,
      DENT.y,
      T202.cz + Math.sin(DENT.theta) * T202.R,
    ];
    const cloudRegions = [
      boxRegion(S01, 'added', { distance: { maxM: S01.size[1] } }),
      boxRegion(C01, 'removed', { distance: { maxM: C01.size[1] } }),
      {
        ...boxRegion(SKa, 'changed', { distance: { maxM: SKa.size[1] } }),
        id: 'SK-01 old place',
        part: 'SK-01',
        moved: SKb.moved,
      },
      {
        ...boxRegion(SKb, 'changed', { distance: { maxM: SKb.size[1] } }),
        id: 'SK-01 new place',
        part: 'SK-01',
        moved: SKb.moved,
      },
      {
        id: 'PL-01',
        verdict: 'changed',
        at: [PILE.cx, 0, PILE.cz],
        distance: { maxM: round(PILE.d2.h - PILE.d1.h, 2) },
      },
      {
        id: 'EX-01',
        verdict: 'changed',
        bounds: { min: [PIT.x0, -PIT.depth, PIT.z0], max: [PIT.x1, 0, PIT.z1] },
        distance: { maxM: PIT.depth },
      },
      {
        id: 'T-202 dent',
        verdict: 'changed',
        at: r3(dentAt),
        distance: { maxM: DENT.depth },
        radiusM: DENT.radius,
      },
    ];
    truth.changes.cloud = {
      layers: { from: 'cloud-d1', to: 'cloud-d2' },
      sources: ['sources/cloud-d1.las', 'sources/cloud-d2.las'],
      noiseM: 0.01,
      registration: { shiftM: 0 },
      note: 'Both clouds share the frame exactly. The later cloud is denser and sees more of the north faces; neither counts as change.',
      regions: cloudRegions,
      counts: { regions: cloudRegions.length, moved: 1, added: 1, removed: 1 },
    };
    const markerRect = (m) => {
      const h = MARKER_SIZE / 2;
      return { id: m.id, outlineLocal: rect(m.x - h, m.z - h, m.x + h, m.z + h), small: true };
    };
    const boxRect = (b) =>
      rect(
        b.c[0] - b.size[0] / 2,
        b.c[2] - b.size[2] / 2,
        b.c[0] + b.size[0] / 2,
        b.c[2] + b.size[2] / 2,
      );
    const tr2 = VECTORS.d2.find((v) => v.id === 'TR-02').line;
    const rasterExpected = [
      { id: 'S-01', verdict: 'added', outlineLocal: boxRect(S01) },
      { id: 'C-01', verdict: 'removed', outlineLocal: boxRect(C01) },
      {
        id: 'SK-01',
        verdict: 'changed',
        outlineLocal: rect(SKa.c[0] - 2, SKb.c[2] - 1.5, SKb.c[0] + 2, SKa.c[2] + 1.5),
      },
      {
        id: 'PL-01',
        verdict: 'changed',
        outlineLocal: rect(
          PILE.cx - PILE.d2.r,
          PILE.cz - PILE.d2.r,
          PILE.cx + PILE.d2.r,
          PILE.cz + PILE.d2.r,
        ),
      },
      { id: 'EX-01', verdict: 'added', outlineLocal: rect(PIT.x0, PIT.z0, PIT.x1, PIT.z1) },
      {
        id: 'TR-02',
        verdict: 'added',
        outlineLocal: rect(
          Math.min(tr2[0][0], tr2[1][0]) - 2,
          Math.min(tr2[0][1], tr2[1][1]),
          Math.max(tr2[0][0], tr2[1][0]) + 2,
          Math.max(tr2[0][1], tr2[1][1]),
        ),
      },
      { ...markerRect(MARKERS.find((m) => m.id === 'M2')), verdict: 'removed' },
      { ...markerRect(MARKERS.find((m) => m.id === 'M4')), verdict: 'added' },
    ].map((r) => ({ ...r, outline: ring(r.outlineLocal) }));
    const shadowRing = Array.from({ length: 24 }, (_, k) => {
      const t = (k / 24) * 2 * Math.PI;
      return [
        round(SHADOW.cx + SHADOW.rx * Math.cos(t), 2),
        round(SHADOW.cz + SHADOW.rz * Math.sin(t), 2),
      ];
    });
    truth.changes.raster = {
      layers: { from: 'ortho-d1', to: 'ortho-d2' },
      registration: { shiftPx: 0 },
      expected: rasterExpected,
      clean: [
        {
          id: 'cloud-shadow',
          why: 'lighting only (a cloud shadow on the later date)',
          outlineLocal: shadowRing,
          outline: ring(shadowRing),
        },
      ],
      tint: { why: 'the whole later ortho is a little warmer (sun and season)', rgbFactor: TINT },
      counts: {
        expected: rasterExpected.length,
        large: rasterExpected.filter((r) => !r.small).length,
        clean: 1,
      },
    };

    // ---------------------------------------------------------------- vectors
    const vecItems = [];
    const ids = [...new Set([...VECTORS.d1, ...VECTORS.d2].map((v) => v.id))].sort();
    for (const id of ids) {
      const a = VECTORS.d1.find((v) => v.id === id);
      const b = VECTORS.d2.find((v) => v.id === id);
      if (!a) vecItems.push({ feature: id, verdict: 'added' });
      else if (!b) vecItems.push({ feature: id, verdict: 'removed' });
      else if (JSON.stringify(a.line ?? a.ring) !== JSON.stringify(b.line ?? b.ring)) {
        const before = a.line ?? a.ring;
        const moved = Math.max(
          ...(b.line ?? b.ring).map(([x, z]) =>
            Math.min(...before.slice(1).map((q, k) => segDist2(x, z, before[k], q))),
          ),
        );
        vecItems.push({ feature: id, verdict: 'reshaped', maxOffsetM: round(moved, 2) });
      } else {
        const keys = Object.keys({ ...a.props, ...b.props }).filter(
          (k) => a.props[k] !== b.props[k],
        );
        vecItems.push(
          keys.length
            ? { feature: id, verdict: 'attributes', keys }
            : { feature: id, verdict: 'unchanged' },
        );
      }
    }
    truth.changes.vector = {
      layers: { from: 'site-d1', to: 'site-d2' },
      items: vecItems,
      verdicts: tally(vecItems),
    };

    // ---------------------------------------------------------------- frame pairs
    const pairs = flights.d1.map((a) => {
      let best = null;
      for (const b of flights.d2) {
        const poseM = Math.hypot(...a.pos.map((v, i) => v - b.pos[i]));
        const angleDeg = angleBetween(a.q, b.q);
        const cost = poseM + 0.2 * angleDeg;
        if (!best || cost < best.cost) best = { b, poseM, angleDeg, cost };
      }
      return {
        a: { layer: 'flight-d1', t: a.t },
        b: { layer: 'flight-d2', t: best.b.t },
        poseM: round(best.poseM, 2),
        angleDeg: round(best.angleDeg, 2),
      };
    });
    const photoPairs = PHOTO_CAMS.map((p) => {
      const a = photoItems.d1.find((x) => x.id === p.id);
      const b = photoItems.d2.find((x) => x.id === p.id);
      return {
        a: { layer: 'photos-d1', photo: p.id },
        b: { layer: 'photos-d2', photo: p.id },
        poseM: round(Math.hypot(...a.pos.map((v, i) => v - b.pos[i])), 2),
        angleDeg: round(angleBetween(a.q, b.q), 2),
      };
    });
    truth.changes.frame = {
      video: { fps: VIDEO.fps, frames: flights.d1.length, pairs },
      photos: { pairs: photoPairs },
      cost: 'best pair: smallest camera distance (m) + 0.2 x view angle (degrees)',
    };
    log('truth: changes');

    // ---------------------------------------------------------------- drawings, scan, detector
    await writeFile(join(root, 'sources', 'plot-plan.dxf'), plotPlanDxf());
    await writeFile(join(root, 'sources', 'plot-plan-unitless.dxf'), unitlessDxf());
    await writeFile(join(root, 'sources', 'plot-plan-broken.dxf'), brokenDxf());
    const plan = planRaster();
    await writeFile(join(root, 'rasters', 'plot-plan.png'), plan.png);
    const planCorners = {
      tl: [AREA.x0, 0.04, AREA.z0],
      tr: [AREA.x1, 0.04, AREA.z0],
      bl: [AREA.x0, 0.04, AREA.z1],
    };
    layers.push({
      kind: 'raster',
      id: 'plan',
      name: 'Plot plan',
      visible: false,
      src: { path: 'rasters/plot-plan.png' },
      role: 'plan',
      format: 'image',
      corners: planCorners,
    });
    const pp = plotPlan();
    const kinds = (type) => pp.entities.filter((e) => e.type === type).length;
    const scanParts = [
      ...TANKS.map((t) => ({
        kind: 'cylinder',
        tag: t.tag,
        base: [t.cx, 0, t.cz],
        radius: t.R,
        height: t.H,
      })),
      ...BOXES.map((b0) => boxOn(b0, 'd2'))
        .filter(Boolean)
        .map((b) =>
          b.kind === 'building'
            ? { kind: 'extrusion', tag: b.tag, footprint: boxRect(b), baseY: 0, height: b.size[1] }
            : {
                kind: 'box',
                tag: b.tag,
                centre: r3([b.c[0], b.size[1] / 2, b.c[2]]),
                size: b.size,
                rotY: 0,
              },
        ),
      { kind: 'pipe', tag: PIPE.tag, from: PIPE.a, to: PIPE.b, radius: PIPE.r },
    ];
    truth.modelling = {
      drawing: {
        file: 'sources/plot-plan.dxf',
        units: 'm',
        unitless: { file: 'sources/plot-plan-unitless.dxf', units: 'mm' },
        broken: { file: 'sources/plot-plan-broken.dxf' },
        grid: 'drawing X = 1000 + x, drawing Y = 2000 - z (metres)',
        control: CONTROL.map((c) => ({
          id: c.id,
          drawing: c.drawing,
          local: c.local,
          lonLat: lonLat(c.local[0], c.local[2]),
        })),
        entities: {
          CIRCLE: kinds('CIRCLE'),
          POLYLINE: kinds('POLYLINE'),
          LINE: kinds('LINE'),
          INSERT: kinds('INSERT'),
          POINT: kinds('POINT'),
          TEXT: kinds('TEXT'),
        },
        blocks: Object.keys(pp.blocks),
        parts: pp.parts,
        raster: {
          file: 'rasters/plot-plan.png',
          layer: 'plan',
          width: plan.width,
          height: plan.height,
          pxM: plan.px,
          topLeftDrawing: plan.origin,
        },
      },
      scan: {
        layer: 'cloud-d2',
        file: 'sources/cloud-d2.las',
        noiseM: 0.01,
        note: 'The later point cloud is the modelling scan: tanks, boxes, buildings and a pipe run, with ground, noise and shaded north faces.',
        parts: scanParts,
        counts: { cylinder: 3, box: 3, extrusion: 1, pipe: 1 },
      },
    };
    const det = buildMarkerDetector();
    await mkdir(join(root, 'sources', 'marker-detector'), { recursive: true });
    await writeFile(join(root, 'sources', 'marker-detector', 'model.onnx'), det.onnx);
    await writeFile(join(root, 'sources', 'marker-detector', 'model.json'), json(det.card));
    truth.detector = {
      model: 'sources/marker-detector/model.onnx',
      card: 'sources/marker-detector/model.json',
      sha256: det.card.sha256,
      classes: det.card.classes,
      input: '640 x 640, the photo scaled to fit (letterbox), RGB / 255',
      expected:
        'one detection per marker box of markers.photos (photo pixels): its centre inside the box, and the box inside the marker box widened by 3 px',
    };
    await writeFile(
      join(root, 'sources', 'README.txt'),
      [
        'Sources of the demo change site (synthetic, made by tools/demo/build-change-demo.mjs).',
        '',
        'cloud-d1.las, cloud-d2.las    point clouds of each date, LAS 1.2 in the project CRS (EPSG:32631).',
        '                              Make COPC layers from them with the point cloud pipeline.',
        'dsm-d1.png, dsm-d2.png        16-bit elevation grids; the .json beside each says how to read them.',
        'plot-plan.dxf                 the plot plan in metres, with four control points (CP1 to CP4).',
        'plot-plan-unitless.dxf        the same plan in millimetres with no units in the file.',
        'plot-plan-broken.dxf          a plan cut short, for the error message.',
        'marker-detector/              a test detector for the magenta survey markers, with its model card (MIT).',
        '',
        'truth.json at the project root lists every change between the two dates.',
        '',
      ].join('\n'),
    );

    // ---------------------------------------------------------------- poster, manifest, issues
    {
      const eye = [-46, 34, 42];
      const [TW, TH] = quick ? [640, 360] : [1280, 720];
      const { rgb } = worlds.d2.renderer.render(
        { pos: eye, q: lookAtQuat(eye, [4, 0, -4]), hfovDeg: 66, width: TW, height: TH },
        { ss: sizes.ss },
      );
      await sharp(Buffer.from(applyTint(rgb, 'd2')), {
        raw: { width: TW, height: TH, channels: 3 },
      })
        .jpeg({ quality: 84 })
        .toFile(join(root, 'thumbnail.jpg'));
    }
    const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    m.name = 'Demo change site (2 dates)';
    m.captures = CAPTURES;
    m.layers = layers;
    m.classCatalogues[0].classes.push({
      id: 'marker',
      label: 'Survey marker',
      color: '#e020e0',
      severityModel: model.id,
    });
    const parsed = schema.parseManifest(m);
    if (!parsed.ok) throw new Error(`manifest: ${parsed.error}`);
    await writeFile(join(root, 'manifest.json'), json(m));
    for (const is of issues) {
      const r = schema.Issue.safeParse(is);
      if (!r.success) throw new Error(`issue ${is.code}: ${r.error.issues[0]?.message}`);
      const v = schema.validateIssueAgainstModel(r.data, model);
      if (!v.ok) throw new Error(v.error);
    }
    await writeFile(join(root, 'issues.json'), json({ schema: 'aio.issues/1', issues }));
    truth.counts = {
      layers: layers.length,
      layersPerDate: Object.fromEntries(
        CAPTURES.map((c) => [c.id, layers.filter((l) => l.capture === c.id).length]),
      ),
      issues: {
        d1: issues.filter((i) => i.capture === 'd1').length,
        d2: issues.filter((i) => i.capture === 'd2').length,
      },
      photos: { d1: photoItems.d1.length, d2: photoItems.d2.length },
      videoFrames: flights.d1.length,
    };
    await writeFile(join(root, 'truth.json'), json(truth));

    // empty folders the wizard made and nothing filled stay out of the bundle
    for (const dir of ['panoramas', 'report'])
      await rm(join(root, dir), { recursive: true, force: true });
    for (const f of await readdir(root)) if (f.endsWith('.bak')) await rm(join(root, f));

    const dest = join(out, CHANGE_ID);
    await rm(dest, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    await cp(root, dest, { recursive: true });
    const bytes = await treeSize(dest);
    log(`change demo written: ${(bytes / 1e6).toFixed(1)} MB`);
    if (bytes > BUDGET_MB * 1e6)
      throw new Error(
        `The change demo is ${(bytes / 1e6).toFixed(1)} MB, over its ${BUDGET_MB} MB budget.`,
      );
    return { root: dest, truth, bytes };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Was the issue's place in view of a photo of the later date (so "resolved", not "not seen")? */
function issueSeenOn(issue, items, rgbs) {
  const p = issue.sightings[0].geom.p;
  const n = issue.sightings[0].geom.n;
  for (const item of items) {
    const { cam } = rgbs[item.id];
    const view = [0, 1, 2].map((k) => cam.pos[k] - p[k]);
    if (view[0] * n[0] + view[1] * n[1] + view[2] * n[2] <= 0) continue;
    const s = projectPoint(cam, p);
    if (
      s &&
      s[0] > 0 &&
      s[1] > 0 &&
      s[0] < cam.width &&
      s[1] < cam.height &&
      !occludedByTank(cam.pos, p)
    )
      return { layer: 'photos-d2', photo: item.id };
  }
  return null;
}

/** Distance from (x, z) to the segment a-b. */
function segDist2(x, z, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}

/** Counts per verdict. */
function tally(items) {
  const out = {};
  for (const i of items) out[i.verdict] = (out[i.verdict] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
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

/** SHA-256 over every file's relative path and bytes (the demo build stamp). */
export async function treeHash(dir, skip = () => false) {
  const h = createHash('sha256');
  for (const f of await treeFiles(dir)) {
    const rel = relative(dir, f).replace(/\\/g, '/');
    if (skip(rel)) continue;
    h.update(rel);
    h.update(await readFile(f));
  }
  return h.digest('hex');
}

export async function treeSize(dir) {
  let n = 0;
  for (const f of await treeFiles(dir)) n += (await stat(f)).size;
  return n;
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
  const r = await buildChangeDemo({ out, seed: Number(opt('seed', '20261005')), quick, log });
  // list it in demo.json beside any other demo projects
  const infoFile = join(out, 'demo.json');
  let info = null;
  try {
    info = JSON.parse(await readFile(infoFile, 'utf8'));
  } catch {
    // no full demo here yet
  }
  const projects = [...new Set([...(info?.projects ?? []), CHANGE_ID])];
  const build = await treeHash(out, (rel) => rel === 'demo.json');
  await writeFile(
    infoFile,
    json({
      schema: 'aio.demo/1',
      ...(info ?? {}),
      build,
      quick: Boolean(info?.quick) || quick,
      // a demo folder this script made alone is not a full build: the release rebuilds it
      generator: info?.generator ?? 'partial',
      primary: info?.primary ?? CHANGE_ID,
      projects,
      note: info?.note ?? 'Synthetic demo data made by tools/demo. No client data.',
    }),
  );
  log(`listed in ${relative(repo, infoFile) || infoFile}`);
  const check = spawnSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'check-change-demo.mjs'), r.root],
    { stdio: 'inherit' },
  );
  if (check.status !== 0) throw new Error('The change demo failed its checks.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cli().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
