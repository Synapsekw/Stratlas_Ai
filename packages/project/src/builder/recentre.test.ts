import type { Vec3 } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { encodeGlb } from '../import/glb';
import { createProject, readManifestFile, writeManifestFile } from './create';
import { recentreBlockers, recentreProject } from './recentre';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-recentre-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

/** A new tower project holding a copc cloud, a model at x 100 and one placed photo. */
async function withModelAndCloud(): Promise<string> {
  const { root } = await createProject(dir, {
    name: 'Tower',
    type: 'inspection',
    epsg: 32639,
    origin: [500000, 3200000, 20],
    severityTemplate: null,
  });
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
  await writeManifestFile(root, m);
  return root;
}

it('a new project with one model and one cloud can be re-centred', async () => {
  const root = await withModelAndCloud();
  const m = await readManifestFile(root);
  expect(await recentreBlockers(root, m)).toEqual([]);
  const r = await recentreProject(root, [530050, 3199950]);
  expect(r.manifest.origin).toEqual([530050, 3199950, 20]);
  // the model stays where it was in the CRS: x 100 was E 500100, now 500100 - 530050
  const mesh = r.manifest.layers.find((l) => l.id === 'mesh-m');
  expect(mesh?.kind === 'mesh' ? mesh.transform.slice(12, 15) : []).toEqual([-29950, 0, -50]);
  // photos keep their CRS place too; the cloud (project CRS) needs nothing
  const photos = r.manifest.layers.find((l) => l.id === 'photos');
  expect(photos?.kind === 'photos' ? photos.items[0]?.pos : []).toEqual([-30049, 2, -47]);
  // and it is saved
  expect((await readManifestFile(root)).origin).toEqual([530050, 3199950, 20]);
});

it('refuses with reasons when the project holds issues or other placed files', async () => {
  const root = await withModelAndCloud();
  await writeFile(
    join(root, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [{ id: 'i1' }] }),
  );
  await mkdir(join(root, 'flights'), { recursive: true });
  await writeFile(join(root, 'flights', 'f.json'), '{}');
  const m = await readManifestFile(root);
  const b = await recentreBlockers(root, m);
  expect(b).toEqual(expect.arrayContaining(['1 issue', 'files in "flights"']));
});

it('writes nothing when refused', async () => {
  const root = await withModelAndCloud();
  await mkdir(join(root, 'survey'), { recursive: true });
  await writeFile(join(root, 'survey', 'x.json'), '{}');
  const before = await readFile(join(root, 'manifest.json'), 'utf8');
  await expect(recentreProject(root, [1, 2])).rejects.toThrow(/Re-centring is not possible/);
  expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(before);
});

it('refuses a layer of a kind a newer build wrote, which it could not shift', async () => {
  const root = await withModelAndCloud();
  const file = join(root, 'manifest.json');
  const raw = JSON.parse(await readFile(file, 'utf8')) as { layers: unknown[] };
  raw.layers.push({ kind: 'hologram', id: 'h', name: 'Future thing' });
  await writeFile(file, JSON.stringify(raw));
  const m = await readManifestFile(root);
  expect(await recentreBlockers(root, m)).toEqual(['the layer "Future thing"']);
});
