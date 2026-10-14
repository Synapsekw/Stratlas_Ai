import { describe, expect, it } from 'vitest';
import { LENS, lookQuat, overflight, panoAt, photoAt, track } from './__fixtures__/spotPoses';
import { matchPano, matchPhoto, matchVideo, matchWalk } from './spotMatchers';
import { SPOT_RULES } from './spotRules';
import type { Spot } from './spotTypes';

/** Standing at the origin, looking north at a point 15 m away. */
const ground: Spot = { camera: [0, 1.6, 0], bearingDeg: 0, target: [0, 0, -15], aerial: false };
/** The same target, from a map click (S2) or seen from the air. */
const targetOnly: Spot = { target: [0, 0, -15], aerial: false };
const fromAir: Spot = { camera: [0, 40, -15], target: [0, 0, -15], aerial: true };

describe('ground photos', () => {
  it('match within 15 m and 45 degrees, scored by distance plus weighed angle', () => {
    const m = matchPhoto(ground, photoAt('a', [10, 1.6, 0], 30));
    expect(m?.kind).toBe('photo');
    expect(m?.distanceM).toBeCloseTo(10);
    expect(m?.angleDeg).toBeCloseTo(30);
    expect(m?.score).toBeCloseTo(16);
  });
  it('do not match beyond the distance or the angle', () => {
    expect(matchPhoto(ground, photoAt('a', [16, 1.6, 0], 0))).toBeNull();
    expect(matchPhoto(ground, photoAt('a', [5, 1.6, 0], 50))).toBeNull();
  });
  it('compare facings across north', () => {
    const spot = { ...ground, bearingDeg: 10 };
    expect(matchPhoto(spot, photoAt('a', [5, 1.6, 0], 340))?.angleDeg).toBeCloseTo(30);
  });
  it('a photo with a position but no direction matches on distance', () => {
    const m = matchPhoto(ground, photoAt('a', [5, 1.6, 0], null));
    expect(m?.angleDeg).toBeNull();
    expect(m?.score).toBeCloseTo(5);
  });
  it('a photo without a position never matches', () => {
    expect(matchPhoto(ground, photoAt('a', undefined, 0))).toBeNull();
  });
  it('match a target-only spot when they stand near it and face it', () => {
    expect(matchPhoto(targetOnly, photoAt('a', [0, 1.6, -5], 0))?.distanceM).toBeCloseTo(10);
    expect(matchPhoto(targetOnly, photoAt('a', [0, 1.6, -5], 180))).toBeNull();
  });
  it('match an aerial spot on its target, not on the drone camera', () => {
    expect(matchPhoto(fromAir, photoAt('a', [0, 1.6, -5], 0))?.distanceM).toBeCloseTo(10);
  });
});

describe('drone photos', () => {
  it('match when the target is in the frame, best at the centre', () => {
    const m = matchPhoto(ground, photoAt('d', [0, 40, -15], 0, { pitchDeg: -90 }));
    expect(m?.kind).toBe('drone');
    expect(m?.aerial).toBe(true);
    expect(m?.score).toBeCloseTo(0);
  });
  it('do not match when the target is outside the frame', () => {
    expect(matchPhoto(ground, photoAt('d', [100, 40, 0], 0, { pitchDeg: -90 }))).toBeNull();
  });
  it('are left out of aerial matching without a lens of their own', () => {
    expect(
      matchPhoto(ground, photoAt('d', [0, 40, -15], 0, { pitchDeg: -90, lens: false })),
    ).toBeNull();
  });
});

describe('aerial vicinity', () => {
  // A drone 40 m up, `east` metres east of the target, aiming its centre line at the target.
  const oblique = (east: number) =>
    ({ pos: [east, 40, -15], pitchDeg: (-Math.atan2(40, east) * 180) / Math.PI }) as const;
  it('a drone photo far off the spot is rejected though it sees the target', () => {
    const at = (east: number) => {
      const o = oblique(east);
      return photoAt('d', [...o.pos], 270, { pitchDeg: o.pitchDeg });
    };
    expect(matchPhoto(ground, at(30))?.kind).toBe('drone');
    expect(matchPhoto(ground, at(120))).toBeNull();
  });
  it('a video frame far off the spot is rejected though it sees the target', () => {
    const at = (east: number) => {
      const o = oblique(east);
      const pose = { pos: [...o.pos] as [number, number, number], q: lookQuat(270, o.pitchDeg) };
      return {
        kind: 'video',
        layer: 'clip',
        capture: 'd2',
        samples: [{ t: 0, pose: { ...pose, lens: LENS } }],
      } as const;
    };
    expect(matchVideo(ground, at(30))?.kind).toBe('video');
    expect(matchVideo(ground, at(120))).toBeNull();
  });
  it(`keeps aerial matches within ${SPOT_RULES.aerialNearM} m of the spot's camera`, () => {
    const eps = 0.01;
    const near = photoAt('d', [0, 40, -15], 0, { pitchDeg: -90 });
    const spotAt = (x: number): Spot => ({ ...ground, camera: [x, 1.6, -15] });
    expect(matchPhoto(spotAt(SPOT_RULES.aerialNearM - eps), near)).not.toBeNull();
    expect(matchPhoto(spotAt(SPOT_RULES.aerialNearM + eps), near)).toBeNull();
  });
});

describe('panoramas', () => {
  it('match within 25 m whatever their heading, turned towards the target', () => {
    const m = matchPano(ground, panoAt('p', [20, 1.6, 0], 'd2', 123));
    expect(m?.distanceM).toBeCloseTo(20);
    expect(m?.angleDeg).toBeNull();
    expect(m?.lookDeg).toBeCloseTo(306.87, 1);
  });
  it('do not match beyond 25 m', () => {
    expect(matchPano(ground, panoAt('p', [30, 1.6, 0]))).toBeNull();
  });
});

describe('walk frames', () => {
  const walk = (samples: ReturnType<typeof track> | null) =>
    ({ kind: 'walk', layer: 'walk-a', capture: 'd2', samples }) as const;
  it('match at the nearest frame within 15 m', () => {
    const m = matchWalk(
      ground,
      walk(
        track([
          [0, 40, 0],
          [5, 8, 0],
          [6, 3, 0],
          [9, 20, 0],
        ]),
      ),
    );
    expect(m?.item).toEqual({ kind: 'walk', layer: 'walk-a', t: 6 });
    expect(m?.distanceM).toBeCloseTo(3);
  });
  it("carry the frame's picture centre bearing", () => {
    expect(matchWalk(ground, walk(track([[6, 3, 0]], 120)))?.centreDeg).toBe(120);
  });
  it('do not match beyond 15 m or when not placed', () => {
    expect(matchWalk(ground, walk(track([[0, 40, 0]])))).toBeNull();
    expect(matchWalk(ground, walk(null))).toBeNull();
  });
  it('face the target of a target-only spot', () => {
    expect(matchWalk(targetOnly, walk(track([[0, 0, -5]], 180)))).toBeNull();
    expect(matchWalk(targetOnly, walk(track([[0, 0, -5]], 0)))?.angleDeg).toBeCloseTo(0);
  });
});

describe('videos', () => {
  const clip = (samples: ReturnType<typeof overflight> | null) =>
    ({ kind: 'video', layer: 'clip', capture: 'd2', samples }) as const;
  it('open at the moment the target is nearest the frame centre, mid-flight', () => {
    const m = matchVideo(ground, clip(overflight()));
    expect(m?.item).toEqual({ kind: 'video', layer: 'clip', t: 5 });
    expect(m?.aerial).toBe(true);
    expect(m?.score).toBeCloseTo(0);
  });
  it('take the closer camera on a tie', () => {
    const two = overflight().filter((f) => f.t === 4 || f.t === 6);
    const spot: Spot = { ...ground, camera: [3, 1.6, -15] };
    expect(matchVideo(spot, clip(two))?.item).toEqual({ kind: 'video', layer: 'clip', t: 6 });
  });
  it('do not match when the target is never in the frame, or the log is unreadable', () => {
    expect(matchVideo({ ...ground, target: [0, 0, 200] }, clip(overflight()))).toBeNull();
    expect(matchVideo(ground, clip(null))).toBeNull();
  });
});

describe('tolerance boundaries', () => {
  const eps = 0.01;
  it('a ground photo is in just inside, out just outside the distance limit', () => {
    expect(
      matchPhoto(ground, photoAt('a', [SPOT_RULES.groundPhotoM - eps, 1.6, 0], 0)),
    ).not.toBeNull();
    expect(matchPhoto(ground, photoAt('a', [SPOT_RULES.groundPhotoM + eps, 1.6, 0], 0))).toBeNull();
  });
  it('a ground photo is in just inside, out just outside the facing limit', () => {
    const at = (deg: number) => photoAt('a', [5, 1.6, 0], deg);
    expect(matchPhoto(ground, at(SPOT_RULES.groundAngleDeg - eps))).not.toBeNull();
    expect(matchPhoto(ground, at(SPOT_RULES.groundAngleDeg + eps))).toBeNull();
  });
  it('a camera is a ground photo just below the aerial height, a drone photo just above', () => {
    const below = matchPhoto(ground, photoAt('a', [0, SPOT_RULES.aerialAboveM - eps, -5], 0));
    expect(below?.kind).toBe('photo');
    const above = matchPhoto(
      ground,
      photoAt('a', [0, SPOT_RULES.aerialAboveM + eps, -15], 0, { pitchDeg: -90 }),
    );
    expect(above?.kind).toBe('drone');
  });
});
