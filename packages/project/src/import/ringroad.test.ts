import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromWgs84 } from '@aio/geo';
import { parseManifest, type Issue } from '@aio/schema';
import { importRingroad } from './ringroad';
import { SRC_TILE, worldPx } from './ringroad-tiles';

const UTM38 = 32638;
const DOT: [number, number] = [47.9941911, 29.3854794];

let dir = '';
const src = () => join(dir, 'src');
const out = () => join(dir, 'out');
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(out(), rel), 'utf8'));
const put = (rel: string, data: string | Uint8Array) => {
  const p = join(src(), rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};

async function greyTile(dot?: [number, number]): Promise<string> {
  const px = Buffer.alloc(SRC_TILE * SRC_TILE * 4);
  for (let i = 0; i < SRC_TILE * SRC_TILE; i++) px.set([70 + (i % 37), 70, 60, 255], i * 4);
  if (dot) px.set([255, 255, 255, 255], (dot[1] * SRC_TILE + dot[0]) * 4);
  const b = await sharp(px, { raw: { width: SRC_TILE, height: SRC_TILE, channels: 4 } })
    .webp({ quality: 90 })
    .toBuffer();
  return b.toString('base64');
}

/** A miniature road review: two defects, one close-up, one z18 bundle with z21 and z22 tiles. */
async function buildSource() {
  const tiles: Record<string, string> = {};
  const [x18, y18] = worldPx(DOT[0], DOT[1], 18).map((v) => Math.floor(v / SRC_TILE)) as [
    number,
    number,
  ];
  tiles[`18/${x18}/${y18}`] = await greyTile();
  for (const z of [21, 22]) {
    const [x, y] = worldPx(DOT[0], DOT[1], z).map((v) => Math.floor(v / SRC_TILE)) as [
      number,
      number,
    ];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) tiles[`${z}/${x + dx}/${y + dy}`] = await greyTile();
  }
  put('ortho/index.js', `window.RR_ORTHO_INDEX=${JSON.stringify({ '18': [[x18, y18]] })};`);
  put(`ortho/b18/${x18}_${y18}.js`, `RRT("18/${x18}/${y18}",${JSON.stringify(tiles)});`);

  const [e, n] = fromWgs84([DOT[0], DOT[1], 0], UTM38);
  const ring = (dx: number) => [
    [DOT[0] + dx, DOT[1]],
    [DOT[0] + dx + 0.00002, DOT[1]],
    [DOT[0] + dx + 0.00002, DOT[1] + 0.00002],
    [DOT[0] + dx, DOT[1]],
  ];
  const row = (id: number, dx: number, stage: number) => [
    id,
    'Transverse Cracking',
    stage,
    3.2,
    40,
    8,
    1.234,
    [DOT[0] + dx, DOT[1]],
    ring(dx),
    'M100,100 900,100 900,900Z',
    [4, 4],
    2.1,
    [e, n],
  ];
  const data = {
    fields: [
      'id',
      'type',
      'stage',
      'area',
      'clusterArea',
      'pct',
      'km',
      'c',
      'g',
      'path',
      'cropWH',
      'len',
      'utm',
    ],
    rows: [row(0, 0, 3), row(1, 0.0001, 1)],
    centerline: [
      [DOT[0], DOT[1]],
      [DOT[0] + 0.001, DOT[1]],
    ],
    chainage: [0, 0.097],
    meta: { road: '1st Ring Road', gsd_cm: 1.25 },
  };
  put('data/defects.js', `window.RR_DATA=${JSON.stringify(data)};`);
  const gi = Math.floor((3254469.226646473 - n) / 15);
  const gj = Math.floor((e - 787313.5686505446) / 15);
  const grid = {
    origin: [787313.5686505446, 3254469.226646473],
    density: { '10': [[0, 1, 40, 1, 3.2, 8]] },
    pci: {
      unit_m: 15,
      coverage_pct: 99,
      road: [90, 80, 70],
      sections: [[0, 225, 90, 80, 70]],
      units: [[gi, gj, 225, [90, 80, 70], 1.2, [], [[gi, gj]]]],
    },
  };
  put('data/grid.js', `window.RR_GRID=${JSON.stringify(grid)};`);
  put('_build/crops.json', JSON.stringify([[0, e - 2, n - 2, e + 2, n + 2]]));
  put(
    'closeups/f0000.webp',
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#556677' } })
      .webp()
      .toBuffer(),
  );
  put(
    'closeups/sheet-0.jpg',
    await sharp({ create: { width: 24, height: 16, channels: 3, background: '#556677' } })
      .jpeg()
      .toBuffer(),
  );
  put('lib/leaflet.js', '/* leaflet */');
  put(
    '1st Ring Road Review.html',
    '<script src="lib/leaflet.js"></script><script src="data/defects.js"></script><script src="ortho-hd/index.js"></script>',
  );
  put('data/osm.js', 'window.RR_OSM={};');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aio-ringroad-'));
  await buildSource();
}, 60_000);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('1st Ring Road import', () => {
  it('writes a valid package with the ortho, issues, close-ups, road model and legacy viewer', async () => {
    const r = await importRingroad({ src: src(), out: out() });
    expect(r.issues).toBe(2);
    const manifest = parseManifest(JSON.parse(readFileSync(join(out(), 'manifest.json'), 'utf8')));
    if (!manifest.ok) throw new Error(manifest.error);
    const m = manifest.value;
    expect(m.crs).toEqual({ epsg: UTM38 });
    expect(m.layers.map((l) => [l.id, l.kind])).toEqual([
      ['ortho', 'raster'],
      ['closeups', 'photos'],
      ['road-review', 'legacy'],
    ]);
    const legacy = m.layers.find((l) => l.kind === 'legacy');
    expect(legacy).toMatchObject({
      viewer: 'road',
      entry: { path: 'legacy/1st Ring Road Review.html' },
    });

    const tiles = readJson('rasters/ortho/tiles.json') as {
      schema: string;
      levels: unknown[];
      corners: unknown;
    };
    expect(tiles.schema).toBe('aio.tiles/1');
    expect(tiles.levels).toHaveLength(8);
    expect(tiles.levels[7]).toMatchObject({ z: 7, tileSize: 1024, cols: 128, rows: 128 });
    const ortho = m.layers.find((l) => l.kind === 'raster');
    expect(ortho?.kind === 'raster' && ortho.corners).toEqual(tiles.corners);

    const { issues } = readJson('issues.json') as { issues: Issue[] };
    expect(issues).toHaveLength(2);
    expect(issues[0]?.severity).toBe(3);
    expect(issues[0]?.sightings.map((s) => s.on)).toEqual(['map', 'image']);
    expect(issues[1]?.sightings.map((s) => s.on)).toEqual(['map']);
    expect(existsSync(join(out(), 'photos/closeups/f0000.webp'))).toBe(true);

    const road = readJson('road.json') as { schema: string; pci: { units: unknown[] } };
    expect(road.schema).toBe('aio.road/1');
    expect(road.pci.units).toHaveLength(1);
    expect(existsSync(join(out(), 'road/pci-units.geojson'))).toBe(true);
    expect(existsSync(join(out(), 'road/centreline.geojson'))).toBe(true);

    // the viewer runs from legacy/: plain ortho tiles with the index it expects
    const idx = readFileSync(join(out(), 'legacy/ortho-hd/index.js'), 'utf8');
    expect(idx).toMatch(/^window\.RR_ORTHO_INDEX=\{"format":"files","dir":"ortho-hd"/);
    const [x22, y22] = worldPx(DOT[0], DOT[1], 22).map((v) => Math.floor(v / SRC_TILE));
    expect(existsSync(join(out(), `legacy/ortho-hd/22/${x22}/${y22}.webp`))).toBe(true);
    for (const f of [
      'legacy/1st Ring Road Review.html',
      'legacy/lib/leaflet.js',
      'legacy/data/defects.js',
      'legacy/data/grid.js',
      'legacy/closeups/f0000.webp',
      'legacy/closeups/sheet-0.jpg',
      'legacy/basemap/index.js',
      'thumbnail.jpg',
      'IMPORT-REPORT.md',
    ])
      expect(existsSync(join(out(), f)), f).toBe(true);
    // retired files of the source stay out
    expect(existsSync(join(out(), 'legacy/data/osm.js'))).toBe(false);

    const report = readFileSync(join(out(), 'IMPORT-REPORT.md'), 'utf8');
    expect(report).toContain('| Few | 1 | Low |');
    expect(report).toContain('| Extensive | 3 | High |');
    expect(report).not.toMatch(/[–—]/);
    expect(r.warnings.some((w) => w.includes('D0001'))).toBe(true);
  }, 120_000);

  it('skips everything on a re-run of an unchanged source', async () => {
    const r = await importRingroad({ src: src(), out: out() });
    expect(r.written, JSON.stringify(r)).toBe(0);
  }, 120_000);
});
