import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, readManifestFile, writeManifestFile } from '../create';
import { removeEmptyInspectorSpaces } from './emptySpaces';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inspector-spaces-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const space = (id: string, inspectionId: string) => ({
  id,
  name: id,
  crs: { local: 'flyability' },
  origin: [0, 0, 0] as [number, number, number],
  source: { kind: 'flyability' as const, inspectionId },
});

describe('removeEmptyInspectorSpaces', () => {
  it('removes the Inspector spaces no layer is in, except those still to be imported', async () => {
    const { root } = await createProject(dir, {
      name: 'P',
      type: 'inspection',
      epsg: 4326,
      origin: [0, 0, 0],
      severityTemplate: null,
    });
    const m = await readManifestFile(root);
    await writeManifestFile(root, {
      ...m,
      spaces: [space('fly-a', 'a'), space('fly-b', 'b'), space('fly-c', 'c')],
      layers: [
        ...m.layers,
        { kind: 'photos', id: 'fly-a-photos', name: 'A', visible: true, items: [], space: 'fly-a' },
      ],
    });
    // b is empty: gone; c is empty but its import still waits: kept
    expect(await removeEmptyInspectorSpaces(root, new Set(['c']))).toEqual(['fly-b']);
    expect((await readManifestFile(root)).spaces?.map((s) => s.id)).toEqual(['fly-a', 'fly-c']);
    // nothing to remove: no write
    expect(await removeEmptyInspectorSpaces(root, new Set(['c']))).toEqual([]);
    expect(await removeEmptyInspectorSpaces(join(dir, 'gone'), new Set())).toEqual([]);
  });
});
