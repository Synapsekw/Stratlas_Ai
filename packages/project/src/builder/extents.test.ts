import { toWgs84 } from '@aio/geo';
import { emptyOrientation, type Layer, type OrientationFile, type Vec3 } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  await rm(dir, { recursive: true, force: true });
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
