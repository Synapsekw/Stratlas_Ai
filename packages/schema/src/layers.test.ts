import { describe, expect, it } from 'vitest';
import { LayerPatch } from './builder';
import { Layer } from './layers';
import { parseManifest } from './manifest';

const georef = {
  schema: 'aio.georef/1',
  crs: { epsg: 32633 },
  anchor: [400000, 5600000, 10],
  axes: 'x-east,y-up,z-south',
  units: 'm',
  modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 400000, 5600000, 10, 1],
  heading: { deg: 0, status: 'assumed-grid' },
  scale: { factor: 1, status: 'provisional' },
  horizontal: { status: 'from-source' },
  vertical: { datum: 'unknown', status: 'unknown' },
  provenance: { by: 'compat' },
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('mesh layer georef and placement', () => {
  it('parses a mesh layer with georef and placement needed', () => {
    const r = Layer.safeParse({
      kind: 'mesh',
      id: 'm1',
      name: 'Model',
      src: { path: 'a.glb' },
      transform: identity,
      georef,
      placement: 'needed',
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === 'mesh') expect(r.data.placement).toBe('needed');
  });
  it('refuses an unknown placement value on a mesh layer', () => {
    expect(
      Layer.safeParse({
        kind: 'mesh',
        id: 'm1',
        name: 'Model',
        src: { path: 'a.glb' },
        transform: identity,
        placement: 'maybe',
      }).success,
    ).toBe(false);
  });
  it('strips placement from a pointcloud layer (layer objects are not strict)', () => {
    const r = Layer.safeParse({
      kind: 'pointcloud',
      id: 'p1',
      name: 'Cloud',
      src: { path: 'a.copc.laz' },
      format: 'copc',
      placement: 'needed',
    });
    expect(r.success).toBe(true);
    if (r.success) expect('placement' in r.data).toBe(false);
  });
  it('parses a LayerPatch with placement, and with georef', () => {
    expect(LayerPatch.safeParse({ placement: 'placed' }).success).toBe(true);
    expect(LayerPatch.safeParse({ georef, placement: 'placed' }).success).toBe(true);
    expect(LayerPatch.safeParse({}).success).toBe(false);
    expect(LayerPatch.safeParse({ placement: 'nope' }).success).toBe(false);
  });
});

describe('sharing flags', () => {
  const base = {
    schema: 'aio.project/1',
    id: 'demo',
    name: 'Demo',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [],
    layers: [],
    severityModels: [],
    classCatalogues: [],
  };
  it('reads aiCloudPhotos and aiCloudScans, and they are off when absent', () => {
    const on = parseManifest({ ...base, aiCloudPhotos: true, aiCloudScans: false });
    expect(on.ok, on.ok ? '' : on.error).toBe(true);
    expect(on.ok && on.value.aiCloudPhotos).toBe(true);
    expect(on.ok && on.value.aiCloudScans).toBe(false);
    const off = parseManifest(base);
    expect(off.ok && off.value.aiCloudPhotos).toBeUndefined();
    expect(parseManifest({ ...base, aiCloudPhotos: 'yes' }).ok).toBe(false);
  });
});
