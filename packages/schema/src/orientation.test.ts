import { describe, expect, it } from 'vitest';
import { ipc } from './ipc';
import {
  DirectionKey,
  DirectionKeys,
  emptyOrientation,
  ORIENTATION_SCHEMA,
  OrientationFile,
  PhotoCorrection,
} from './orientation';
import { newerRefusal, readVersioned, SCHEMA_REGISTRY } from './versions';

const key = (t: number, extra: Record<string, unknown> = {}) => ({
  t,
  yaw: 90,
  pitch: -30,
  roll: 0,
  fill: 'smooth',
  ...extra,
});

describe('direction keyframes', () => {
  it('parse with every fill, a look-at target and in time order', () => {
    const keys = [
      key(0),
      key(1500, { fill: 'track', yaw: -20 }),
      key(4000, { fill: 'lookAt', target: [10, 0, -20] }),
      key(9000, { yaw: 359.9, pitch: -90, roll: 180 }),
    ];
    expect(DirectionKeys.parse(keys)).toEqual(keys);
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
    expect(DirectionKeys.safeParse([]).success).toBe(true);
  });
});

describe('photo corrections', () => {
  it('keep heading, pitch, roll and an optional offset, in range', () => {
    const c = { yawDeg: -4.5, pitchDeg: 2, rollDeg: 0.5, offsetM: [0, -3, 1] };
    expect(PhotoCorrection.parse(c)).toEqual(c);
    expect(PhotoCorrection.safeParse({ ...c, yawDeg: 200 }).success).toBe(false);
    expect(PhotoCorrection.safeParse({ yawDeg: 1 }).success).toBe(false);
  });
});

describe('orientation.json', () => {
  const file = {
    schema: ORIENTATION_SCHEMA,
    updatedAt: '2026-10-07T12:00:00Z',
    clips: { 'clip-1': { keys: [key(0), key(4000, { yaw: 120 })] } },
    photos: { photos: { 'dji-0001': { yawDeg: -3, pitchDeg: 0, rollDeg: 0 } } },
  };

  it('reads clips and photos, both optional', () => {
    expect(OrientationFile.parse(file)).toEqual(file);
    expect(OrientationFile.parse({ schema: ORIENTATION_SCHEMA })).toEqual(emptyOrientation());
    expect(
      OrientationFile.safeParse({ ...file, clips: { c: { keys: [key(5), key(1)] } } }).success,
    ).toBe(false);
  });

  it('is a registered project file that refuses a newer version unchanged', () => {
    expect(SCHEMA_REGISTRY.find((e) => e.family === 'aio.orientation')).toMatchObject({
      version: 1,
      home: 'project',
      where: 'orientation.json',
    });
    const read = readVersioned(file, { family: 'aio.orientation', schema: OrientationFile });
    expect(read).toMatchObject({ ok: true, migratedFrom: null });
    const newer = { ...file, schema: 'aio.orientation/2' };
    expect(newerRefusal(newer, 'Stratlas')).toMatch(/newer version of Stratlas/);
  });

  it('is read and written over IPC by project', () => {
    expect(ipc['orientation:read'].request.safeParse({ projectId: 'p' }).success).toBe(true);
    expect(ipc['orientation:write'].request.safeParse({ projectId: 'p', file }).success).toBe(true);
    expect(
      ipc['orientation:write'].request.safeParse({ projectId: 'p', file: { schema: 'x' } }).success,
    ).toBe(false);
  });
});
