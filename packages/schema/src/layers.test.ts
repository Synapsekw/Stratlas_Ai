import { describe, expect, it } from 'vitest';
import { LayerPatch } from './builder';
import { Layer, MediaPin, PanoRef, PhotoRef } from './layers';
import { parseManifest } from './manifest';

describe('point cloud height offset', () => {
  const cloud = {
    kind: 'pointcloud',
    id: 'c',
    name: 'C',
    src: { path: 'c.laz' },
    format: 'copc',
  };
  it('keeps a point cloud height offset', () => {
    expect(Layer.parse({ ...cloud, heightOffsetM: -30.81 })).toMatchObject({
      heightOffsetM: -30.81,
    });
  });
  it('refuses a height offset beyond 2000 m', () => {
    expect(Layer.safeParse({ ...cloud, heightOffsetM: 2500 }).success).toBe(false);
  });
});

describe('walk height offset', () => {
  const walk = {
    kind: 'walk',
    id: 'walk-w1',
    name: 'W',
    visible: true,
    record: { path: 'walks/w1/walk.json' },
    src: { path: 'walks/w1/playback.mp4' },
    durationS: 10,
    place: {
      pins: [{ t: 1, surface: '@model', at: [0, 0], y: 0 }],
      yawOffsetDeg: 0,
      heightM: 1.7,
      quality: 'good',
    },
  };
  it('reads a walk saved before the offset unchanged, with no offset', () => {
    const l = Layer.parse(walk);
    expect(l).toEqual(walk);
    expect('heightOffsetM' in l).toBe(false);
  });
  it('keeps a walk height offset beside its placement', () => {
    expect(Layer.parse({ ...walk, heightOffsetM: 1.25 })).toMatchObject({ heightOffsetM: 1.25 });
  });
  it('refuses a walk height offset beyond 2000 m', () => {
    expect(Layer.safeParse({ ...walk, heightOffsetM: -2500 }).success).toBe(false);
  });
});

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

describe('pinned media', () => {
  it('reads a 360 without pos (not placed)', () => {
    const r = PanoRef.safeParse({ id: 'p1', src: { path: 'panoramas/a/p1/pano.jpg' } });
    expect(r.success).toBe(true);
    expect(r.data?.pos).toBeUndefined();
    expect(r.data?.headingDeg).toBe(0);
  });
  it('defaults the eye height to 1.6 m and bounds it to 0..10', () => {
    expect(MediaPin.parse({ ground: [1, 2, 3] }).eyeM).toBe(1.6);
    expect(MediaPin.safeParse({ ground: [0, 0, 0], eyeM: 10.5 }).success).toBe(false);
    expect(MediaPin.safeParse({ ground: [0, 0, 0], eyeM: -0.1 }).success).toBe(false);
  });
  it('keeps headingDeg in [0, 360)', () => {
    expect(MediaPin.safeParse({ ground: [0, 0, 0], headingDeg: 360 }).success).toBe(false);
    expect(MediaPin.safeParse({ ground: [0, 0, 0], headingDeg: 359.9 }).success).toBe(true);
  });
  it('a later field on a pin does not refuse the item (not strict)', () => {
    expect(
      PhotoRef.safeParse({
        id: 'a',
        src: { path: 'photos/a.jpg' },
        pin: { ground: [0, 0, 0], video: { t: 3 } },
      }).success,
    ).toBe(true);
  });
});
