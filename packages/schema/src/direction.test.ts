import { describe, expect, it } from 'vitest';
import { LayerPatch } from './builder';
import { DirectionKey, DirectionKeys } from './direction';
import { Layer, PhotoRef } from './layers';

const clip = {
  kind: 'video',
  id: 'clip-1',
  name: 'Clip',
  src: { path: 'video/clip-1.mp4' },
  flight: { src: { path: 'flights/clip-1.json' }, startUtcMs: 1_767_596_400_000 },
  lens: { model: 'pinhole', hfovDeg: 71.59, aspect: 1.7778 },
  offsetMs: 0,
};

const key = (t: number, extra: Record<string, unknown> = {}) => ({
  t,
  yaw: 90,
  pitch: -30,
  roll: 0,
  fill: 'smooth',
  ...extra,
});

describe('direction keyframes on a video layer', () => {
  it('are optional: a clip without them reads as before', () => {
    const r = Layer.safeParse(clip);
    expect(r.success).toBe(true);
    expect(r.success && r.data.kind === 'video' && r.data.directionKeys).toBeUndefined();
  });

  it('parse with every fill, a look-at target and in time order', () => {
    const keys = [
      key(0),
      key(1500, { fill: 'track', yaw: -20 }),
      key(4000, { fill: 'lookAt', target: [10, 0, -20] }),
      key(9000, { yaw: 359.9, pitch: -90, roll: 180 }),
    ];
    const r = Layer.safeParse({ ...clip, directionKeys: keys });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === 'video') expect(r.data.directionKeys).toEqual(keys);
  });

  it('keep a fill a later build adds (it reads as a smooth turn here)', () => {
    expect(DirectionKey.safeParse(key(0, { fill: 'measured' })).success).toBe(true);
    expect(DirectionKey.safeParse(key(0, { fill: '' })).success).toBe(false);
  });

  it('refuse a look-at without a target, angles out of range and a negative time', () => {
    expect(DirectionKey.safeParse(key(0, { fill: 'lookAt' })).success).toBe(false);
    expect(DirectionKey.safeParse(key(0, { pitch: -91 })).success).toBe(false);
    expect(DirectionKey.safeParse(key(0, { roll: 181 })).success).toBe(false);
    expect(DirectionKey.safeParse(key(0, { yaw: 361 })).success).toBe(false);
    expect(DirectionKey.safeParse(key(-1)).success).toBe(false);
    expect(DirectionKey.safeParse(key(0, { target: [1, 2] })).success).toBe(false);
  });

  it('refuse keyframes out of order or two at one time', () => {
    expect(DirectionKeys.safeParse([key(10), key(5)]).success).toBe(false);
    expect(DirectionKeys.safeParse([key(10), key(10)]).success).toBe(false);
    expect(Layer.safeParse({ ...clip, directionKeys: [key(10), key(5)] }).success).toBe(false);
    expect(DirectionKeys.safeParse([]).success).toBe(true);
  });

  it('are saved through builder:updateLayers, null clears them', () => {
    const p = (patch: unknown) => LayerPatch.safeParse(patch).success;
    expect(p({ directionKeys: [key(0), key(1000)] })).toBe(true);
    expect(p({ directionKeys: null })).toBe(true);
    expect(p({ directionKeys: [key(0, { fill: 'lookAt' })] })).toBe(false);
    expect(p({ directionKeys: [key(5), key(1)] })).toBe(false);
  });
});

describe('photo corrections', () => {
  const photo = { id: 'p1', src: { path: 'photos/p1.jpg' }, pos: [0, 40, 0], q: [0, 0, 0, 1] };

  it('are optional on a photo and keep heading, pitch, roll and an offset', () => {
    expect(PhotoRef.safeParse(photo).success).toBe(true);
    const c = { yawDeg: -4.5, pitchDeg: 2, rollDeg: 0.5, offsetM: [0, -3, 1] };
    const r = PhotoRef.safeParse({ ...photo, correction: c });
    expect(r.success && r.data.correction).toEqual(c);
    expect(PhotoRef.safeParse({ ...photo, correction: { ...c, yawDeg: 200 } }).success).toBe(false);
    expect(PhotoRef.safeParse({ ...photo, correction: { yawDeg: 1 } }).success).toBe(false);
  });

  it('are saved through builder:updateLayers by photo id, null clears one', () => {
    const p = (patch: unknown) => LayerPatch.safeParse(patch).success;
    expect(p({ photoCorrections: { p1: { yawDeg: 3, pitchDeg: 0, rollDeg: 0 }, p2: null } })).toBe(
      true,
    );
    expect(p({ photoCorrections: {} })).toBe(false);
    expect(p({ photoCorrections: { p1: { yawDeg: 3 } } })).toBe(false);
  });
});
