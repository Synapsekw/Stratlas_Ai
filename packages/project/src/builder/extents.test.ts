import type { Vec3 } from '@aio/schema';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { encodeGlb } from '../import/glb';
import { createProject, readManifestFile } from './create';
import { lasBounds, layerExtents } from './extents';

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
