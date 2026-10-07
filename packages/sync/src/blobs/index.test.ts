import { ProjectManifest, type BlobRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  aggregateState,
  assetPath,
  blobRefFor,
  hashFromAssetPath,
  layerFiles,
  newRegistrations,
  projectBlobIndex,
  projectCacheKey,
} from './index';

const H = (c: string) => c.repeat(64);
const DEV = `d_${'a'.repeat(52)}`;
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'synthetic',
  name: 'Synthetic',
  customer: 'Example',
  site: 'Example site',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  severityModels: [],
  classCatalogues: [],
  layers: [
    { kind: 'mesh', id: 'm', name: 'Mesh', src: { path: 'models\\plant.glb' }, transform: I4 },
    { kind: 'pointcloud', id: 'pc', name: 'Cloud', src: { hash: H('c') }, format: 'copc' },
    {
      kind: 'video',
      id: 'v',
      name: 'Clip',
      src: { path: 'video/a.mp4' },
      poster: { path: 'video/a.jpg' },
      flight: { src: { path: 'flights/a.json' }, startUtcMs: 0 },
      lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.5 },
    },
    {
      kind: 'photos',
      id: 'ph',
      name: 'Photos',
      items: [
        { id: '1', src: { path: 'photos/1.jpg' } },
        { id: '2', src: { path: 'photos/1.jpg' } },
      ],
    },
    { kind: 'basemap', id: 'b', name: 'Base', pack: 'world', style: 'dark' },
  ],
});

function op(hlcMs: number, payload: unknown, kind = 'blob.add'): Record<string, unknown> {
  return {
    v: 1,
    id: H(String(hlcMs % 10)),
    kind,
    hlc: `${String(hlcMs).padStart(13, '0')}.0000.${DEV}`,
    payload,
  };
}

describe('layer files', () => {
  it('lists every file each layer reads, with hash refs at assets/sha256', () => {
    const files = layerFiles(manifest);
    expect(files.map((f) => `${f.layer}:${f.path}`)).toEqual([
      'm:models/plant.glb',
      `pc:assets/sha256/${H('c')}`,
      'v:video/a.mp4',
      'v:video/a.jpg',
      'v:flights/a.json',
      'ph:photos/1.jpg',
    ]);
    expect(files[1]).toMatchObject({ sha256: H('c'), role: 'source' });
    expect(assetPath({ path: '/x\\y.bin' })).toEqual({ path: 'x/y.bin' });
    expect(hashFromAssetPath(`assets/sha256/${H('d')}`)).toBe(H('d'));
    expect(hashFromAssetPath('assets/sha256/zz')).toBeUndefined();
  });
});

describe('blob index from blob.add ops', () => {
  const ref = (sha: string, path = 'models/plant.glb'): BlobRef => ({
    sha256: sha,
    size: 10,
    path,
    role: 'source',
  });

  it('keeps the last registration of a path by clock, whatever the arrival order', () => {
    const ops = [op(2, ref(H('2'))), op(1, ref(H('1'))), op(3, { bad: true }), op(4, {}, 'x')];
    const a = projectBlobIndex(ops);
    const b = projectBlobIndex([...ops].reverse());
    expect(a.byPath.get('models/plant.glb')?.sha256).toBe(H('2'));
    expect([...a.byPath]).toEqual([...b.byPath]);
    expect(a.bySha.get(H('2'))?.path).toBe('models/plant.glb');
  });

  it('lets journal ops win over local registrations and finds what is new', () => {
    const index = projectBlobIndex([op(5, ref(H('5')))], [ref(H('9')), ref(H('8'), 'b.bin')]);
    expect(index.byPath.get('models/plant.glb')?.sha256).toBe(H('5'));
    expect(index.byPath.get('b.bin')?.sha256).toBe(H('8'));
    const files = layerFiles(manifest);
    const plant = files[0];
    if (!plant) throw new Error('no file');
    const next = blobRefFor(plant, { sha256: H('6'), size: 3 });
    expect(next).toEqual({
      sha256: H('6'),
      size: 3,
      path: 'models/plant.glb',
      role: 'source',
      layer: 'm',
    });
    expect(newRegistrations(index, [next, ref(H('8'), 'b.bin')])).toEqual([next]);
  });
});

describe('layer state', () => {
  it('is missing or partial before stale, streaming and present', () => {
    expect(aggregateState([])).toBe('present');
    expect(aggregateState(['present', 'missing'])).toBe('missing');
    expect(aggregateState(['missing', 'partial'])).toBe('partial');
    expect(aggregateState(['present', 'stale', 'streaming'])).toBe('stale');
    expect(aggregateState(['present', 'streaming'])).toBe('streaming');
  });

  it('keys the cache folder by the normalised project root', () => {
    expect(projectCacheKey('C:\\Data\\P1\\', 'win32')).toBe(projectCacheKey('c:/data/p1', 'win32'));
    expect(projectCacheKey('/data/P1', 'linux')).not.toBe(projectCacheKey('/data/p1', 'linux'));
    expect(projectCacheKey('/x')).toMatch(/^[a-f0-9]{16}$/);
  });
});
