import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createProject, updateLayers } from './create';
import { readManifestFile, updateManifestFile } from './manifestFile';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-rename-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('renames a layer of any kind, keeping everything else, with a backup', async () => {
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
          kind: 'vector',
          id: 'v',
          name: 'Old',
          visible: true,
          capture: undefined,
          src: { path: 'vectors/v.geojson' },
          format: 'geojson',
        },
      ],
    },
  }));
  const before = await readManifestFile(root);
  const r = await updateLayers(root, ['v'], { name: '  Site outline ' });
  expect(r.manifest.layers[0]).toEqual({ ...before.layers[0], name: 'Site outline' });
  expect(await readFile(r.backup, 'utf8')).toContain('"Old"');
  await expect(updateLayers(root, ['nope'], { name: 'x' })).rejects.toThrow('not in this project');
});
