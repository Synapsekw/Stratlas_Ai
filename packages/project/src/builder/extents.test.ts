import { toWgs84 } from '@aio/geo';
import {
  emptyOrientation,
  shiftLocal,
  type DateShift,
  type Layer,
  type OrientationFile,
  type Vec3,
} from '@aio/schema';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { encodeGlb } from '../import/glb';
import { createProject, readManifestFile } from './create';
import {
  fullLayerExtent,
  geojsonLonLat,
  lasBounds,
  layerExtent,
  layerExtents,
  pmtilesBounds,
} from './extents';

const toWgs84Pair = ([e, n]: [number, number]): [number, number] => {
  const [lon, lat] = toWgs84([e, n, 0], 32639);
  return [lon, lat];
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-extents-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function project(): Promise<string> {
  const r = await createProject(dir, {
    name: 'Tower',
    type: 'inspection',
    epsg: 32639,
    origin: [500000, 3200000, 20],
    severityTemplate: null,
  });
  return r.root;
}

/** A 227-byte LAS header with the given bounds. */
function lasHead(min: Vec3, max: Vec3): Uint8Array {
  const b = new Uint8Array(375);
  b.set(new TextEncoder().encode('LASF'), 0);
  const v = new DataView(b.buffer);
  [max[0], min[0], max[1], min[1], max[2], min[2]].forEach((x, i) => {
    v.setFloat64(179 + i * 8, x, true);
  });
  return b;
}

it('reads LAS header bounds and refuses other files', () => {
  expect(lasBounds(lasHead([1, 2, 3], [4, 5, 6]))).toEqual({ min: [1, 2, 3], max: [4, 5, 6] });
  expect(lasBounds(new Uint8Array(400))).toBeNull();
});

it('gives each placed layer its local extent', async () => {
  const root = await project();
  await writeFile(
    join(root, 'clouds', 'c.copc.laz'),
    lasHead([530000, 3199900, 10], [530100, 3200000, 40]),
  );
  const glb = encodeGlb({
    generator: 't',
    nodes: [{ name: 'm', mesh: 0 }],
    scene: [0],
    meshes: [
      {
        name: 'm',
        primitives: [
          {
            material: 0,
            positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]),
            normals: new Float32Array(9),
            indices: new Uint32Array([0, 1, 2]),
          },
        ],
      },
    ],
    materials: [{ name: 'a' }],
    images: [],
  });
  await writeFile(join(root, 'models', 'm.glb'), glb);
  const m = await readManifestFile(root);
  m.layers.push(
    {
      kind: 'pointcloud',
      id: 'cloud-c',
      name: 'c',
      visible: true,
      src: { path: 'clouds/c.copc.laz' },
      format: 'copc',
    },
    {
      kind: 'mesh',
      id: 'mesh-m',
      name: 'm',
      visible: true,
      src: { path: 'models/m.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1],
    },
    {
      kind: 'photos',
      id: 'photos',
      name: 'P',
      visible: true,
      items: [
        { id: 'a', src: { path: 'photos/a.jpg' }, pos: [1, 2, 3] },
        { id: 'b', src: { path: 'photos/b.jpg' } },
      ],
    },
  );
  const out = await layerExtents(root, m);
  expect(out).toEqual([
    { layerId: 'cloud-c', min: [30000, -10, 0], max: [30100, 20, 100] },
    { layerId: 'mesh-m', min: [100, 0, 0], max: [102, 3, 0] },
    { layerId: 'photos', min: [1, 2, 3], max: [1, 2, 3] },
  ]);
});

it('lifts a COPC extent by its height offset', async () => {
  const root = await project();
  await writeFile(
    join(root, 'clouds', 'c.copc.laz'),
    lasHead([530000, 3199900, 10], [530100, 3200000, 40]),
  );
  await mkdir(join(root, 'clouds', 'p'), { recursive: true });
  await writeFile(
    join(root, 'clouds', 'p', 'index.json'),
    JSON.stringify({ bounds: { min: [0, 1, 2], max: [3, 4, 5] } }),
  );
  const m = await readManifestFile(root);
  const copc = (extra: object): Layer => ({
    kind: 'pointcloud',
    id: 'c',
    name: 'c',
    visible: true,
    src: { path: 'clouds/c.copc.laz' },
    format: 'copc',
    ...extra,
  });
  const packed = (extra: object): Layer => ({
    kind: 'pointcloud',
    id: 'p',
    name: 'p',
    visible: true,
    src: { path: 'clouds/p/index.json' },
    format: 'png-packed',
    ...extra,
  });
  const plain = await layerExtent(root, m, copc({}));
  const lifted = await layerExtent(root, m, copc({ heightOffsetM: 10 }));
  expect(plain && lifted).toBeTruthy();
  expect(lifted?.min[1]).toBeCloseTo((plain?.min[1] ?? 0) + 10);
  expect(lifted?.max[1]).toBeCloseTo((plain?.max[1] ?? 0) + 10);
  expect(lifted?.min[0]).toBe(plain?.min[0]);
  expect(lifted?.max[2]).toBe(plain?.max[2]);
  expect(await layerExtent(root, m, packed({ heightOffsetM: 10 }))).toEqual({
    min: [0, 11, 2],
    max: [3, 14, 5],
  });
});

const photosLayer = {
  kind: 'photos',
  id: 'ph',
  name: 'Photos',
  visible: true,
  items: [
    { id: 'a', src: { path: 'photos/ph/a.jpg' }, pos: [100, 10, -200] },
    { id: 'b', src: { path: 'photos/ph/b.jpg' }, pos: [102, 12, -198] },
    { id: 'c', src: { path: 'photos/ph/c.jpg' } },
  ],
} as unknown as Layer;

it('a photos extent reads positions with their hand corrections', async () => {
  const root = await project();
  const m = await readManifestFile(root);
  const o: OrientationFile = {
    ...emptyOrientation(),
    photos: { ph: { a: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [-100, 0, 200] } } },
  };
  expect(await layerExtent(root, m, photosLayer, null)).toEqual({
    min: [100, 10, -200],
    max: [102, 12, -198],
  });
  expect(await layerExtent(root, m, photosLayer, o)).toEqual({
    min: [0, 10, -198],
    max: [102, 12, 0],
  });
});

it('reads the bounds in a PMTiles v3 header', () => {
  const b = new Uint8Array(127);
  b.set(new TextEncoder().encode('PMTiles'), 0);
  b[7] = 3;
  const v = new DataView(b.buffer);
  [47.9, 29.3, 48.1, 29.5].forEach((d, i) => {
    v.setInt32(102 + i * 4, Math.round(d * 1e7), true);
  });
  expect(pmtilesBounds(b)).toEqual([47.9, 29.3, 48.1, 29.5]);
  expect(pmtilesBounds(new Uint8Array(127))).toBeNull();
});

it('collects lon/lat pairs from any GeoJSON geometry', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { geometry: { type: 'Point', coordinates: [1, 2] } },
      {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [3, 4],
              [5, 6, 7],
              [3, 4],
            ],
          ],
        },
      },
      { geometry: null },
    ],
  };
  expect(geojsonLonLat(fc)).toEqual([
    [1, 2],
    [3, 4],
    [5, 6],
    [3, 4],
  ]);
});

it('gives panoramas, kit pyramids and GeoJSON an extent for Properties only', async () => {
  const root = await project();
  const m = await readManifestFile(root);
  await mkdir(join(root, 'vectors'), { recursive: true });
  // 500 m east and 300 m north of the origin (EPSG 32639, origin 500000, 3200000, 20)
  const [lon, lat] = toWgs84Pair([500500, 3200300]);
  await writeFile(
    join(root, 'vectors', 'v.geojson'),
    JSON.stringify({
      type: 'FeatureCollection',
      features: [{ geometry: { type: 'Point', coordinates: [lon, lat] } }],
    }),
  );
  const vector = {
    kind: 'vector',
    id: 'v',
    name: 'V',
    visible: true,
    src: { path: 'vectors/v.geojson' },
    format: 'geojson',
  } as unknown as Layer;
  const e = await fullLayerExtent(root, m, vector, null);
  expect(e?.min[0]).toBeCloseTo(500, 1);
  expect(e?.min[2]).toBeCloseTo(-300, 1);
  const panos = {
    kind: 'panoramas',
    id: 'pn',
    name: 'P',
    visible: true,
    items: [{ id: 'x', src: { path: 'p.jpg' }, pos: [1, 2, 3], headingDeg: 0 }],
  } as unknown as Layer;
  expect(await fullLayerExtent(root, m, panos, null)).toEqual({ min: [1, 2, 3], max: [1, 2, 3] });
  // a walk's extent comes from its placed path (layer:info), never from its pins
  const walk = {
    kind: 'walk',
    id: 'w',
    name: 'W',
    visible: true,
    place: { pins: [{ surface: 'drawing', at: [400, 300] }] },
  } as unknown as Layer;
  expect(await fullLayerExtent(root, m, walk, null)).toBeNull();
  // the far-content list is unchanged: no vector, no panoramas
  expect(await layerExtent(root, m, vector, null)).toBeNull();
});

it('ignores a 360 that is not placed in a panoramas extent', async () => {
  const root = await project();
  const m = await readManifestFile(root);
  const panos = {
    kind: 'panoramas',
    id: 'pn',
    name: 'P',
    visible: true,
    items: [
      { id: 'a', src: { path: 'a.jpg' }, pos: [10, 0, 0], headingDeg: 0 },
      { id: 'b', src: { path: 'b.jpg' }, headingDeg: 0 },
    ],
  } as unknown as Layer;
  expect(await fullLayerExtent(root, m, panos, null)).toEqual({ min: [10, 0, 0], max: [10, 0, 0] });
});

it('moves a dated extent by its shift', async () => {
  const root = await project();
  await writeFile(
    join(root, 'clouds', 'c.copc.laz'),
    lasHead([530000, 3199900, 10], [530100, 3200000, 40]),
  );
  const glb = encodeGlb({
    generator: 't',
    nodes: [{ name: 'm', mesh: 0 }],
    scene: [0],
    meshes: [
      {
        name: 'm',
        primitives: [
          {
            material: 0,
            positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]),
            normals: new Float32Array(9),
            indices: new Uint32Array([0, 1, 2]),
          },
        ],
      },
    ],
    materials: [{ name: 'a' }],
    images: [],
  });
  await writeFile(join(root, 'models', 'm.glb'), glb);
  const m = await readManifestFile(root);
  m.layers.push(
    {
      kind: 'pointcloud',
      id: 'cloud-c',
      name: 'c',
      visible: true,
      src: { path: 'clouds/c.copc.laz' },
      format: 'copc',
    },
    {
      kind: 'mesh',
      id: 'mesh-m',
      name: 'm',
      visible: true,
      src: { path: 'models/m.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1],
    },
    {
      kind: 'photos',
      id: 'photos',
      name: 'P',
      visible: true,
      items: [{ id: 'a', src: { path: 'photos/a.jpg' }, pos: [1, 2, 3] }],
    },
    {
      kind: 'raster',
      id: 'ras',
      name: 'R',
      visible: true,
      src: { path: 'maps/r.png' },
      role: 'ortho',
      format: 'image',
      corners: { tl: [0, 0, 0], tr: [10, 0, 0], bl: [0, 0, 20] },
    },
  );
  const s = { eastM: 3, northM: 2 };
  const shifts = { 'cloud-c': s, 'mesh-m': s, photos: s, ras: s };
  const out = await layerExtents(root, m, null, shifts);
  expect(out).toEqual([
    { layerId: 'cloud-c', min: [30003, -10, -2], max: [30103, 20, 98] },
    { layerId: 'mesh-m', min: [103, 0, -2], max: [105, 3, -2] },
    { layerId: 'photos', min: [4, 2, 1], max: [4, 2, 1] },
    { layerId: 'ras', min: [3, 0, -2], max: [13, 0, 18] },
  ]);
  // a layer with no entry does not move
  expect((await layerExtents(root, m, null, { photos: s }))[1]).toEqual({
    layerId: 'mesh-m',
    min: [100, 0, 0],
    max: [102, 3, 0],
  });
  const photoLayer = m.layers.find((l) => l.id === 'photos');
  expect(photoLayer && (await layerExtent(root, m, photoLayer, null, s))).toEqual({
    min: [4, 2, 1],
    max: [4, 2, 1],
  });
});

it('follows a 0.5 degree turn', async () => {
  const root = await project();
  const m = await readManifestFile(root);
  await mkdir(join(root, 'clouds', 'q'), { recursive: true });
  await writeFile(
    join(root, 'clouds', 'q', 'index.json'),
    JSON.stringify({ bounds: { min: [0, 1, 0], max: [200, 3, 100] } }),
  );
  const cloud = {
    kind: 'pointcloud',
    id: 'q',
    name: 'q',
    visible: true,
    src: { path: 'clouds/q/index.json' },
    format: 'png-packed',
  } as unknown as Layer;
  const s: DateShift = {
    eastM: 1,
    northM: 0,
    turn: { rotationDeg: 0.5, scale: 1, pivotE: 0, pivotN: 0, pivotX: 0, pivotZ: 0 },
  };
  const e = await fullLayerExtent(root, m, cloud, null, s);
  const pts = [
    [0, 0],
    [200, 0],
    [0, 100],
    [200, 100],
  ].map(([x = 0, z = 0]) => shiftLocal([x, 0, z], s));
  expect(e?.min[0]).toBeCloseTo(Math.min(...pts.map((p) => p[0])), 9);
  expect(e?.max[0]).toBeCloseTo(Math.max(...pts.map((p) => p[0])), 9);
  expect(e?.min[2]).toBeCloseTo(Math.min(...pts.map((p) => p[2])), 9);
  expect(e?.max[2]).toBeCloseTo(Math.max(...pts.map((p) => p[2])), 9);
  expect([e?.min[1], e?.max[1]]).toEqual([1, 3]);
});

/** A kit-pyramid ortho as an ODM import writes it: no manifest corners, its `tiles.json` has them. */
async function kitOrtho(root: string, id: string): Promise<Layer> {
  await mkdir(join(root, 'rasters', id), { recursive: true });
  await writeFile(
    join(root, 'rasters', id, 'tiles.json'),
    JSON.stringify({
      schema: 'aio.tiles/1',
      levels: [{ z: 0, tileSize: 256, cols: 2, rows: 2, pattern: `rasters/${id}/0/{x}_{y}.webp` }],
      corners: { tl: [10, -5, -40], tr: [110, -5, -40], bl: [10, -5, 60] },
      crs: { epsg: 32639 },
      topLeft: [500010, 3200040],
      metresPerPx: [0.5],
    }),
  );
  return {
    kind: 'raster',
    id,
    name: id,
    visible: true,
    src: { path: `rasters/${id}/tiles.json` },
    role: 'ortho',
    format: 'kit-pyramid',
  } as unknown as Layer;
}

it('reads a kit pyramid whose corners are only in tiles.json, when asked for full extents', async () => {
  const root = await project();
  const m = await readManifestFile(root);
  m.layers.push(await kitOrtho(root, 'ortho-a'));
  // the far-content check keeps the kinds it always saw
  expect(await layerExtents(root, m)).toEqual([]);
  // the line-up step reads every placed raster, a lined-up date moved by its shift
  const s = { eastM: 3, northM: 2 };
  expect(await layerExtents(root, m, null, { 'ortho-a': s }, { full: true })).toEqual([
    { layerId: 'ortho-a', min: [13, -5, -42], max: [113, -5, 58] },
  ]);
});

it('reads no layer file that lies outside the project', async () => {
  const root = await project();
  const outside = join(dir, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(
    join(outside, 'index.json'),
    JSON.stringify({ bounds: { min: [0, 1, 2], max: [3, 4, 5] } }),
  );
  await symlink(outside, join(root, 'escape'), 'junction');
  const m = await readManifestFile(root);
  const packed = (path: string): Layer => ({
    kind: 'pointcloud',
    id: 'p',
    name: 'p',
    visible: true,
    src: { path },
    format: 'png-packed',
  });
  expect(await layerExtent(root, m, packed('escape/index.json'))).toBeNull();
  expect(await layerExtent(root, m, packed('../outside/index.json'))).toBeNull();
});
