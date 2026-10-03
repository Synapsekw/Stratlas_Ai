// Test helpers for main-process unit tests. Not imported by production code.
import type { Issue, ProjectManifestInput } from '@aio/schema';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function sampleManifest(
  overrides: Partial<ProjectManifestInput> = {},
): ProjectManifestInput {
  return {
    schema: 'aio.project/1',
    id: 'alzour',
    name: 'Al-Zour LNG Terminal',
    customer: 'KIPIC',
    site: 'Al-Zour',
    crs: { epsg: 32639 },
    origin: [245884.9, 3179597.1, 0],
    captures: [
      { id: 'c1', label: 'Survey', date: '2023-02-21' },
      { id: 'c2', label: 'Resurvey', date: '2024-01-10' },
    ],
    layers: [
      {
        kind: 'mesh',
        id: 'plant',
        name: 'Plant model',
        visible: true,
        src: { path: 'models/plant.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      {
        kind: 'video',
        id: 'dji0789',
        name: 'DJI_0789',
        visible: true,
        src: { path: 'video/DJI_0789.mp4' },
        flight: { src: { path: 'flights/DJI_0789.json' }, startUtcMs: 1676970000000 },
        lens: { model: 'pinhole', hfovDeg: 82, aspect: 16 / 9 },
        offsetMs: 0,
      },
      {
        kind: 'video',
        id: 'dji0790',
        name: 'DJI_0790',
        visible: true,
        src: { path: 'video/DJI_0790.mp4' },
        flight: { src: { path: 'flights/DJI_0790.json' }, startUtcMs: 1676970000000 },
        lens: { model: 'pinhole', hfovDeg: 82, aspect: 16 / 9 },
        offsetMs: 0,
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Severity 1 to 5',
        levels: [
          { value: 1, label: 'Observation', color: '#8a94a6', criteria: 'No action' },
          { value: 3, label: 'Moderate', color: '#e8c547', criteria: 'Monitor' },
          { value: 5, label: 'Critical', color: '#e5484d', criteria: 'Repair now' },
        ],
      },
    ],
    classCatalogues: [],
    ...overrides,
  };
}

export function sampleIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    code: 'F01',
    classId: 'coating',
    severityModelId: 'sev',
    severity: 3,
    status: 'draft',
    title: 'Coating breakdown',
    note: '',
    author: 'reviewer',
    createdAt: '2026-10-03T10:00:00+03:00',
    updatedAt: '2026-10-03T10:00:00+03:00',
    sightings: [
      { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 } },
    ],
    source: 'human',
    ...overrides,
  };
}

/** Write a native project folder with a manifest and optional extra files. */
export async function writeProject(
  dir: string,
  manifest: unknown = sampleManifest(),
  files: Record<string, string> = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, body);
  }
  return dir;
}
