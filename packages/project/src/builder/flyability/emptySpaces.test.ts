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

const space = (id: string, inspectionId: string, pending = true) => ({
  id,
  name: id,
  crs: { local: 'flyability' },
  origin: [0, 0, 0] as [number, number, number],
  source: { kind: 'flyability' as const, inspectionId, ...(pending ? { pending: true } : {}) },
});

async function project(spaces: ReturnType<typeof space>[], filled: string[]): Promise<string> {
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
    spaces,
    layers: [
      ...m.layers,
      ...filled.map((s) => ({
        kind: 'photos' as const,
        id: `${s}-photos`,
        name: s,
        visible: true,
        items: [],
        space: s,
      })),
    ],
  });
  return root;
}

describe('removeEmptyInspectorSpaces', () => {
  it('removes the pending spaces no layer is in, except those still to be imported', async () => {
    const root = await project(
      [space('fly-a', 'a'), space('fly-b', 'b'), space('fly-c', 'c')],
      ['fly-a'],
    );
    // b is pending and empty: gone; c is empty but its import still waits: kept; a was filled
    expect(await removeEmptyInspectorSpaces(root, new Set(['c']))).toEqual({
      removed: ['fly-b'],
      changed: true,
    });
    const spaces = (await readManifestFile(root)).spaces ?? [];
    expect(spaces.map((s) => s.id)).toEqual(['fly-a', 'fly-c']);
    // a filled space is pending no more, so it is never removed after
    expect(spaces.map((s) => s.source?.pending)).toEqual([undefined, true]);
    // nothing to do: no write
    expect(await removeEmptyInspectorSpaces(root, new Set(['c']))).toEqual({
      removed: [],
      changed: false,
    });
    expect(await removeEmptyInspectorSpaces(join(dir, 'gone'), new Set())).toEqual({
      removed: [],
      changed: false,
    });
  });

  it('never removes an imported chamber the user emptied', async () => {
    const root = await project([space('fly-a', 'a', false)], []);
    expect((await removeEmptyInspectorSpaces(root, new Set())).removed).toEqual([]);
    expect((await readManifestFile(root)).spaces?.map((s) => s.id)).toEqual(['fly-a']);
  });
});
