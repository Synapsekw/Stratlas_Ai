import { ProjectManifest } from '@aio/schema';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGlobeLibrary, GLOBE_SITES } from '../../e2e/m10Fixtures';

// The e2e globe library is shared by several specs (basemap picker, fixtures, Globe). Its
// processed rasters draw in site A's map and 3D views too, so only the spec that needs them
// asks for them; every other spec keeps the site as it was.
// createGlobeLibrary writes six projects and three raster packs, which takes seconds on a CI
// runner, so these tests get 30 s instead of the 5 s default.
const SLOW = { timeout: 30_000 };

describe('the e2e globe library', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aio-globe-fixture-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function siteALayers() {
    const first = GLOBE_SITES[0];
    if (!first) throw new Error('no globe sites');
    const raw = await readFile(join(root, 'projects', first.id, 'manifest.json'), 'utf8');
    return ProjectManifest.parse(JSON.parse(raw)).layers;
  }

  it('gives site A no processed rasters unless asked', SLOW, async () => {
    await createGlobeLibrary(root, Buffer.from('glb'));
    expect((await siteALayers()).filter((l) => l.kind === 'raster')).toEqual([]);
  });

  it('writes two orthos and a surface heat map (role plan) when asked', SLOW, async () => {
    await createGlobeLibrary(root, Buffer.from('glb'), { siteRasters: true });
    const rasters = (await siteALayers()).flatMap((l) =>
      l.kind === 'raster' ? [{ id: l.id, role: l.role, change: l.derived?.kind === 'change' }] : [],
    );
    expect(rasters).toEqual([
      { id: 'ortho-c1', role: 'ortho', change: false },
      { id: 'ortho-c2', role: 'ortho', change: false },
      { id: 'heat', role: 'plan', change: true },
    ]);
  });
});
