import { fromWgs84 } from '@aio/geo';
import { createProject, readManifestFile, writeManifestFile } from '@aio/project/builder';
import { xt2Visual } from '@aio/project/builder/testing';
import type { Vec3 } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POSES_BACKUP } from './photogrammetry';
import { ProjectRegistry } from './project';
import { builderRereadPhotos, refinedLayer } from './reread';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-reread-main-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const LON = 48.1352;
const LAT = 29.0276;

async function project(): Promise<string> {
  const p = fromWgs84([LON, LAT, 0], 32639);
  const { root } = await createProject(base, {
    name: 'Reread',
    type: 'inspection',
    epsg: 32639,
    origin: [Math.round(p[0]), Math.round(p[1]), 30],
    severityTemplate: null,
  });
  const m = await readManifestFile(root);
  m.layers.push({
    kind: 'photos',
    id: 'photos',
    name: 'Photos',
    visible: true,
    items: [
      {
        id: 'x-0006',
        src: { path: 'photos/x-0006.jpg' },
        takenAt: '2024-11-06T10:00:00+03:00',
        pos: [1, -46, -1],
      },
    ],
  });
  await writeManifestFile(root, m);
  await mkdir(join(root, 'photos'), { recursive: true });
  await writeFile(
    join(root, 'photos', 'x-0006.jpg'),
    xt2Visual({
      dateTimeOriginal: '2024:11:06 10:00:00',
      lat: LAT,
      lon: LON,
      absAlt: -31.5,
      relAlt: 14.7,
    }),
  );
  return root;
}

const offset: Vec3 = [0, 5, 0];

async function withEdit(root: string): Promise<void> {
  await writeFile(
    join(root, 'orientation.json'),
    JSON.stringify({
      schema: 'aio.orientation/1',
      clips: {},
      photos: { photos: { 'x-0006': { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: offset } } },
    }),
  );
}

describe('builder:rereadPhotos', () => {
  it('re-reads the layer and re-anchors the hand correction in orientation.json', async () => {
    const root = await project();
    await withEdit(root);
    const registry = new ProjectRegistry();
    const projectId = registry.register(root);
    const r = await builderRereadPhotos({ projectId, layerId: 'photos' }, registry);
    expect(r).toMatchObject({ ok: true, reread: 1, kept: 1, twins: 0, notFound: 0 });
    const item = (await readManifestFile(root)).layers
      .flatMap((l) => (l.kind === 'photos' ? l.items : []))
      .find((p) => p.id === 'x-0006');
    expect(item?.pos?.[1]).toBeCloseTo(14.7, 3);
    expect(item?.q).toBeDefined();
    const o = JSON.parse(await readFile(join(root, 'orientation.json'), 'utf8')) as {
      photos: Record<string, Record<string, { offsetM: Vec3 }>>;
    };
    const moved = o.photos.photos?.['x-0006']?.offsetM;
    // the corrected height stays at -46 + 5
    expect((item?.pos?.[1] ?? 0) + (moved?.[1] ?? 0)).toBeCloseTo(-41, 3);
  });

  it('says in a dry run that processing refined the layer, writing nothing', async () => {
    const root = await project();
    await mkdir(join(root, 'photogrammetry', 'r1'), { recursive: true });
    await writeFile(
      join(root, 'photogrammetry', 'r1', POSES_BACKUP),
      JSON.stringify({ layer: 'photos', cameras: [] }),
    );
    expect(await refinedLayer(root, 'photos')).toBe(true);
    expect(await refinedLayer(root, 'other')).toBe(false);
    const text = await readFile(join(root, 'manifest.json'), 'utf8');
    const registry = new ProjectRegistry();
    const projectId = registry.register(root);
    const r = await builderRereadPhotos({ projectId, layerId: 'photos', dryRun: true }, registry);
    expect(r).toMatchObject({ ok: true, reread: 1, refined: true });
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(text);
  });

  it('refuses a package, a project that is not open and a layer that is not photos', async () => {
    const root = await project();
    const pkg = { root: () => root, package: () => ({}) as never };
    expect(await builderRereadPhotos({ projectId: 'p', layerId: 'photos' }, pkg)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/read-only package/) as unknown,
    });
    const registry = new ProjectRegistry();
    expect(
      await builderRereadPhotos({ projectId: 'nope', layerId: 'photos' }, registry),
    ).toMatchObject({ ok: false });
    const projectId = registry.register(root);
    const r = await builderRereadPhotos({ projectId, layerId: 'none' }, registry);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/photos layer/) as unknown });
  });
});
