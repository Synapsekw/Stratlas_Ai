import { describe, expect, it } from 'vitest';
import { lookQuat, overflight, panoAt, photoAt, track } from './__fixtures__/spotPoses';
import { nearestSample, originCapture, spotFromPose, spotOf } from './spotOrigin';

const close = (a: readonly number[] | undefined, b: readonly number[]) => {
  expect(a).toHaveLength(b.length);
  b.forEach((v, i) => {
    expect(a?.[i]).toBeCloseTo(v, 2);
  });
};

describe('spotFromPose', () => {
  it('a hand-held photo looking a little down aims where it meets its ground', () => {
    const s = spotFromPose({ pos: [0, 1.6, 0], q: lookQuat(0, -5) });
    close(s.target, [0, 0, -18.29]);
    expect(s.aerial).toBe(false);
    expect(s.bearingDeg).toBeCloseTo(0);
  });
  it('a level photo aims 15 m ahead', () => {
    close(spotFromPose({ pos: [0, 1.6, 0], q: lookQuat(90) }).target, [15, 0, 0]);
  });
  it('a drone photo looking down aims at the origin ground below, without a bearing', () => {
    const s = spotFromPose({ pos: [0, 40, 0], q: lookQuat(0, -90) });
    close(s.target, [0, 0, 0]);
    expect(s.aerial).toBe(true);
    expect(s.bearingDeg).toBeUndefined();
  });
  it('an oblique drone photo aims where its centre line meets the ground', () => {
    const pitch = (-Math.atan2(30, 40) * 180) / Math.PI;
    close(spotFromPose({ pos: [0, 30, 40], q: lookQuat(0, pitch) }).target, [0, 0, 0]);
  });
  it('a level photo 12 m above the origin is ground-level', () => {
    const s = spotFromPose({ pos: [0, 12, 0], q: lookQuat(0) });
    expect(s.aerial).toBe(false);
    close(s.target, [0, 10.4, -15]);
  });
});

describe('spotOf', () => {
  const entries = [
    photoAt('a', [0, 1.6, 0], 0, { capture: 'd1', layer: 'photos-d1' }),
    photoAt('nogps', undefined, 0, { capture: 'd1', layer: 'photos-d1' }),
    photoAt('dirless', [5, 1.6, 5], null, { capture: 'd1', layer: 'photos-d1' }),
    photoAt('u', [2, 1.6, 3], 90, { capture: undefined, layer: 'photos-undated' }),
    panoAt('p', [5, 1.6, 5], 'd1', 90),
    { kind: 'video', layer: 'clip', capture: 'd1', samples: overflight() } as const,
    {
      kind: 'walk',
      layer: 'walk',
      capture: 'd1',
      samples: track(
        [
          [0, 0, 0],
          [4, 10, 0],
        ],
        90,
      ),
    } as const,
  ];
  it('finds a photo and its camera', () => {
    expect(
      spotOf({ item: { kind: 'photo', layer: 'photos-d1', photo: 'a' } }, entries)?.camera,
    ).toEqual([0, 1.6, 0]);
  });
  it('has no spot for a photo without a position or an unknown item', () => {
    expect(
      spotOf({ item: { kind: 'photo', layer: 'photos-d1', photo: 'nogps' } }, entries),
    ).toBeNull();
    expect(
      spotOf({ item: { kind: 'photo', layer: 'photos-d1', photo: 'zz' } }, entries),
    ).toBeNull();
  });
  it('a photo without a direction aims below itself', () => {
    close(
      spotOf({ item: { kind: 'photo', layer: 'photos-d1', photo: 'dirless' } }, entries)?.target,
      [5, 0, 5],
    );
  });
  it('a panorama looks along its heading, or along the current look', () => {
    close(
      spotOf({ item: { kind: 'pano', layer: 'pano-d1', pano: 'p' } }, entries)?.target,
      [20, 0, 5],
    );
    close(
      spotOf({ item: { kind: 'pano', layer: 'pano-d1', pano: 'p' }, lookDeg: 180 }, entries)
        ?.target,
      [5, 0, 20],
    );
  });
  it('a video frame takes the given camera, else the nearest sample', () => {
    const given = spotOf(
      {
        item: { kind: 'video', layer: 'clip', t: 2.4 },
        pose: { pos: [7, 40, 7], q: lookQuat(0, -90) },
      },
      entries,
    );
    close(given?.target, [7, 0, 7]);
    close(
      spotOf({ item: { kind: 'video', layer: 'clip', t: 2.4 } }, entries)?.camera,
      [-30, 40, -15],
    );
  });
  it('a walk frame stands at its nearest sample and looks along its bearing', () => {
    const s = spotOf({ item: { kind: 'walk', layer: 'walk', t: 3.1 } }, entries);
    close(s?.camera, [10, 1.7, 0]);
    expect(s?.bearingDeg).toBeCloseTo(90);
  });
  it('picks the nearest sample in time', () => {
    expect(nearestSample([{ t: 0 }, { t: 1 }, { t: 2 }], 1.4)?.t).toBe(1);
    expect(nearestSample(null, 1)).toBeUndefined();
  });
  it('undated entries are still found: the origin resolves, with its date reported as none', () => {
    const item = { kind: 'photo', layer: 'photos-undated', photo: 'u' } as const;
    close(spotOf({ item }, entries)?.camera, [2, 1.6, 3]);
    close(spotOf({ item }, entries)?.target, [17, 0, 3]);
    expect(originCapture(item, entries)).toBeUndefined();
  });
  it('originCapture reports the date of a dated item', () => {
    expect(originCapture({ layer: 'photos-d1' }, entries)).toBe('d1');
    expect(originCapture({ layer: 'clip' }, entries)).toBe('d1');
  });
});
