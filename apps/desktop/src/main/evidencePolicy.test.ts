import { writeManifestFile } from '@aio/project/builder';
import type { ProjectManifest } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evidencePolicy } from './evidencePolicy';

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'site',
  name: 'Synthetic site',
  crs: { epsg: 32640 },
  origin: [400000, 2800000, 0],
  captures: [{ id: 'c1', label: 'First', date: '2026-01-10' }],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

let dir = '';
let root = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quadrion-evidence-'));
  root = join(dir, 'site');
  await mkdir(root);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('evidencePolicy', () => {
  it('is off for photos and scans when the flags are absent', async () => {
    await writeManifestFile(root, manifest);
    expect(await evidencePolicy(root)).toEqual({ ai: 'allow', photos: false, scans: false });
  });

  it('reads each flag on its own, from the file on disk', async () => {
    await writeManifestFile(root, { ...manifest, aiCloudPhotos: true });
    expect(await evidencePolicy(root)).toEqual({ ai: 'allow', photos: true, scans: false });
    await writeManifestFile(root, { ...manifest, aiCloudScans: true });
    expect(await evidencePolicy(root)).toEqual({ ai: 'allow', photos: false, scans: true });
  });

  it('drawing consent does not allow photos or scans', async () => {
    await writeManifestFile(root, { ...manifest, aiCloudDrawings: true });
    expect(await evidencePolicy(root)).toEqual({ ai: 'allow', photos: false, scans: false });
  });

  it('a package that forbids cloud AI forbids, whatever the flags say', async () => {
    await writeManifestFile(root, { ...manifest, aiCloudPhotos: true, aiCloudScans: true });
    const raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as object;
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...raw, aiPolicy: 'forbid' }));
    expect(await evidencePolicy(root)).toMatchObject({ ai: 'forbid' });
  });

  it('refuses everything when the manifest cannot be read', async () => {
    await writeFile(join(root, 'manifest.json'), '{"aiCloudPhotos": true, broken');
    expect(await evidencePolicy(root)).toEqual({ ai: 'allow', photos: false, scans: false });
    expect(await evidencePolicy(join(dir, 'missing'))).toEqual({
      ai: 'allow',
      photos: false,
      scans: false,
    });
  });

  it('a flag that is not exactly true is off', async () => {
    await writeManifestFile(root, manifest);
    const raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as object;
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({ ...raw, aiCloudPhotos: 'yes', aiCloudScans: 1 }),
    );
    expect(await evidencePolicy(root)).toMatchObject({ photos: false, scans: false });
  });
});
