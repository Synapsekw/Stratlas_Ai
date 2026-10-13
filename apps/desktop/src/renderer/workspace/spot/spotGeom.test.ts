import { viewDirection } from '@aio/video';
import { describe, expect, it } from 'vitest';
import { LENS, lookQuat } from './__fixtures__/spotPoses';
import {
  angleDiffDeg,
  bearingOf,
  bearingTo,
  centreOffset,
  groundAhead,
  groundHit,
  imagePointOf,
  inFrame,
  wrapDeg,
} from './spotGeom';

/** Loops over the expected values and checks the length, so a null result fails. */
const close = (actual: readonly number[] | null | undefined, expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((v, i) => {
    expect(actual?.[i]).toBeCloseTo(v, 4);
  });
};

describe('bearings and angles', () => {
  it('reads compass bearings in the local frame (north is -z, east is +x)', () => {
    expect(bearingOf([0, 0, -1])).toBeCloseTo(0);
    expect(bearingOf([1, 0, 0])).toBeCloseTo(90);
    expect(bearingOf([0, 0, 1])).toBeCloseTo(180);
    expect(bearingOf([-1, 0, 0])).toBeCloseTo(270);
  });
  it('has no bearing straight down or between equal points', () => {
    expect(bearingOf([0, -1, 0])).toBeUndefined();
    expect(bearingOf([0.05, -1, 0])).toBeUndefined();
    expect(bearingTo([3, 0, 3], [3, 9, 3])).toBeUndefined();
  });
  it('wraps angles at 360', () => {
    expect(angleDiffDeg(350, 10)).toBeCloseTo(20);
    expect(angleDiffDeg(10, 350)).toBeCloseTo(20);
    expect(angleDiffDeg(0, 180)).toBeCloseTo(180);
    expect(angleDiffDeg(-30, 690)).toBeCloseTo(0);
    expect(wrapDeg(-90)).toBe(270);
  });
  it('builds test cameras that look where they say', () => {
    close(viewDirection(lookQuat(90)), [1, 0, 0]);
    close(viewDirection(lookQuat(0, -90)), [0, -1, 0]);
  });
});

describe('ground', () => {
  it('meets flat ground along a view that looks down', () => {
    const d = viewDirection(lookQuat(0, -45));
    close(groundHit([0, 10, 0], d, 0, 30), [0, 0, -10]);
  });
  it('misses ground beyond the range or above the horizon', () => {
    expect(groundHit([0, 1.6, 0], viewDirection(lookQuat(0, -1)), 0, 30)).toBeNull();
    expect(groundHit([0, 1.6, 0], viewDirection(lookQuat(0, 10)), 0, 30)).toBeNull();
  });
  it('aims ahead along the bearing, or straight below without one', () => {
    close(groundAhead([0, 1.6, 0], 90, 0, 15), [15, 0, 0]);
    close(groundAhead([4, 9, 4], undefined, 2, 15), [4, 2, 4]);
  });
});

describe('image points', () => {
  const down = { pos: [0, 50, 0] as [number, number, number], q: lookQuat(0, -90), lens: LENS };
  it('puts the point below a downward camera at the image centre', () => {
    const uv = imagePointOf(down, [0, 0, 0]);
    close(uv, [0.5, 0.5]);
    expect(uv && centreOffset(uv)).toBeCloseTo(0);
  });
  it('puts a far point outside the frame and a point behind a pinhole nowhere', () => {
    const far = imagePointOf(down, [100, 0, 0]);
    expect(far).not.toBeNull();
    expect(far && inFrame(far)).toBe(false);
    expect(imagePointOf({ ...down, q: lookQuat(0, 90) }, [0, 0, 0])).toBeNull();
  });
});
