import { withExif } from '@aio/project/builder/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builderTemplates, builderUpdateLayers, createBuilderProject, photoGps } from './builder';
import { ProjectRegistry } from './project';
import { sampleManifest, writeProject } from './testing';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-builder-main-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const request = {
  name: 'New flare',
  type: 'inspection' as const,
  epsg: 32639,
  origin: [221029, 3214462, 31.7] as [number, number, number],
  severityTemplate: null,
};

describe('builder main handlers', () => {
  it('offers the severity models of the library projects and the report brands', async () => {
    await writeProject(join(base, 'projects', 'hcl'), sampleManifest());
    const t = await builderTemplates(base, []);
    expect(t.severity.map((s) => s.id)).toContain(sampleManifest().severityModels[0]?.id);
    expect(t.severity.slice(-2).map((s) => s.id)).toEqual([
      'general-inspection',
      'road-astm-d6433',
    ]);
    expect(t.brands.map((b) => b.id)).toContain('eand');
  });

  it('creates a project in the data folder from a template id, and refuses unknown ids', async () => {
    await writeProject(join(base, 'projects', 'hcl'), sampleManifest());
    const id = sampleManifest().severityModels[0]?.id ?? '';
    const ok = await createBuilderProject({ ...request, severityTemplate: id }, base, []);
    expect(ok).toMatchObject({ ok: true, path: join(base, 'projects', 'new-flare') });
    expect(ok.ok && ok.manifest.severityModels[0]?.id).toBe(id);
    const bad = await createBuilderProject({ ...request, severityTemplate: 'nope' }, base, []);
    expect(bad).toMatchObject({ ok: false });
    expect(await createBuilderProject(request, '', [])).toMatchObject({ ok: false });
  });

  it('reads the GPS position of a photo, or says it has none', async () => {
    const a = join(base, 'a.jpg');
    await writeFile(
      a,
      withExif({ lat: 29.0276, lon: 48.1352, alt: 31.7, dateTimeOriginal: '2019:01:24 11:45:58' }),
    );
    const r = await photoGps(a);
    expect(r).toMatchObject({ ok: true, takenAt: '2019-01-24T11:45:58' });
    expect(r.ok && r.lat).toBeCloseTo(29.0276, 6);
    const b = join(base, 'b.jpg');
    await writeFile(b, withExif({ make: 'X' }));
    expect(await photoGps(b)).toMatchObject({ ok: false });
  });

  it('only saves alignments to open projects', async () => {
    const r = await builderUpdateLayers(
      { projectId: 'x', layerIds: ['m'], patch: { offsetMs: 1 } },
      new ProjectRegistry(),
    );
    expect(r).toMatchObject({ ok: false });
  });
});
