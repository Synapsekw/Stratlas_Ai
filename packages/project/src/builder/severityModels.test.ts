import type { ProjectManifest, SeverityModel } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSeverityModel, addedModelProblem } from './severityModels';

const manifest = (): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [
    {
      id: 'sev',
      name: 'Severity',
      levels: [{ value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Monitor' }],
    },
  ],
  classCatalogues: [],
});

const coating: SeverityModel = {
  id: 'coating',
  name: 'Coating',
  levels: [
    { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Monitor' },
    { value: 2, label: 'Severe', color: '#f05653', criteria: 'Act' },
  ],
  uncertain: { label: 'Uncertain', color: '#878d93' },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-severity-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest()));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('addedModelProblem', () => {
  const m = manifest();
  it('accepts a new scale', () => {
    expect(addedModelProblem(m, coating)).toBeNull();
  });
  it('refuses a duplicate id, a duplicate name and a scale with no grades', () => {
    expect(addedModelProblem(m, { ...coating, id: 'sev' })).toMatch(/id "sev"/);
    expect(addedModelProblem(m, { ...coating, name: 'severity' })).toMatch(/named severity/);
    expect(addedModelProblem(m, { ...coating, levels: [] })).toMatch(/invalid/);
  });
});

describe('addSeverityModel', () => {
  it('appends the scale and leaves the ones already there', async () => {
    const r = await addSeverityModel(dir, coating);
    expect(r.manifest.severityModels.map((s) => s.id)).toEqual(['sev', 'coating']);
    const disk = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      severityModels: { id: string }[];
    };
    expect(disk.severityModels.map((s) => s.id)).toEqual(['sev', 'coating']);
  });

  it('writes nothing when the name is already used', async () => {
    await expect(addSeverityModel(dir, { ...coating, name: 'Severity' })).rejects.toThrow(
      /already exists/,
    );
    const disk = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      severityModels: unknown[];
    };
    expect(disk.severityModels).toHaveLength(1);
  });
});
