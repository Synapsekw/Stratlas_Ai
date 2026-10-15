import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builderUpdateClasses } from './builder';
import { ProjectRegistry } from './project';
import { sampleManifest, writeProject } from './testing';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-builder-classes-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('builder:updateClasses', () => {
  it('writes the catalogues of an open project and returns the new manifest', async () => {
    const dir = await writeProject(join(base, 'projects', 'p'), sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const catalogues = [
      {
        id: 'classes',
        name: 'Classes',
        assetType: 'asset',
        classes: [{ id: 'spalling', label: 'Spalling', color: '#7cc46b', severityModel: 'sev' }],
      },
    ];
    const r = await builderUpdateClasses({ projectId, catalogues }, registry);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.classCatalogues).toEqual(catalogues);
    const disk = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      classCatalogues: unknown;
    };
    expect(disk.classCatalogues).toEqual(catalogues);
  });

  it('refuses a closed project and an invalid set, with the reason', async () => {
    const dir = await writeProject(join(base, 'projects', 'p'), sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    expect(await builderUpdateClasses({ projectId: 'x', catalogues: [] }, registry)).toEqual({
      ok: false,
      error: 'Project "x" is not open. Open it, then save again.',
    });
    const bad = await builderUpdateClasses(
      {
        projectId,
        catalogues: [
          {
            id: 'c',
            name: 'C',
            assetType: 'asset',
            classes: [{ id: 'k', label: 'K', color: '#000000', severityModel: 'nope' }],
          },
        ],
      },
      registry,
    );
    expect(bad).toEqual({
      ok: false,
      error: expect.stringMatching(/severity model "nope"/) as string,
    });
  });
});
