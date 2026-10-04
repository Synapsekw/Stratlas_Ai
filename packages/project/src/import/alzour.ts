import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import type {
  Layer,
  LensModel,
  PanoRef,
  PhotoRef,
  ProjectManifestInput,
  Quat,
  Vec3,
} from '@aio/schema';
import {
  ALZOUR_HFOV_DEG,
  calibratedHfovDeg,
  groundHit,
  inParallelogram,
  localToPlant,
  mergeFlightClips,
  projectToImage,
  quatAngleDeg,
  type FlightClip,
} from './alzour-check';
import {
  ALZOUR_GROUPS,
  PLANT_CATALOGUE,
  PLANT_SEVERITY_MODEL,
  parseRegister,
  registerTags,
  type RegisterRow,
} from './alzour-model';
import { fitSimilarity2D, applySimilarity2D, type Similarity2D } from './fit';
import { AioFlight, poseAt } from './flight';
import { invertFrame, mapPoint, mapQuat, meshTransform, type FrameMap } from './frames';
import type { ImportOptions, ImportResult } from './hcl';
import { imageSize } from './image';
import { quatNormalize, round, roundVec, sub } from './math';
import { CHROMIUM_CODECS, extractFrame, probeVideo, transcodeH264, type VideoInfo } from './media';
import { ISSUES_SCHEMA, validatePackage } from './package';
import {
  djiLocalToUtcMs,
  plantCameraQuat,
  plantFrame,
  plantToScene,
  plantVideoToFlight,
} from './plant';
import { convertPngChunk } from './pngcloud';
import { composeImage, writeLineArtPng } from './rasterops';
import { ImportReport, formatBytes } from './report';
import {
  applyPixelAffine,
  fitPixelAffine,
  fitTileGrid,
  gridCorners,
  gridPoint,
  invertPixelAffine,
  placementError,
  tileIndexOf,
  type Corners,
  type PixelAffine,
} from './tiles';
import { PackageWriter } from './writer';

// Source formats (the plant twin artifact) ----------------------------------------------------------

const Corner = z.tuple([z.number(), z.number()]);
const SrcTile = z.object({ f: z.string(), c: z.array(Corner).length(4) });
const LayersJson = z.object({
  ortho: z.object({ L: z.array(SrcTile), H: z.array(SrcTile) }),
  plan: z.array(SrcTile),
  urls: z.record(z.string(), z.string()),
});
const PcChunk = z.object({
  f: z.string(),
  n: z.number().int().nonnegative(),
  o: z.tuple([z.number(), z.number(), z.number()]),
  q: z.number().positive(),
  b: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});
const PcJson = z.object({
  note: z.string().optional(),
  levels: z.array(z.array(PcChunk)),
  urls: z.record(z.string(), z.string()).default({}),
});
const FlightsJson = z.object({
  camera: z.object({ hfov_deg: z.number(), aspect: z.number() }).loose(),
  videos: z.record(
    z.string(),
    z.object({
      flight: z.number().int(),
      created: z.string(),
      dur: z.number(),
      hz: z.number().positive(),
      track: z.array(z.array(z.number())),
    }),
  ),
});
const Still = z.object({
  id: z.string(),
  t: z.string(),
  E: z.number(),
  N: z.number(),
  EL: z.number(),
  az: z.number(),
  pitch: z.number(),
  roll: z.number().default(0),
  hfov: z.number(),
  img: z.string(),
  th: z.string(),
});
const Pano = z.object({
  id: z.string(),
  kind: z.enum(['sphere', 'wide']),
  t: z.string(),
  E: z.number(),
  N: z.number(),
  EL: z.number(),
  yaw: z.number(),
  img: z.string(),
  th: z.string(),
  hspan: z.number().optional(),
  vtop: z.number().optional(),
  vbot: z.number().optional(),
});
const MediaJson = z.object({ stills: z.array(Still), panos: z.array(Pano) });
const MapTiles = z.object({
  attr: z.string().optional(),
  tiles: z.array(
    z.object({
      img: z.string(),
      z: z.number().int(),
      n: z.number().int().positive(),
      pos: z.array(z.number()),
      uv: z.array(z.number()),
    }),
  ),
});

// Constants -----------------------------------------------------------------------------------------

/** Survey day (DJI clocks are local, Kuwait UTC+3). */
const SURVEY_DATE = '2023-02-21';
/**
 * Ortho drape height above plant grade. The viewer drew it at 0.30 m and hid the model's flat
 * ground (paving, roads, laydown: tops up to 0.45 m) under it; the importer keeps the model whole
 * and lifts the ortho just above that ground instead.
 */
const ORTHO_Y = 0.5;
/** Plot plans lie just above the ortho so their line art overlays it. */
const PLOTPLAN_Y = 0.62;
/** Colour under the ortho's no-data pixels: close to the app's water at the default view. */
const ORTHO_NODATA_RGB = '#03383b';
const AREAPLAN_Y = 0.6;
const STREET_Y = -0.5;
/** Plot plan line colour of the viewer (material colour 0xd10f0f times the white line art). */
const PLAN_RGB = [209, 15, 15] as const;
const STILL_ASPECT = 16 / 9;
const THUMB_TIME_S = 20;

// Helpers -------------------------------------------------------------------------------------------

/** Decode `model_glb_zip.b64.txt`: base64 of a zip with one (deflated) GLB entry. */
export function decodeModelZip(b64: string): { name: string; glb: Uint8Array } {
  const zip = Buffer.from(b64.trim(), 'base64');
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error('Model zip: bad local file header');
  const method = zip.readUInt16LE(8);
  const csize = zip.readUInt32LE(18);
  const usize = zip.readUInt32LE(22);
  const nlen = zip.readUInt16LE(26);
  const xlen = zip.readUInt16LE(28);
  const name = zip.subarray(30, 30 + nlen).toString('utf8');
  const data = zip.subarray(30 + nlen + xlen, 30 + nlen + xlen + csize);
  const glb = method === 0 ? data : inflateRawSync(data);
  if (glb.length !== usize)
    throw new Error(`Model zip: ${name} is ${glb.length} bytes, expected ${usize}`);
  return { name, glb: new Uint8Array(glb) };
}

interface GltfNode {
  name?: string;
  extras?: Record<string, unknown>;
}

/** The JSON chunk of a GLB. */
export function glbJson(glb: Uint8Array): { nodes?: GltfNode[]; asset?: { generator?: string } } {
  const b = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB file');
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as { nodes?: GltfNode[] };
}

/** Plant grid to UTM-39 point pairs from the GLB node extras. */
export function utmPairs(
  nodes: readonly GltfNode[],
): { src: [number, number]; dst: [number, number] }[] {
  const out: { src: [number, number]; dst: [number, number] }[] = [];
  for (const n of nodes) {
    const x = n.extras ?? {};
    const [e, nn, ue, un] = [x.plant_E, x.plant_N, x.utm39_E, x.utm39_N];
    if (
      typeof e === 'number' &&
      typeof nn === 'number' &&
      typeof ue === 'number' &&
      typeof un === 'number'
    ) {
      out.push({ src: [e, nn], dst: [ue, un] });
    }
  }
  return out;
}

const localIso = (date: string, hms: string) =>
  new Date(djiLocalToUtcMs(`${date}T${hms}Z`)).toISOString();

const hhmm = (created: string) => created.slice(11, 16);

/** Source tile file: the asset-store blob the viewer used for it, else the published path. */
function blobResolver(src: string) {
  const dir = join(src, '_blob');
  const byId = new Map<string, string>();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) byId.set(f.replace(/\.[^.]+$/, ''), join(dir, f));
  }
  return (path: string, urls: Readonly<Record<string, string>>): string => {
    const u = urls[path];
    const id = u?.replace(/^.*\/_blob\//, '');
    const hit = id ? byId.get(id) : undefined;
    if (hit) return hit;
    if (existsSync(join(src, path))) return join(src, path);
    throw new Error(`Source file for ${path} not found (blob ${id ?? 'none'})`);
  };
}

const roundCorners = (c: Corners): Corners => ({
  tl: roundVec(c.tl, 3),
  tr: roundVec(c.tr, 3),
  bl: roundVec(c.bl, 3),
});

interface PyramidLevel {
  z: number;
  tileSize: number;
  cols: number;
  rows: number;
  pattern: string;
}

// Importer ------------------------------------------------------------------------------------------

export interface AlzourImportOptions extends ImportOptions {
  /** Optional folder with the design clip paths (`clip_*_path.json`) used as an independent pose check. */
  designAssets?: string;
}

export async function importAlzour(opts: AlzourImportOptions): Promise<ImportResult> {
  const log = opts.log ?? (() => undefined);
  const src = (...p: string[]) => join(opts.src, ...p);
  const readJson = (rel: string): unknown => JSON.parse(readFileSync(src(rel), 'utf8'));
  const w = new PackageWriter(opts.out);
  const rep = new ImportReport('Al-Zour LNG import terminal: import report');
  const layers: Layer[] = [];
  const blob = blobResolver(opts.src);

  // Model and frame -----------------------------------------------------------------------------
  const glbPath = src('plant.glb');
  let glb: Uint8Array;
  if (existsSync(glbPath)) {
    glb = readFileSync(glbPath);
    await w.copy(glbPath, 'models/plant.glb');
  } else {
    glb = decodeModelZip(readFileSync(src('model_glb_zip.b64.txt'), 'utf8')).glb;
    w.write('models/plant.glb', glb);
  }
  const gltf = glbJson(glb);
  const nodes = gltf.nodes ?? [];
  const pairs = utmPairs(nodes);
  const fit: Similarity2D = fitSimilarity2D(pairs);
  const [oE, oN] = applySimilarity2D(fit, [1300, 450]);
  const origin: Vec3 = [Math.round(oE), Math.round(oN), 100];
  const frame: FrameMap = plantFrame(fit, origin);
  const toLocal = (e: number, n: number, el: number): Vec3 =>
    roundVec(mapPoint(frame, plantToScene(e, n, el)), 3);
  const sceneToLocal = (x: number, y: number, zz: number): Vec3 =>
    roundVec(mapPoint(frame, [x, y, zz]), 3);
  // grid azimuth (clockwise from local north, -Z) of a plant azimuth
  const gridAz = (plantAz: number) => (((plantAz - fit.thetaDeg) % 360) + 360) % 360;

  const register: RegisterRow[] = parseRegister(
    readFileSync(src('KIPIC_AlZour_Asset_Register.csv'), 'utf8'),
  );
  const nodeNames = new Set(nodes.map((n) => n.name ?? ''));
  const tags = registerTags(register, nodeNames);
  layers.push({
    kind: 'mesh',
    id: 'plant',
    name: 'Plant model (as-built plot plans)',
    visible: true,
    src: { path: 'models/plant.glb' },
    transform: meshTransform(frame),
    tags,
  });
  rep.count('Mesh layers');
  rep.count('Mesh tags (register tags on model nodes)', tags.length);
  log(`model: ${nodes.length} nodes, ${tags.length} tags, fit rms ${fit.rms.toFixed(3)} m`);

  // Ortho: kit-pyramid of the low (32 cm) and high (8 cm) detail tiles ----------------------------
  const lay = LayersJson.parse(readJson('layers.json'));
  const gH = fitTileGrid(lay.ortho.H);
  const gL = fitTileGrid(lay.ortho.L);
  const k = Math.round(Math.hypot(...gL.u) / Math.hypot(...gH.u));
  const colsL = gL.maxI + 1;
  const rowsL = gL.maxJ + 1;
  const colsH = colsL * k;
  const rowsH = rowsL * k;
  const zH = Math.round(Math.log2(k));
  const sizeOf = (f: string) => {
    const s = imageSize(readFileSync(f));
    if (!s) throw new Error(`Cannot read image size of ${f}`);
    return s;
  };
  const fullPx = Math.max(...lay.ortho.L.map((t) => sizeOf(blob(t.f, lay.urls)).width));
  const orthoPattern = 'rasters/ortho/{z}/{x}_{y}.webp';
  const tileRel = (pattern: string, zz: number, x: number, y: number) =>
    pattern.replace('{z}', String(zz)).replace('{x}', String(x)).replace('{y}', String(y));
  let blankTiles = 0;
  const blank = async (rel: string, transparentRgb?: string) => {
    blankTiles++;
    await w.derive(rel, [], (out) =>
      composeImage({
        width: 64,
        height: 64,
        layers: [],
        out,
        ...(transparentRgb ? { transparentRgb } : {}),
      }),
    );
  };
  /**
   * Ortho tile: edge tiles padded to the full size (top-left anchored); no-data pixels keep alpha 0
   * and carry the sea colour, so a renderer that draws tiles opaque shows sea, not black.
   */
  const placeTile = async (file: string, rel: string, full: number) => {
    const s = sizeOf(file);
    if (s.width !== full || s.height !== full) rep.count('Raster edge tiles padded to full size');
    return w.derive(rel, [file], (out) =>
      composeImage({
        width: full,
        height: full,
        transparentRgb: ORTHO_NODATA_RGB,
        layers: [{ file, x: 0, y: 0, w: s.width, h: s.height }],
        out,
      }),
    );
  };
  const lFile = new Map<string, string>();
  for (const t of lay.ortho.L) {
    const ij = tileIndexOf(t.f);
    if (!ij) continue;
    const file = blob(t.f, lay.urls);
    lFile.set(`${ij.i}_${ij.j}`, file);
    await placeTile(file, tileRel(orthoPattern, 0, ij.i, ij.j), fullPx);
    rep.count('Ortho tiles, low detail');
  }
  const hHave = new Map<string, string>();
  for (const t of lay.ortho.H) {
    const ij = tileIndexOf(t.f);
    if (ij) hHave.set(`${ij.i}_${ij.j}`, blob(t.f, lay.urls));
  }
  const sub0 = fullPx / k;
  let filled = 0;
  for (let j = 0; j < rowsH; j++) {
    for (let i = 0; i < colsH; i++) {
      const rel = tileRel(orthoPattern, zH, i, j);
      const have = hHave.get(`${i}_${j}`);
      if (have) {
        await placeTile(have, rel, fullPx);
        rep.count('Ortho tiles, high detail');
        continue;
      }
      const lf = lFile.get(`${Math.floor(i / k)}_${Math.floor(j / k)}`);
      if (!lf) {
        await blank(rel, ORTHO_NODATA_RGB);
        continue;
      }
      const s = sizeOf(lf);
      filled++;
      await w.derive(rel, [lf], (out) =>
        composeImage({
          width: sub0,
          height: sub0,
          transparentRgb: ORTHO_NODATA_RGB,
          layers: [{ file: lf, x: -(i % k) * sub0, y: -(j % k) * sub0, w: s.width, h: s.height }],
          out,
        }),
      );
    }
  }
  const orthoCorners = roundCorners(gridCorners(gH, colsH, rowsH, ORTHO_Y, frame));
  const orthoLevels: PyramidLevel[] = [
    { z: 0, tileSize: fullPx, cols: colsL, rows: rowsL, pattern: orthoPattern },
    { z: zH, tileSize: fullPx, cols: colsH, rows: rowsH, pattern: orthoPattern },
  ];
  w.writeJson('rasters/ortho/tiles.json', {
    schema: 'aio.tiles/1',
    levels: orthoLevels,
    corners: orthoCorners,
  });
  layers.push({
    kind: 'raster',
    id: 'ortho',
    name: 'Drone orthomosaic, 21 Feb 2023',
    visible: true,
    src: { path: 'rasters/ortho/tiles.json' },
    role: 'ortho',
    format: 'kit-pyramid',
    corners: orthoCorners,
  });
  const gridGap = Math.hypot(gL.o[0] - gH.o[0], gL.o[1] - gH.o[1]);
  log(
    `ortho: ${lay.ortho.L.length} + ${lay.ortho.H.length} tiles, ${filled} filled from low detail`,
  );

  // Overall plot plan: kit-pyramid of line art PNGs with alpha, placed like the viewer's tiles -----
  const gP = fitTileGrid(lay.plan);
  const colsP = Math.ceil((gP.maxI + 1) / 2) * 2;
  const rowsP = Math.ceil((gP.maxJ + 1) / 2) * 2;
  const planFull = Math.max(...lay.plan.map((t) => sizeOf(blob(t.f, lay.urls)).width));
  const planPattern = 'rasters/plotplan/{z}/{x}_{y}.png';
  const pHave = new Map<string, string>();
  for (const t of lay.plan) {
    const ij = tileIndexOf(t.f);
    if (ij) pHave.set(`${ij.i}_${ij.j}`, blob(t.f, lay.urls));
  }
  // the viewer drew every tile on its own corners; the pyramid puts them on one fitted grid
  const planError = placementError(
    gP,
    lay.plan.map((t) => ({ ...t, ...sizeOf(blob(t.f, lay.urls)) })),
    planFull,
  );
  if (planError > 0.05)
    rep.warn(`Plot plan tiles sit up to ${planError.toFixed(2)} m off the fitted tile grid`);
  const p1 = new Map<string, string>();
  for (let j = 0; j < rowsP; j++) {
    for (let i = 0; i < colsP; i++) {
      const rel = tileRel(planPattern, 1, i, j);
      const have = pHave.get(`${i}_${j}`);
      if (!have) {
        await blank(rel);
        continue;
      }
      await w.derive(rel, [have], (out) =>
        writeLineArtPng(have, out, sizeOf(have), {
          tint: PLAN_RGB,
          padTo: { width: planFull, height: planFull },
        }),
      );
      p1.set(`${i}_${j}`, w.abs(rel));
      rep.count('Plot plan tiles');
    }
  }
  const coarse = planFull / 2;
  for (let j = 0; j < rowsP / 2; j++) {
    for (let i = 0; i < colsP / 2; i++) {
      const parts: { file: string; x: number; y: number; w: number; h: number }[] = [];
      for (const [di, dj] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const f = p1.get(`${2 * i + di}_${2 * j + dj}`);
        if (f)
          parts.push({
            file: f,
            x: di * (coarse / 2),
            y: dj * (coarse / 2),
            w: coarse / 2,
            h: coarse / 2,
          });
      }
      const rel = tileRel(planPattern, 0, i, j);
      if (!parts.length) {
        await blank(rel);
        continue;
      }
      await w.derive(
        rel,
        parts.map((p) => p.file),
        (out) => composeImage({ width: coarse, height: coarse, layers: parts, out }),
      );
    }
  }
  const planCorners = roundCorners(gridCorners(gP, colsP, rowsP, PLOTPLAN_Y, frame));
  w.writeJson('rasters/plotplan/tiles.json', {
    schema: 'aio.tiles/1',
    levels: [
      { z: 0, tileSize: coarse, cols: colsP / 2, rows: rowsP / 2, pattern: planPattern },
      { z: 1, tileSize: planFull, cols: colsP, rows: rowsP, pattern: planPattern },
    ] satisfies PyramidLevel[],
    corners: planCorners,
  });
  layers.push({
    kind: 'raster',
    id: 'plot-plan',
    name: 'Overall plot plan P0058LNG-00-40-0-T0003 (as built)',
    visible: false,
    src: { path: 'rasters/plotplan/tiles.json' },
    role: 'plan',
    format: 'kit-pyramid',
    corners: planCorners,
  });

  // Area plot plans (plant grid, 2 px/m) ----------------------------------------------------------
  const areaPlans = [
    { file: 'plan_0.png', id: 'area-plans-west', e0: -60, e1: 1280, label: 'west, E -60 to 1280' },
    {
      file: 'plan_1.png',
      id: 'area-plans-east',
      e0: 1280,
      e1: 2620,
      label: 'east, E 1280 to 2620',
    },
  ];
  for (const a of areaPlans) {
    if (!existsSync(src(a.file))) {
      rep.warn(`${a.file} missing; area plot plan not imported`);
      continue;
    }
    const rel = `rasters/areaplans/${a.id.replace('area-plans-', '')}.png`;
    await w.derive(rel, [src(a.file)], (out) =>
      writeLineArtPng(src(a.file), out, sizeOf(src(a.file)), { tint: PLAN_RGB }),
    );
    const el = 100 + AREAPLAN_Y;
    layers.push({
      kind: 'raster',
      id: a.id,
      name: `Area plot plans (${a.label})`,
      visible: false,
      src: { path: rel },
      role: 'plan',
      format: 'image',
      corners: {
        tl: toLocal(a.e0, 1080, el),
        tr: toLocal(a.e1, 1080, el),
        bl: toLocal(a.e0, 20, el),
      },
    });
    rep.count('Area plot plan images');
  }

  // Street map (Mapbox Streets mosaics baked in the artifact) -------------------------------------
  const mt = MapTiles.parse(readJson('map/maptiles.json'));
  const fits: { img: string; z: number; a: PixelAffine; w: number; h: number }[] = [];
  for (const t of mt.tiles) {
    const s = sizeOf(src(t.img));
    const n = t.n + 1;
    const pts: { px: number; py: number; x: number; z: number }[] = [];
    for (let v = 0; v < n * n; v++) {
      pts.push({
        px: (t.uv[v * 2] ?? 0) * s.width,
        py: (1 - (t.uv[v * 2 + 1] ?? 0)) * s.height,
        x: t.pos[v * 2] ?? 0,
        z: t.pos[v * 2 + 1] ?? 0,
      });
    }
    fits.push({ img: t.img, z: t.z, a: fitPixelAffine(pts), w: s.width, h: s.height });
  }
  const maxZ = Math.max(...fits.map((f) => f.z));
  const detail = fits.filter((f) => f.z === maxZ);
  const base = fits.find((f) => f.z < maxZ);
  const ref = detail[0];
  let streetNote = '';
  if (ref) {
    // canvas = pixel grid of the first detail mosaic; the others sit at (near) whole-pixel offsets
    const place = detail.map((f) => {
      const [x, y] = invertPixelAffine(ref.a, ...applyPixelAffine(f.a, 0, 0));
      const [x1] = invertPixelAffine(ref.a, ...applyPixelAffine(f.a, f.w, 0));
      return { f, x, y, s: (x1 - x) / f.w };
    });
    const minX = Math.floor(Math.min(...place.map((p) => p.x)));
    const minY = Math.floor(Math.min(...place.map((p) => p.y)));
    const maxX = Math.ceil(Math.max(...place.map((p) => p.x + p.f.w * p.s)));
    const maxY = Math.ceil(Math.max(...place.map((p) => p.y + p.f.h * p.s)));
    const W = maxX - minX;
    const H = maxY - minY;
    const canvasLayers: {
      file: string;
      crop?: { x: number; y: number; w: number; h: number };
      x: number;
      y: number;
      w: number;
      h: number;
    }[] = [];
    if (base) {
      // the coarse mosaic, cropped to the canvas and scaled up, fills the gaps between detail tiles
      const [bx0, by0] = invertPixelAffine(base.a, ...applyPixelAffine(ref.a, minX, minY));
      const [bx1, by1] = invertPixelAffine(base.a, ...applyPixelAffine(ref.a, maxX, maxY));
      const cx = Math.max(0, Math.floor(Math.min(bx0, bx1)));
      const cy = Math.max(0, Math.floor(Math.min(by0, by1)));
      const cw = Math.min(base.w - cx, Math.ceil(Math.abs(bx1 - bx0)) + 1);
      const ch = Math.min(base.h - cy, Math.ceil(Math.abs(by1 - by0)) + 1);
      const [px0, py0] = invertPixelAffine(ref.a, ...applyPixelAffine(base.a, cx, cy));
      const [px1, py1] = invertPixelAffine(ref.a, ...applyPixelAffine(base.a, cx + cw, cy + ch));
      canvasLayers.push({
        file: src(base.img),
        crop: { x: cx, y: cy, w: cw, h: ch },
        x: px0 - minX,
        y: py0 - minY,
        w: px1 - px0,
        h: py1 - py0,
      });
    }
    for (const p of place) {
      canvasLayers.push({
        file: src(p.f.img),
        x: p.x - minX,
        y: p.y - minY,
        w: p.f.w * p.s,
        h: p.f.h * p.s,
      });
    }
    const rel = 'rasters/streetmap.jpg';
    await w.derive(
      rel,
      canvasLayers.map((l) => l.file),
      (out) =>
        composeImage({
          width: W,
          height: H,
          background: '#262c34',
          layers: canvasLayers,
          out,
          quality: 88,
        }),
    );
    const at = (px: number, py: number) => {
      const [x, zz] = applyPixelAffine(ref.a, px + minX, py + minY);
      return sceneToLocal(x, STREET_Y, zz);
    };
    layers.push({
      kind: 'raster',
      id: 'street-map',
      name: 'Street map (Mapbox Streets, OpenStreetMap)',
      visible: false,
      src: { path: rel },
      role: 'plan',
      format: 'image',
      corners: { tl: at(0, 0), tr: at(W, 0), bl: at(0, H) },
    });
    const mpp = Math.hypot(ref.a.ax[0], ref.a.az[0]);
    const offFrac = Math.max(
      ...place.map((p) =>
        Math.max(Math.abs(p.x - Math.round(p.x)), Math.abs(p.y - Math.round(p.y))),
      ),
    );
    streetNote =
      `Street map: ${detail.length} zoom-${maxZ} mosaics placed on one ${W} x ${H} px canvas (${mpp.toFixed(2)} m/px, ` +
      `${((W * mpp) / 1000).toFixed(1)} x ${((H * mpp) / 1000).toFixed(1)} km)${base ? `, gaps filled from the zoom-${base.z} mosaic` : ''}. ` +
      `Affine fit of each mosaic to the viewer's warp grid (Web Mercator to plant grid): worst residual ${Math.max(...detail.map((f) => f.a.max)).toFixed(2)} m for the zoom-${maxZ} mosaics${base ? ` and ${base.a.max.toFixed(1)} m at the edge of the ${((base.w * Math.hypot(base.a.ax[0], base.a.az[0])) / 1000).toFixed(0)} km zoom-${base.z} mosaic (it only fills gaps)` : ''}; ` +
      `detail mosaics sit within ${offFrac.toFixed(2)} px of whole-pixel offsets. Attribution: ${mt.attr ?? '© Mapbox © OpenStreetMap'}.`;
    rep.count('Street map images');
  }

  // Point cloud: png-packed chunks re-expressed in the local frame -------------------------------
  const pc = PcJson.parse(readJson('pc/pc.json'));
  const chunks: {
    file: string;
    points: number;
    bounds: { min: Vec3; max: Vec3 };
    lod: number;
    quant: { offset: Vec3; scale: number };
  }[] = [];
  let pcPoints = 0;
  for (const [lod, level] of pc.levels.entries()) {
    for (const c of level) {
      const file = blob(c.f, pc.urls);
      const conv = convertPngChunk(readFileSync(file), { n: c.n, o: c.o, q: c.q }, frame);
      const rel = `clouds/alzour/${c.f.replace(/^.*\//, '').replace(/\.png$/i, '')}.png`;
      w.write(rel, conv.png);
      chunks.push({
        file: rel,
        points: c.n,
        bounds: conv.aabb,
        lod,
        quant: { offset: conv.o, scale: conv.q },
      });
      pcPoints += c.n;
      rep.count('Point cloud chunks');
    }
    log(`point cloud level ${lod}: ${level.length} chunks`);
  }
  const pcMin: Vec3 = [0, 1, 2].map((a) =>
    Math.min(...chunks.map((c) => c.bounds.min[a] ?? 0)),
  ) as Vec3;
  const pcMax: Vec3 = [0, 1, 2].map((a) =>
    Math.max(...chunks.map((c) => c.bounds.max[a] ?? 0)),
  ) as Vec3;
  const area = (pcMax[0] - pcMin[0]) * (pcMax[2] - pcMin[2]);
  w.writeJson('clouds/alzour/index.json', {
    schema: 'aio.pngcloud/1',
    bounds: { min: pcMin, max: pcMax },
    spacing: round(Math.sqrt(area / Math.max(1, pcPoints)) * 0.5, 2),
    chunks,
  });
  layers.push({
    kind: 'pointcloud',
    id: 'cloud',
    name: 'Photogrammetry point cloud, 21 Feb 2023 (1.2 % thinning)',
    visible: false,
    src: { path: 'clouds/alzour/index.json' },
    format: 'png-packed',
    pointCount: pcPoints,
  });
  rep.count('Points', pcPoints);

  // Photos and panoramas ----------------------------------------------------------------------------
  const media = MediaJson.parse(readJson('media/media.json'));
  const photoItems: PhotoRef[] = [];
  for (const s of media.stills) {
    const rel = `photos/${s.id}.jpg`;
    await w.copy(src(s.img), rel);
    await w.copy(src(s.th), `photos/thumbs/${s.id}.jpg`);
    const size = sizeOf(src(s.img));
    photoItems.push({
      id: s.id,
      src: { path: rel },
      takenAt: localIso(SURVEY_DATE, s.t),
      pos: toLocal(s.E, s.N, s.EL),
      q: roundVec(quatNormalize(mapQuat(frame, plantCameraQuat(s.az, s.pitch, s.roll))), 6),
      lens: {
        model: 'pinhole',
        hfovDeg: s.hfov,
        aspect: round(size.width / size.height || STILL_ASPECT, 4),
      },
    });
    rep.count('Photos');
  }
  layers.push({
    kind: 'photos',
    id: 'photos',
    name: 'Drone photos (Mavic 3 Cine)',
    visible: true,
    items: photoItems,
  });
  const panoItems: PanoRef[] = [];
  const panoMeta: unknown[] = [];
  for (const p of media.panos) {
    const rel = `panoramas/${p.id}.jpg`;
    await w.copy(src(p.img), rel);
    await w.copy(src(p.th), `panoramas/thumbs/${p.id}.jpg`);
    const pos = toLocal(p.E, p.N, p.EL);
    const headingDeg = round(gridAz(p.yaw), 2);
    panoItems.push({ id: p.id, src: { path: rel }, pos, headingDeg });
    const size = sizeOf(src(p.img));
    panoMeta.push({
      id: p.id,
      file: rel,
      kind: p.kind === 'sphere' ? 'equirectangular-360' : 'partial',
      takenAt: localIso(SURVEY_DATE, p.t),
      pos,
      headingDeg,
      hspanDeg: p.hspan ?? 360,
      vtopDeg: p.vtop ?? 90,
      vbotDeg: p.vbot ?? 90,
      sizePx: [size.width, size.height],
      plant: { E: p.E, N: p.N, EL: p.EL, yawDeg: p.yaw },
    });
    rep.count(p.kind === 'sphere' ? 'Panoramas, 360' : 'Panoramas, wide (partial)');
  }
  w.writeJson('panoramas/panoramas.json', {
    schema: 'aio.panoramas/1',
    note: 'headingDeg: grid azimuth (clockwise from local north, -Z) of the image centre column. Partial (wide) panoramas cover hspanDeg around it, from vbotDeg below to vtopDeg above the horizon; 360 panoramas are equirectangular.',
    panoramas: panoMeta,
  });
  layers.push({
    kind: 'panoramas',
    id: 'panoramas',
    name: 'Drone panoramas (360 and wide)',
    visible: true,
    items: panoItems,
  });

  // Videos and flights ------------------------------------------------------------------------------
  const flights = FlightsJson.parse(readJson('flights.json'));
  const names = Object.keys(flights.videos).sort((a, b) =>
    (flights.videos[a]?.created ?? '').localeCompare(flights.videos[b]?.created ?? ''),
  );
  const byFlight = new Map<number, FlightClip[]>();
  const infos = new Map<string, VideoInfo>();
  for (const n of names) {
    const v = flights.videos[n];
    if (!v) continue;
    const file = src('videos', `${n}.mp4`);
    if (!existsSync(file)) {
      rep.warn(`Clip ${n} listed in flights.json but videos/${n}.mp4 is missing`);
      continue;
    }
    const info = await probeVideo(file);
    infos.set(n, info);
    const aspect = round(info.width / info.height, 4);
    const lens: LensModel = {
      model: 'pinhole',
      hfovDeg: calibratedHfovDeg(aspect),
      aspect,
    };
    const clip: FlightClip = {
      name: n,
      video: v,
      startUtcMs: djiLocalToUtcMs(v.created),
      lens,
    };
    const list = byFlight.get(v.flight) ?? [];
    list.push(clip);
    byFlight.set(v.flight, list);
  }
  const videoLayers: Layer[] = [];
  const flightDocs = new Map<number, { doc: AioFlight; offsets: Map<string, number> }>();
  for (const [f, clips] of [...byFlight.entries()].sort((a, b) => a[0] - b[0])) {
    const first = clips[0];
    if (!first) continue;
    const fname = `Flight ${f} · ${hhmm(first.video.created)}`;
    const merged = mergeFlightClips(
      clips,
      (c) => plantVideoToFlight(c.video, frame, c.startUtcMs, c.lens),
      fname,
    );
    flightDocs.set(f, merged);
    const flightRel = `flights/flight${f}.json`;
    w.writeJson(flightRel, AioFlight.parse(merged.doc), false);
    rep.count('Flights (aio.flight/1)');
    rep.count('Pose samples', merged.doc.samples.length);
    for (const [ci, c] of clips.entries()) {
      const info = infos.get(c.name);
      if (!info) continue;
      const file = src('videos', `${c.name}.mp4`);
      let rel = `video/${c.name}.mp4`;
      if (CHROMIUM_CODECS.has(info.codec)) await w.copy(file, rel);
      else {
        rel = `video/${c.name}.h264.mp4`;
        await w.derive(rel, [file], (out) => transcodeH264(file, out));
        rep.warn(`${c.name}: codec ${info.codec} transcoded to H.264`);
      }
      const posterRel = `posters/${c.name}.jpg`;
      await w.derive(posterRel, [file], (out) =>
        extractFrame(file, Math.min(1, info.durationS / 2), out, 960),
      );
      videoLayers.push({
        kind: 'video',
        id: `clip-${c.name}`,
        name: `${fname} · clip ${ci + 1} of ${clips.length} (${c.name})`,
        visible: true,
        src: { path: rel },
        flight: { src: { path: flightRel }, startUtcMs: merged.doc.startUtcMs },
        lens: c.lens,
        offsetMs: merged.offsets.get(c.name) ?? 0,
        poster: { path: posterRel },
      });
      rep.count('Video clips');
      const trackS = c.video.track.length / c.video.hz;
      if (Math.abs(trackS - info.durationS) > 1.5) {
        rep.note(
          `${c.name}: track covers ${trackS.toFixed(1)} s, video runs ${info.durationS.toFixed(1)} s (flights.json dur ${c.video.dur} s); poses past the video end are unused.`,
        );
      }
    }
    log(`flight ${f}: ${clips.length} clips, ${merged.doc.samples.length} samples`);
  }
  layers.push(...videoLayers);

  // Thumbnail ------------------------------------------------------------------------------------
  const thumbClip = src('videos', 'DJI_0665.mp4');
  if (existsSync(thumbClip)) {
    await w.derive('thumbnail.jpg', [thumbClip], (out) =>
      extractFrame(thumbClip, THUMB_TIME_S, out, 960),
    );
  }
  await w.copy(src('KIPIC_AlZour_Asset_Register.csv'), 'report/KIPIC_AlZour_Asset_Register.csv');

  // Manifest -------------------------------------------------------------------------------------
  const manifestInput: ProjectManifestInput = {
    schema: 'aio.project/1',
    id: 'alzour',
    name: 'Al-Zour LNG Import Terminal',
    customer: 'KIPIC',
    site: 'KIPIC Al-Zour LNG import terminal, Kuwait',
    crs: { epsg: 32639 },
    origin,
    captures: [
      {
        id: 'survey-2023-02-21',
        label:
          'Drone survey: Mavic 3 Cine video, photos and panoramas; orthomosaic and point cloud',
        date: SURVEY_DATE,
      },
    ],
    layers,
    severityModels: [PLANT_SEVERITY_MODEL],
    classCatalogues: [PLANT_CATALOGUE],
  };
  const valid = validatePackage(manifestInput, []);
  w.writeJson('manifest.json', valid.manifest);
  w.writeJson('issues.json', { schema: ISSUES_SCHEMA, issues: valid.issues });

  // Verification ---------------------------------------------------------------------------------
  const inv = invertFrame(frame);
  let roundTrip = 0;
  for (const clips of byFlight.values()) {
    for (const c of clips) {
      const doc = plantVideoToFlight(c.video, frame, c.startUtcMs, c.lens);
      c.video.track.forEach((row, i) => {
        const s = doc.samples[i];
        if (!s) return;
        const back = mapPoint(inv, s.pos);
        const want = plantToScene(row[0] ?? 0, row[1] ?? 0, row[2] ?? 0);
        roundTrip = Math.max(roundTrip, Math.hypot(...sub(back, want)));
      });
    }
  }
  const assets = register.filter((r) => r.plantE !== null && r.plantN !== null && r.hasGeometry);
  const nearest = (e: number, n: number) => {
    let best: RegisterRow | undefined;
    let bd = Infinity;
    for (const r of assets) {
      const d = Math.hypot((r.plantE ?? 0) - e, (r.plantN ?? 0) - n);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return { row: best, d: bd };
  };
  const siteO = gridPoint(gH, 0, 0);
  const siteU = gridPoint(gH, colsH, 0);
  const siteV = gridPoint(gH, 0, rowsH);
  const u: [number, number] = [siteU[0] - siteO[0], siteU[1] - siteO[1]];
  const v: [number, number] = [siteV[0] - siteO[0], siteV[1] - siteO[1]];
  const assetPts = assets.map((r) => toLocal(r.plantE ?? 0, r.plantN ?? 0, r.baseEl ?? 100));
  const inFrame = (pos: Vec3, q: Quat, lens: LensModel, pts: readonly Vec3[], maxDepth = 3000) =>
    pts.filter((p) => {
      const im = projectToImage(pos, q, lens, p);
      return !!im && im.depth < maxDepth && Math.abs(im.u) <= 1 && Math.abs(im.v) <= 1;
    }).length;
  const rows: string[] = [
    '| Clip | Flight | Video time | Camera E / N / height | Heading (plant) | Gimbal | View axis meets grade at E / N | Nearest asset there | Register assets in frame |',
    '| --- | ---: | ---: | --- | ---: | ---: | --- | --- | ---: |',
  ];
  let checked = 0;
  let onSite = 0;
  let looksUp = 0;
  let withAssets = 0;
  for (const [f, fd] of [...flightDocs.entries()].sort((a, b) => a[0] - b[0])) {
    for (const c of byFlight.get(f) ?? []) {
      const off = fd.offsets.get(c.name) ?? 0;
      const dur = infos.get(c.name)?.durationS ?? c.video.dur;
      for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const tS = dur * frac;
        const pose = poseAt(fd.doc, off + tS * 1000);
        const nIn = inFrame(pose.pos, pose.q, c.lens, assetPts);
        if (nIn > 0) withAssets++;
        const hit = groundHit(pose.pos, pose.q, 0);
        checked++;
        if (!hit) {
          looksUp++;
          continue;
        }
        const sh = mapPoint(inv, hit);
        if (inParallelogram(siteO, u, v, [sh[0], sh[2]])) onSite++;
        if (frac !== 0.5) continue;
        const cam = localToPlant(frame, pose.pos);
        const g = localToPlant(frame, hit);
        const row =
          c.video.track[Math.min(c.video.track.length - 1, Math.round(tS * c.video.hz))] ?? [];
        const nb = nearest(g.E, g.N);
        rows.push(
          `| ${c.name} | ${f} | ${tS.toFixed(1)} s | ${cam.E.toFixed(0)} / ${cam.N.toFixed(0)} / ${(cam.EL - 100).toFixed(0)} m | ${(row[3] ?? 0).toFixed(0)}° | ${(row[4] ?? 0).toFixed(0)}° | ${g.E.toFixed(0)} / ${g.N.toFixed(0)} | ${nb.row ? `${nb.row.tag || nb.row.name} (${nb.d.toFixed(0)} m)` : '-'} | ${nIn} |`,
        );
      }
    }
  }
  // Known views (design clips cut from the originals): LNG tanks in the camera frame each second.
  const tankTops = register
    .filter((r) => r.type === 'tank_lng' && r.plantE !== null)
    .map((r) => toLocal(r.plantE ?? 0, r.plantN ?? 0, r.topEl ?? 141));
  const knownLines: string[] = [];
  const known = [
    {
      clip: 'DJI_0789',
      t0: 5,
      t1: 16,
      what: 'close pass over the LNG tank roofs (design clip `clip_dji0789_tanks`)',
    },
    {
      clip: 'DJI_0665',
      t0: 14,
      t1: 25,
      what: 'overview flying east toward the tank field (design clip `clip_dji0665_overview`)',
    },
  ];
  for (const kv of known) {
    const v0 = flights.videos[kv.clip];
    const fd = v0 ? flightDocs.get(v0.flight) : undefined;
    const lens = v0 ? byFlight.get(v0.flight)?.find((c) => c.name === kv.clip)?.lens : undefined;
    if (!fd || !lens) continue;
    const off = fd.offsets.get(kv.clip) ?? 0;
    const counts: number[] = [];
    for (let t = kv.t0; t <= kv.t1 + 1e-9; t += 1) {
      const pose = poseAt(fd.doc, off + t * 1000);
      counts.push(inFrame(pose.pos, pose.q, lens, tankTops));
    }
    knownLines.push(
      `- ${kv.clip} ${kv.t0} to ${kv.t1} s, ${kv.what}: ${Math.min(...counts)} to ${Math.max(...counts)} of the ${tankTops.length} LNG tank roofs (wall top centre) project inside the camera frame at each of the ${counts.length} sampled seconds; seconds with no tank in frame: ${counts.filter((c) => c === 0).length}.`,
    );
  }
  // Independent check against the design clip paths (built separately from the same tracks).
  if (opts.designAssets && existsSync(opts.designAssets)) {
    for (const f of readdirSync(opts.designAssets).filter((x) => /^clip_.*_path\.json$/.test(x))) {
      const j = JSON.parse(readFileSync(join(opts.designAssets, f), 'utf8')) as {
        video?: string;
        clip_start_in_source_s?: number;
        samples?: { t: number; pos: Vec3; q: [number, number, number, number] }[];
      };
      const v0 = j.video ? flights.videos[j.video] : undefined;
      const fd = v0 ? flightDocs.get(v0.flight) : undefined;
      if (!j.video || !v0 || !fd || !j.samples) continue;
      const off = fd.offsets.get(j.video) ?? 0;
      let dp = 0;
      let dq = 0;
      for (const s of j.samples) {
        const pose = poseAt(fd.doc, off + ((j.clip_start_in_source_s ?? 0) + s.t) * 1000);
        dp = Math.max(dp, Math.hypot(...sub(mapPoint(inv, pose.pos), s.pos)));
        dq = Math.max(dq, quatAngleDeg(mapQuat(inv, pose.q), s.q));
      }
      knownLines.push(
        `- ${f} (${j.samples.length} samples, ${j.video} from ${j.clip_start_in_source_s ?? 0} s): converted poses mapped back to the plant frame differ from the design path by at most ${dp.toFixed(3)} m and ${dq.toFixed(3)} deg.`,
      );
    }
  }

  // Report ---------------------------------------------------------------------------------------
  const thetaCw = -fit.thetaDeg;
  rep.section('Frame and georeference', [
    `Plant grid to UTM 39N (EPSG 32639) from ${fit.n} GLB nodes that carry both plant and UTM-39 positions: rigid turn of ${thetaCw.toFixed(4)} deg (plant north is east of grid north), scale ${fit.scale.toFixed(6)}, residual rms ${fit.rms.toFixed(3)} m, max ${fit.maxResidual.toFixed(3)} m. The model's own note gives 17.9991 deg and origin UTM 244338.089 E / 3179515.690 N.`,
    `Project origin: UTM ${origin[0]} E, ${origin[1]} N (plant grid point E 1300, N 450 rounded to the metre), height 100 on the plant datum (HPFS EL 100.000 = plant grade = +7.5 m ACD; MSL is EL 93.56). So local \`y = EL - 100\` and grade is \`y = 0\`.`,
    `Plant scene frame (\`x = E - 1300\`, \`y = EL - 100\`, \`z = -(N - 450)\`) to local: turn ${fit.thetaDeg.toFixed(4)} deg about +Y, then offset [${frame.offset.map((x) => x.toFixed(3)).join(', ')}] m. The GLB is copied unchanged; the turn and offset are baked into the mesh layer \`transform\`. Everything else (ortho, plans, street map, point cloud, poses, photos, panoramas) is converted into the local frame.`,
    `Azimuths: plant azimuth + ${thetaCw.toFixed(4)} deg = grid azimuth. Panorama \`headingDeg\` is the grid azimuth of the image centre column.`,
  ]);
  rep.section('Camera pose check', [
    `All 25 clip tracks: converted camera positions mapped back to the plant frame match the source track to ${(roundTrip * 1000).toFixed(2)} mm. Camera orientation = stabilised heading + gimbal pitch (no roll), as the original viewer: Euler(gimbal pitch, -azimuth, 0, YXZ) in the plant frame, then the plant-to-local turn.`,
    `View axis at 10, 30, 50, 70 and 90 % of every clip (${checked} poses): ${onSite} meet plant grade inside the surveyed site (ortho extent ${(Math.hypot(...u) / 1000).toFixed(2)} x ${(Math.hypot(...v) / 1000).toFixed(2)} km), ${checked - onSite - looksUp} meet it outside (sea, approach), ${looksUp} point at or above the horizon. Register assets (base point) inside the camera frame within 3 km: at least one in ${withAssets} of ${checked} poses.`,
    ...knownLines,
    '',
    'Mid-clip view of every clip:',
    '',
    ...rows,
  ]);
  rep.section('What was converted', [
    `- Model: \`models/plant.glb\` (${formatBytes(glb.length)}, ${nodes.length} nodes, generator "${gltf.asset?.generator ?? '?'}"), decoded from the artifact's \`model_glb_zip.b64.txt\`. Tags: ${tags.length} register tags on model nodes, \`area\` = one of the ${ALZOUR_GROUPS.length} area groups (Site_Terrain has no register rows).`,
    `- Ortho: \`kit-pyramid\` \`rasters/ortho/tiles.json\`, level 0 = ${colsL} x ${rowsL} low-detail tiles (${Math.hypot(...gL.u).toFixed(1)} m, ${((Math.hypot(...gL.u) / fullPx) * 100).toFixed(0)} cm/px), level ${zH} = ${colsH} x ${rowsH} high-detail tiles (${Math.hypot(...gH.u).toFixed(2)} m, ${((Math.hypot(...gH.u) / fullPx) * 100).toFixed(0)} cm/px). ${lay.ortho.H.length} high-detail tiles from the artifact, ${filled} cut from the low-detail level where the artifact has none. Every tile re-encoded as WebP (quality 85) at ${fullPx} px, edge tiles padded; no-data pixels keep alpha 0 and carry the sea colour ${ORTHO_NODATA_RGB}. Tile grid fit rms ${gH.rms.toFixed(3)} m (low ${gL.rms.toFixed(3)} m, origins ${gridGap.toFixed(3)} m apart). Drawn ${ORTHO_Y} m above grade.`,
    `- Overall plot plan: \`kit-pyramid\` \`rasters/plotplan/tiles.json\`, level 1 = ${colsP} x ${rowsP} tiles (${planFull} px, ${Math.hypot(...gP.u).toFixed(1)} m), level 0 = ${colsP / 2} x ${rowsP / 2} merged tiles (${coarse} px). Tile grid fit rms ${gP.rms.toFixed(3)} m; every source tile's corners as the viewer placed them lie within ${planError.toFixed(3)} m of the pyramid placement. Line art as PNG with alpha: the background is transparent, the monochrome (white) lines take the viewer's red (#d10f0f). Drawn ${PLOTPLAN_Y} m above grade, over the ortho.`,
    `- Area plot plans: \`plan_0.png\` and \`plan_1.png\` (2 px/m in the plant grid, E -60 to 2620, N 20 to 1080 as the viewer) as two \`image\` rasters in \`rasters/areaplans/\`, converted the same way, ${AREAPLAN_Y} m above grade.`,
    `- ${streetNote}`,
    `- Point cloud: \`png-packed\` \`clouds/alzour/index.json\` (aio.pngcloud/1), ${chunks.length} chunks (lod 0: 1 overview, lod 1 and 2: ${pc.levels[1]?.length ?? 0} + ${pc.levels[2]?.length ?? 0} tiles), ${pcPoints.toLocaleString('en')} points, decoded with the viewer rule \`o + q * u\`, turned into the local frame and quantised again to a cube per chunk (step <= 0.1 mm over the source step). ${pc.note ?? ''}`,
    `- Video: ${videoLayers.length} clips copied as delivered (H.264, ${[...new Set([...infos.values()].map((i) => `${i.width}x${i.height}`))].join(', ')}), JPEG poster at 1 s (960 px). One \`aio.flight/1\` file per drone flight (\`flights/flightN.json\`, ${flightDocs.size} flights) so the app groups the clips; each clip's \`offsetMs\` is its start minus the flight start. Lens pinhole ${String(ALZOUR_HFOV_DEG.wide)} deg for 5.1K (17:9) clips and ${String(ALZOUR_HFOV_DEG.uhd)} deg for 4K (16:9), calibrated against the plant model (the source stated 83 deg for all clips).`,
    `- Photos: ${photoItems.length} stills (2048 px review copies as delivered, 320 px thumbs) with position, orientation (heading with the viewer's fitted correction, gimbal pitch, roll) and lens (pinhole 71.5 deg).`,
    `- Panoramas: ${panoItems.length} (${media.panos.filter((p) => p.kind === 'sphere').length} equirectangular 360, ${media.panos.filter((p) => p.kind === 'wide').length} wide partial) with position and heading; full coverage metadata in \`panoramas/panoramas.json\`.`,
    `- Issues: none in the source; \`issues.json\` is empty. Severity model "${PLANT_SEVERITY_MODEL.name}" (1 Observation to 5 Critical, plus To be confirmed) and class catalogue "${PLANT_CATALOGUE.name}" (${PLANT_CATALOGUE.classes.length} classes).`,
    '- Report: the asset register CSV in `report/`. Thumbnail: frame at 20 s of DJI_0665 (overview toward the tanks).',
  ]);
  if (blankTiles)
    rep.note(
      `${blankTiles} pyramid tiles have no source data and are written as small transparent tiles.`,
    );
  rep.note(
    'Wide (partial) panoramas: the manifest `panoramas` layer has no field for partial coverage, so a viewer that assumes 360 x 180 will stretch them; `panoramas/panoramas.json` carries hspan, vtop and vbot.',
  );
  rep.note(
    'Not converted (viewer rendering aids): `landmask.json`, `shore_dist.png`, `water_normals.png`, `sum/` panel thumbnails, and the viewer page itself.',
  );
  rep.warn(
    'Rasters carry alpha (survey edge, padded tiles, plan line art). A renderer that draws raster tiles opaque shows those areas black.',
  );
  rep.warn(
    'Camera positions are GNSS/barometric (about +-2 m) with heading from the aircraft compass; the clips have no photogrammetric alignment.',
  );
  rep.warn(
    'Clip fields of view are calibrated against the plant model (about +-2 deg); the clip poses still show a pitch offset of about 8 deg against the model, which the lens does not absorb.',
  );
  const pruned = w.prune('rasters');
  if (pruned.length)
    rep.note(
      `Removed ${pruned.length} raster files of an earlier import that this run no longer writes.`,
    );
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
