import type { SeverityModel } from '@aio/schema';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builderAddSeverityModel } from './builder';
import { ProjectRegistry } from './project';
import { sampleManifest, writeProject } from './testing';

const coating: SeverityModel = {
  id: 'coating',
  name: 'Coating',
  levels: [
    { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Monitor' },
    { value: 2, label: 'Severe', color: '#f05653', criteria: 'Act' },
  ],
};

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-builder-severity-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('builder:addSeverityModel', () => {
  it('appends a scale on an open project', async () => {
    const dir = await writeProject(join(base, 'projects', 'p'), sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    const r = await builderAddSeverityModel({ projectId, model: coating }, registry);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.severityModels.map((s) => s.id)).toEqual(['sev', 'coating']);
    const disk = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      severityModels: { id: string }[];
    };
    expect(disk.severityModels.map((s) => s.id)).toEqual(['sev', 'coating']);
  });

  it('refuses a closed project and a duplicate name', async () => {
    const dir = await writeProject(join(base, 'projects', 'p'), sampleManifest());
    const registry = new ProjectRegistry();
    const projectId = registry.register(dir);
    expect(await builderAddSeverityModel({ projectId: 'x', model: coating }, registry)).toEqual({
      ok: false,
      error: 'Project "x" is not open. Open it, then save again.',
    });
    const dup = await builderAddSeverityModel(
      { projectId, model: { ...coating, id: 'other', name: 'Severity 1 to 5' } },
      registry,
    );
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.error).toMatch(/already exists/);
  });
});
