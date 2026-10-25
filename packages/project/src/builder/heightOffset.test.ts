import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createProject, updateLayers } from './create';
import { readManifestFile, updateManifestFile } from './manifestFile';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-heightoffset-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function withLayers(): Promise<string> {
  const { root } = await createProject(dir, {
    name: 'Yard',
    type: 'inspection',
    epsg: 32639,
    origin: [500000, 3200000, 0],
    severityTemplate: null,
  });
  await updateManifestFile(root, (m) => ({
    manifest: {
      ...m,
      layers: [
        {
          kind: 'pointcloud',
          id: 'c',
          name: 'Cloud',
          visible: true,
          src: { path: 'clouds/c.copc.laz' },
          format: 'copc',
        },
        {
          kind: 'pointcloud',
          id: 'p',
          name: 'Packed',
          visible: true,
          src: { path: 'clouds/p/index.json' },
          format: 'png-packed',
        },
        {
          kind: 'pointcloud',
          id: 'k',
          name: 'Kit',
          visible: true,
          src: { path: 'clouds/k.bin' },
          format: 'kit-packed',
        },
        {
          kind: 'vector',
          id: 'v',
          name: 'Outline',
          visible: true,
          src: { path: 'vectors/v.geojson' },
          format: 'geojson',
        },
      ],
    },
  }));
  return root;
}

it('sets, rounds and clears a cloud height offset', async () => {
  const root = await withLayers();
  const before = await readManifestFile(root);
  const set = await updateLayers(root, ['c', 'p'], { heightOffsetM: 12.34567 });
  for (const i of [0, 1]) expect(set.manifest.layers[i]).toMatchObject({ heightOffsetM: 12.346 });
  expect(set.manifest.layers[0]).toEqual({ ...before.layers[0], heightOffsetM: 12.346 });
  expect(set.manifest.layers[2]).toEqual(before.layers[2]);
  expect(set.manifest.layers[3]).toEqual(before.layers[3]);

  const nulled = await updateLayers(root, ['c'], { heightOffsetM: null });
  expect(nulled.manifest.layers[0]).toEqual(before.layers[0]);
  expect('heightOffsetM' in (nulled.manifest.layers[0] ?? {})).toBe(false);

  const zeroed = await updateLayers(root, ['p'], { heightOffsetM: 0 });
  expect(zeroed.manifest.layers[1]).toEqual(before.layers[1]);
  expect('heightOffsetM' in (zeroed.manifest.layers[1] ?? {})).toBe(false);
});

it('refuses a height offset on a model and on a kit-packed cloud', async () => {
  const root = await withLayers();
  await expect(updateLayers(root, ['v'], { heightOffsetM: 3 })).rejects.toThrow(
    '"Outline" is not a point cloud or a walk; only those take a height offset.',
  );
  await expect(updateLayers(root, ['k'], { heightOffsetM: 3 })).rejects.toThrow(
    '"Kit" is a kit-packed cloud, which cannot be moved.',
  );
});
