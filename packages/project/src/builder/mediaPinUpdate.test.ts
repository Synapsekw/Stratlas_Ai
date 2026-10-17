import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createProject, updateLayers } from './create';
import { readManifestFile, updateManifestFile } from './manifestFile';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-mediapin-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function withPhotos(): Promise<string> {
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
          kind: 'photos',
          id: 'photos-1',
          name: 'Photos',
          visible: true,
          items: [{ id: 'a', src: { path: 'photos/a.jpg' } }],
        },
        {
          kind: 'photos',
          id: 'photos-2',
          name: 'More',
          visible: true,
          items: [{ id: 'b', src: { path: 'photos/b.jpg' } }],
        },
      ],
    },
  }));
  return root;
}

it('pins a photo through updateLayers, writing the manifest and a backup', async () => {
  const root = await withPhotos();
  const r = await updateLayers(root, ['photos-1'], {
    mediaPin: { itemId: 'a', pin: { ground: [1, 0, 2], eyeM: 1.6, headingDeg: 90 } },
  });
  expect(r.backup).toBeTruthy();
  const saved = await readManifestFile(root);
  const layer = saved.layers.find((l) => l.id === 'photos-1');
  expect(layer?.kind === 'photos' && layer.items[0]?.pos).toEqual([1, 1.6, 2]);
  expect((await readdir(root, { recursive: true })).length).toBeGreaterThan(0);
});

it('refuses more than one layer at a time', async () => {
  const root = await withPhotos();
  await expect(
    updateLayers(root, ['photos-1', 'photos-2'], { mediaPin: { itemId: 'a', pin: null } }),
  ).rejects.toThrow(/one item at a time/);
});
