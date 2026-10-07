/**
 * M10 e2e fixtures (stream G8): the photo processing demo as a writable project, and a library of
 * synthetic sites around the Earth with imagery and terrain packs and tilesets for the Globe.
 * Synthetic only: fictional places, procedural tiles, licence "CC0 test fixture".
 *
 * Used through `fixtures.ts` (`photoProject`, `globeLibrary`); the builders are exported so unit
 * style specs can check them without launching the app.
 */
import { toWgs84 } from '@aio/geo';
import {
  ProjectManifest,
  RasterPackMeta,
  SCHEMA_VERSION,
  TilesetsFile,
  type ProjectManifestInput,
  type RasterPackMeta as RasterPackMetaT,
  type Vec3,
} from '@aio/schema';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync, gzipSync } from 'node:zlib';
import { serializeDirectory, writeFullHeader, zxyToTileId } from '../src/main/packs/format';

type Crs = ProjectManifest['crs'];

// ---------------------------------------------------------------- the photo processing demo

/** The bundled photo demo (tools/demo/photo-demo.mjs). */
export const PHOTO_DEMO = {
  id: 'demo-photo-processing',
  name: 'Photo processing demo',
  /** The precomputed alignment's run id. */
  run: '20260314-1000',
} as const;

/** `truth.json` of the synthetic photo set (python/tests/photo_synth.py), the parts tests read. */
export interface PhotoTruth {
  schema: 'aio.photo-truth/1';
  site: {
    crs: { epsg: number };
    origin: Vec3;
    lonLat: [number, number];
    benchmark: { xyz: Vec3; lonLat: [number, number]; heightM: number };
  };
  camera: { width: number; height: number; fx: number; fy: number; cx: number; cy: number };
  gsdCm: number;
  photos: {
    name: string;
    kind: 'nadir' | 'oblique' | 'blurred' | 'duplicate' | 'outlier' | 'corrupt' | 'no-gps';
    expect: 'register' | 'reject' | 'either';
    reason?: string;
    centre: Vec3;
    /** World to camera, rows: camera x (right), y (down), z (forward) in x east, y north, z up. */
    rotation: [Vec3, Vec3, Vec3];
  }[];
  targets: {
    id: string;
    role: 'control' | 'check' | 'blunder';
    xyz: Vec3;
    stated: Vec3;
    observations: { photo: string; px: [number, number] }[];
  }[];
  scene: { stockpile: { volumeM3: number } };
}

/** What the `photoProject` fixture hands a test. */
export interface PhotoProject {
  id: string;
  /** The project folder in the data root (a writable copy of the demo). */
  dir: string;
  run: string;
  /** `<dir>/photogrammetry/<run>/`. */
  runDir: string;
  truth: PhotoTruth;
  /** Photo id in the layer of a file name of the set: SYN_0024.JPG -> syn-0024. */
  photoId(name: string): string;
}

export const hasPhotoDemo = (demoFolder: string): boolean =>
  existsSync(join(demoFolder, PHOTO_DEMO.id, 'truth.json'));

/** Copy the photo demo into `<dataRoot>/projects/demo-photo-processing/` (a writable project). */
export async function createPhotoProject(
  dataRoot: string,
  demoFolder: string,
): Promise<PhotoProject> {
  const src = join(demoFolder, PHOTO_DEMO.id);
  const dir = join(dataRoot, 'projects', PHOTO_DEMO.id);
  await mkdir(join(dataRoot, 'projects'), { recursive: true });
  await cp(src, dir, { recursive: true });
  const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8')) as PhotoTruth;
  return {
    id: PHOTO_DEMO.id,
    dir,
    run: PHOTO_DEMO.run,
    runDir: join(dir, 'photogrammetry', PHOTO_DEMO.run),
    truth,
    photoId: (name) =>
      name
        .replace(/\.jpg$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-'),
  };
}

// ---------------------------------------------------------------- PNG and PMTiles

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An 8-bit RGB PNG (no metadata chunks, filter none). */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface RasterTile {
  z: number;
  x: number;
  y: number;
  data: Buffer;
}

/**
 * A raster PMTiles v3 archive: gzip directories and metadata, tiles stored as they are (PNG),
 * identical tiles stored once.
 */
export function rasterPmtiles(o: {
  tiles: RasterTile[];
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  metadata: Record<string, unknown>;
}): Buffer {
  const byId = o.tiles
    .map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), data: t.data }))
    .sort((a, b) => a.id - b.id);
  const seen = new Map<string, number>();
  const blobs: Buffer[] = [];
  const entries: { tileId: number; offset: number; length: number; runLength: number }[] = [];
  let at = 0;
  for (const t of byId) {
    const key = t.data.toString('base64');
    let offset = seen.get(key);
    if (offset === undefined) {
      offset = at;
      seen.set(key, at);
      blobs.push(t.data);
      at += t.data.length;
    }
    entries.push({ tileId: t.id, offset, length: t.data.length, runLength: 1 });
  }
  const root = gzipSync(serializeDirectory(entries));
  const meta = gzipSync(Buffer.from(JSON.stringify(o.metadata)));
  const data = Buffer.concat(blobs);
  const header = writeFullHeader({
    rootOffset: 127,
    rootLength: root.length,
    metadataOffset: 127 + root.length,
    metadataLength: meta.length,
    leafOffset: 127 + root.length + meta.length,
    leafLength: 0,
    dataOffset: 127 + root.length + meta.length,
    dataLength: data.length,
    addressedTiles: entries.length,
    tileEntries: entries.length,
    tileContents: blobs.length,
    clustered: true,
    internalCompression: 2,
    tileCompression: 1,
    tileType: 2,
    minZoom: o.minZoom,
    maxZoom: o.maxZoom,
    bounds: o.bounds,
    centerZoom: o.minZoom,
    center: [(o.bounds[0] + o.bounds[2]) / 2, (o.bounds[1] + o.bounds[3]) / 2],
  });
  return Buffer.concat([header, root, meta, data]);
}

const TILE = 256;

/** Tiles of zoom `z` touching `bbox` (west, south, east, north). */
export function tilesIn(bbox: [number, number, number, number], z: number): [number, number][] {
  const n = 2 ** z;
  const tx = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
    return Math.min(n - 1, Math.max(0, Math.floor(y)));
  };
  const out: [number, number][] = [];
  for (let x = tx(bbox[0]); x <= tx(bbox[2] - 1e-9); x++)
    for (let y = ty(bbox[3]); y <= ty(bbox[1] + 1e-9); y++) out.push([x, y]);
  return out;
}

/** [lon, lat] of the centre of pixel (px, py) of tile z/x/y (256 px, Web Mercator). */
export function pixelLonLat(
  z: number,
  x: number,
  y: number,
  px: number,
  py: number,
): [number, number] {
  const n = 2 ** z;
  const lon = ((x + (px + 0.5) / TILE) / n) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (py + 0.5) / TILE)) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/** Tile z/x/y and pixel holding [lon, lat]. */
export function lonLatPixel(z: number, [lon, lat]: [number, number]) {
  const n = 2 ** z;
  const fx = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  return { z, x, y, px: Math.floor((fx - x) * TILE), py: Math.floor((fy - y) * TILE) };
}

function renderTile(
  z: number,
  x: number,
  y: number,
  colour: (lon: number, lat: number, z: number) => [number, number, number],
): Buffer {
  const rgb = new Uint8Array(TILE * TILE * 3);
  for (let py = 0; py < TILE; py++)
    for (let px = 0; px < TILE; px++) {
      const [lon, lat] = pixelLonLat(z, x, y, px, py);
      const c = colour(lon, lat, z);
      const i = (py * TILE + px) * 3;
      rgb[i] = c[0];
      rgb[i + 1] = c[1];
      rgb[i + 2] = c[2];
    }
  return encodePngRgb(TILE, TILE, rgb);
}

// ---------------------------------------------------------------- synthetic imagery and terrain

/** When every synthetic pack was "built" (fixed: the files are byte for byte reproducible). */
export const SYNTHETIC_BUILT_AT = '2026-10-07T00:00:00Z';
const FIXTURE_LICENCE = {
  licence: 'CC0-1.0',
  attribution: 'Synthetic test imagery (CC0 test fixture)',
  provenance: 'Procedural tiles from apps/desktop/e2e/m10Fixtures.ts',
  customerLicence: false,
  builtAt: SYNTHETIC_BUILT_AT,
};

/**
 * Procedural imagery: a sea-and-land pattern with a graticule four lines per tile at every zoom
 * (so zoom and placement show), and red rings around the fictional sites.
 */
export function imageryColour(lon: number, lat: number, z: number): [number, number, number] {
  const r = Math.PI / 180;
  const sea = Math.sin(lon * r * 3) * Math.cos(lat * r * 2) < -0.35;
  let c: [number, number, number] = sea
    ? [40, 80 + Math.round(20 * Math.cos(lat * r * 9)), 140]
    : [
        Math.round(196 + 20 * Math.sin(lon * r * 40)),
        Math.round(170 + 18 * Math.cos(lat * r * 40)),
        Math.round(120 + 10 * Math.sin((lon + lat) * r * 90)),
      ];
  const step = 360 / 2 ** z / 4;
  const fx = ((((lon + 180) / step) % 1) + 1) % 1;
  const fy = ((((lat + 90) / step) % 1) + 1) % 1;
  if (fx < 0.02 || fy < 0.02) c = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6].map(Math.round) as typeof c;
  for (const s of GLOBE_SITES) {
    if (!s.lonLat) continue;
    const dkm = Math.hypot((lon - s.lonLat[0]) * Math.cos(lat * r), lat - s.lonLat[1]) * 111.2;
    if (Math.abs(dkm - 0.3) < 0.03) c = [220, 40, 40];
  }
  return c;
}

/** Heights of the synthetic terrain (metres above the EGM2008 geoid). */
export function terrainHeight(lon: number, lat: number): number {
  const r = Math.PI / 180;
  return (
    150 +
    60 * Math.sin(lon * r * 40) * Math.cos(lat * r * 40) +
    15 * Math.sin(lon * r * 700 + 1) * Math.cos(lat * r * 650)
  );
}

/** Terrarium: height = R * 256 + G + B / 256 - 32768. */
export function terrarium(h: number): [number, number, number] {
  const v = Math.max(0, Math.min(65535.996, h + 32768));
  return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v - Math.floor(v)) * 256)];
}

export const decodeTerrarium = ([r, g, b]: [number, number, number]): number =>
  r * 256 + g + b / 256 - 32768;

export interface RasterPackFixture {
  meta: RasterPackMetaT;
  pmtiles: Buffer;
}

const packCache = new Map<string, RasterPackFixture>();

/** An imagery pack of procedural tiles over `bbox` from `minZoom` to `maxZoom`. */
export function imageryPack(o: {
  id: string;
  label: string;
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
}): RasterPackFixture {
  const key = JSON.stringify(o);
  const hit = packCache.get(key);
  if (hit) return hit;
  const tiles: RasterTile[] = [];
  for (let z = o.minZoom; z <= o.maxZoom; z++)
    for (const [x, y] of tilesIn(o.bbox, z))
      tiles.push({ z, x, y, data: renderTile(z, x, y, imageryColour) });
  const meta = RasterPackMeta.parse({
    schema: 'aio.raster-pack/1',
    id: o.id,
    kind: 'imagery',
    label: o.label,
    bbox: o.bbox,
    minZoom: o.minZoom,
    maxZoom: o.maxZoom,
    tileSize: TILE,
    format: 'png',
    ...FIXTURE_LICENCE,
  });
  const pack = {
    meta,
    pmtiles: rasterPmtiles({
      tiles,
      bounds: o.bbox,
      minZoom: o.minZoom,
      maxZoom: o.maxZoom,
      metadata: { name: o.label, attribution: FIXTURE_LICENCE.attribution, type: 'baselayer' },
    }),
  };
  packCache.set(key, pack);
  return pack;
}

/** A known height of a terrain pack: the centre of one pixel at its highest zoom. */
export interface TerrainBenchmark {
  lonLat: [number, number];
  /** The exact synthetic height there (EGM2008); the tile stores it to 1/256 m. */
  heightM: number;
  tile: { z: number; x: number; y: number; px: number; py: number };
}

/** A Terrarium terrain pack of `terrainHeight` over `bbox`, with a benchmark near `near`. */
export function terrainPack(o: {
  id: string;
  label: string;
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  near: [number, number];
}): RasterPackFixture & { benchmark: TerrainBenchmark } {
  const tiles: RasterTile[] = [];
  for (let z = o.minZoom; z <= o.maxZoom; z++)
    for (const [x, y] of tilesIn(o.bbox, z))
      tiles.push({
        z,
        x,
        y,
        data: renderTile(z, x, y, (lon, lat) => terrarium(terrainHeight(lon, lat))),
      });
  const at = lonLatPixel(o.maxZoom, o.near);
  const lonLat = pixelLonLat(at.z, at.x, at.y, at.px, at.py);
  const meta = RasterPackMeta.parse({
    schema: 'aio.raster-pack/1',
    id: o.id,
    kind: 'terrain',
    label: o.label,
    bbox: o.bbox,
    minZoom: o.minZoom,
    maxZoom: o.maxZoom,
    tileSize: TILE,
    format: 'png',
    encoding: 'terrarium',
    verticalDatum: 'egm2008',
    ...FIXTURE_LICENCE,
    attribution: 'Synthetic test terrain (CC0 test fixture)',
  });
  return {
    meta,
    pmtiles: rasterPmtiles({
      tiles,
      bounds: o.bbox,
      minZoom: o.minZoom,
      maxZoom: o.maxZoom,
      metadata: { name: o.label, encoding: 'terrarium', attribution: meta.attribution },
    }),
    benchmark: { lonLat, heightM: terrainHeight(lonLat[0], lonLat[1]), tile: at },
  };
}

/** Write a raster pack into `<dataRoot>/packs/{imagery,terrain}/<id>.{pmtiles,json}`. */
export async function writeRasterPack(dataRoot: string, pack: RasterPackFixture): Promise<string> {
  const dir = join(dataRoot, 'packs', pack.meta.kind);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${pack.meta.id}.pmtiles`);
  await writeFile(file, pack.pmtiles);
  await writeFile(join(dir, `${pack.meta.id}.json`), `${JSON.stringify(pack.meta, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------- the globe library

export interface GlobeSiteFixture {
  id: string;
  name: string;
  crs: Crs;
  origin: Vec3;
  /** Where the Globe should put it (the origin in WGS 84); null: it cannot be placed. */
  lonLat: [number, number] | null;
  captures: number;
  /** Issues not closed, and those by severity (the level value as text, or "uncertain"). */
  openIssues: number;
  bySeverity: Record<string, number>;
  tilesets: { id: string; kind: 'mesh' | 'points' | 'terrain' | 'imported' }[];
}

const SITE_DEFS: {
  id: string;
  name: string;
  crs: Crs;
  origin: Vec3;
  issues: (number | 'uncertain' | 'closed')[];
  captures: number;
  tileset?: 'mesh' | 'imported';
}[] = [
  {
    id: 'globe-site-a',
    name: 'Globe site A (synthetic, open desert)',
    crs: { epsg: 32639 },
    origin: [550000, 2330000, 142],
    issues: [3, 4, 'uncertain', 'closed'],
    captures: 2,
    tileset: 'mesh',
  },
  {
    id: 'globe-site-b',
    name: 'Globe site B (synthetic, open desert)',
    crs: { epsg: 32631 },
    origin: [316542, 2589075, 386],
    issues: [2],
    captures: 1,
  },
  {
    id: 'globe-site-c',
    name: 'Globe site C (synthetic, southern hemisphere)',
    crs: { epsg: 32719 },
    origin: [500000, 7290000, 2400],
    issues: [],
    captures: 1,
  },
  {
    id: 'globe-site-d',
    name: 'Globe site D (synthetic, high plateau)',
    crs: { epsg: 32648 },
    origin: [500000, 4705000, 1100],
    issues: [5, 5],
    captures: 1,
    tileset: 'imported',
  },
  {
    id: 'globe-site-e',
    name: 'Globe site E (synthetic, open sea by the antimeridian)',
    crs: { epsg: 32760 },
    origin: [802000, 7787000, 5],
    issues: [],
    captures: 1,
  },
  {
    id: 'globe-site-f',
    name: 'Globe site F (synthetic, local grid only)',
    crs: { wkt: 'LOCAL_CS["Synthetic local grid",UNIT["metre",1]]' },
    origin: [0, 0, 0],
    issues: [1],
    captures: 1,
  },
];

const lonLatOf = (crs: Crs, origin: Vec3): [number, number] | null => {
  if (!('epsg' in crs)) return null;
  const [lon, lat] = toWgs84(origin, crs.epsg);
  return [lon, lat];
};

/** The sites of the globe library, with where each belongs on the Earth. */
export const GLOBE_SITES: GlobeSiteFixture[] = SITE_DEFS.map((d) => {
  const open = d.issues.filter((s) => s !== 'closed');
  const bySeverity: Record<string, number> = {};
  for (const s of open) bySeverity[String(s)] = (bySeverity[String(s)] ?? 0) + 1;
  return {
    id: d.id,
    name: d.name,
    crs: d.crs,
    origin: d.origin,
    lonLat: lonLatOf(d.crs, d.origin),
    captures: d.captures,
    openIssues: open.length,
    bySeverity,
    tilesets: d.tileset ? [{ id: `${d.id}-tiles`, kind: d.tileset }] : [],
  };
});

/** ECEF of a WGS 84 position (degrees, ellipsoidal metres). */
function ecefOf(lon: number, lat: number, h: number): Vec3 {
  const a = 6378137;
  const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
  const r = Math.PI / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat * r) ** 2);
  return [
    (n + h) * Math.cos(lat * r) * Math.cos(lon * r),
    (n + h) * Math.cos(lat * r) * Math.sin(lon * r),
    (n * (1 - e2) + h) * Math.sin(lat * r),
  ];
}

/** A one-tile 3D Tiles 1.1 tileset: `content` (glTF, Y up) in east-north-up at [lon, lat, h]. */
export function enuTileset(lon: number, lat: number, h: number, content: string, halfM = 5) {
  const r = Math.PI / 180;
  const [sl, cl, sp, cp] = [
    Math.sin(lon * r),
    Math.cos(lon * r),
    Math.sin(lat * r),
    Math.cos(lat * r),
  ];
  const o = ecefOf(lon, lat, h);
  return {
    asset: { version: '1.1', generator: 'Stratlas e2e fixture' },
    geometricError: 20,
    root: {
      transform: [-sl, cl, 0, 0, -sp * cl, -sp * sl, cp, 0, cp * cl, cp * sl, sp, 0, ...o, 1],
      boundingVolume: { box: [0, 0, 0, halfM, 0, 0, 0, halfM, 0, 0, 0, halfM] },
      geometricError: 0,
      refine: 'REPLACE',
      content: { uri: content },
    },
  };
}

const SEVERITY_MODEL = {
  id: 'general',
  name: 'General (synthetic)',
  levels: [1, 2, 3, 4, 5].map((v) => ({
    value: v,
    label: `Level ${String(v)}`,
    color: ['#2e7d32', '#9e9d24', '#f9a825', '#ef6c00', '#c62828'][v - 1] ?? '#000000',
    criteria: `Synthetic level ${String(v)}`,
  })),
  uncertain: { label: 'Uncertain', color: '#757575' },
};

export interface GlobeLibrary {
  sites: GlobeSiteFixture[];
  imagery: RasterPackMetaT[];
  terrain: RasterPackMetaT[];
  benchmark: TerrainBenchmark;
}

/**
 * Write the globe library into a data root: six projects (five placed around the Earth, one in a
 * local grid that cannot be placed), with issues, captures and two tilesets; the imagery packs
 * `synthetic-world` (z0 to 3) and `synthetic-site-a` (z12 to 15 around site A); and the terrain
 * pack `synthetic-terrain-a` (z8 to 12 around site A, EGM2008, with a benchmark height).
 */
export async function createGlobeLibrary(dataRoot: string, glb: Buffer): Promise<GlobeLibrary> {
  for (const [k, s] of GLOBE_SITES.entries()) {
    const d = SITE_DEFS[k];
    if (!d) continue;
    const dir = join(dataRoot, 'projects', s.id);
    await mkdir(join(dir, 'models'), { recursive: true });
    await writeFile(join(dir, 'models', 'quad.glb'), glb);
    const captures = Array.from({ length: d.captures }, (_, i) => ({
      id: `c${String(i + 1)}`,
      label: `Survey ${String(i + 1)}`,
      date: `2026-0${String(i + 3)}-14`,
    }));
    const input: ProjectManifestInput = {
      schema: SCHEMA_VERSION,
      id: s.id,
      name: s.name,
      customer: 'Synthetic customer (fictional)',
      site: 'Synthetic globe fixture',
      crs: s.crs,
      origin: s.origin,
      captures,
      layers: [
        {
          kind: 'mesh',
          id: 'site-model',
          name: 'Site model',
          src: { path: 'models/quad.glb' },
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      ],
      severityModels: [SEVERITY_MODEL],
      classCatalogues: [
        {
          id: 'general',
          name: 'General',
          assetType: 'general',
          classes: [{ id: 'damage', label: 'Damage', color: '#c62828', severityModel: 'general' }],
        },
      ],
    };
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify(ProjectManifest.parse(input), null, 2),
    );
    const issues = d.issues.map((sev, i) => ({
      id: `issue-${String(i + 1)}`,
      code: `F${String(i + 1).padStart(2, '0')}`,
      classId: 'damage',
      severityModelId: 'general',
      severity: sev === 'closed' ? 2 : sev,
      status: sev === 'closed' ? 'closed' : i % 2 ? 'draft' : 'reviewed',
      title: `Synthetic finding ${String(i + 1)}`,
      note: '',
      author: 'E2E',
      createdAt: '2026-03-14T10:00:00.000Z',
      updatedAt: '2026-03-14T10:00:00.000Z',
      sightings: [
        {
          on: 'mesh',
          layer: 'site-model',
          geom: { type: 'spoint', p: [0.5, 0, -0.5], n: [0, 1, 0] },
        },
      ],
      source: 'human',
      capture: 'c1',
    }));
    await writeFile(
      join(dir, 'issues.json'),
      JSON.stringify({ schema: 'aio.issues/1', issues }, null, 2),
    );
    if (d.tileset && s.lonLat) {
      const tid = `${s.id}-tiles`;
      await mkdir(join(dir, 'tiles', tid), { recursive: true });
      await writeFile(join(dir, 'tiles', tid, 'quad.glb'), glb);
      await writeFile(
        join(dir, 'tiles', tid, 'tileset.json'),
        JSON.stringify(enuTileset(s.lonLat[0], s.lonLat[1], s.origin[2], 'quad.glb'), null, 2),
      );
      const file = TilesetsFile.parse({
        schema: 'aio.tilesets/1',
        entries: [
          {
            id: tid,
            name: d.tileset === 'mesh' ? 'Site mesh tiles' : 'Imported tiles (synthetic)',
            kind: d.tileset,
            src: `tiles/${tid}/tileset.json`,
            visible: true,
            ...(d.tileset === 'imported'
              ? {
                  confirmedAt: '2026-03-14T10:00:00.000Z',
                  attribution: 'Synthetic test tiles (CC0 test fixture)',
                }
              : {}),
          },
        ],
      });
      await writeFile(join(dir, 'tilesets.json'), JSON.stringify(file, null, 2));
    }
  }
  const a = GLOBE_SITES[0]?.lonLat ?? [0, 0];
  const world = imageryPack({
    id: 'synthetic-world',
    label: 'Synthetic world (test)',
    bbox: [-180, -85, 180, 85],
    minZoom: 0,
    maxZoom: 3,
  });
  const site = imageryPack({
    id: 'synthetic-site-a',
    label: 'Synthetic imagery, site A (test)',
    bbox: [a[0] - 0.02, a[1] - 0.02, a[0] + 0.02, a[1] + 0.02],
    minZoom: 12,
    maxZoom: 15,
  });
  const terrain = terrainPack({
    id: 'synthetic-terrain-a',
    label: 'Synthetic terrain, site A (test)',
    bbox: [a[0] - 0.05, a[1] - 0.05, a[0] + 0.05, a[1] + 0.05],
    minZoom: 8,
    maxZoom: 12,
    near: a,
  });
  for (const p of [world, site, terrain]) await writeRasterPack(dataRoot, p);
  return {
    sites: GLOBE_SITES,
    imagery: [world.meta, site.meta],
    terrain: [terrain.meta],
    benchmark: terrain.benchmark,
  };
}
