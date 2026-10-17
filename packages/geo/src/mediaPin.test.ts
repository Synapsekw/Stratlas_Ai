import { describe, expect, it } from 'vitest';
import {
  bearingDeg,
  bearingDiffDeg,
  circularMeanDeg,
  eyePos,
  headingFromPair,
  headingFromPairs,
  lookClickBearingDeg,
  photoQuatFromHeading,
} from './mediaPin';
import { rotateVec } from './walk/horizontal';

describe('bearingDeg', () => {
  it('is 0 north, 90 east, 180 south, 270 west (x east, z south)', () => {
    expect(bearingDeg([0, 0, 0], [0, 5, -1])).toBeCloseTo(0);
    expect(bearingDeg([0, 0, 0], [1, 0, 0])).toBeCloseTo(90);
    expect(bearingDeg([0, 0, 0], [0, 0, 1])).toBeCloseTo(180);
    expect(bearingDeg([0, 0, 0], [-1, 0, 0])).toBeCloseTo(270);
  });
  it('is null for a landmark within 0.5 m horizontally, whatever the height', () => {
    expect(bearingDeg([0, 0, 0], [0.3, 40, 0.3])).toBeNull();
  });
});
describe('heading from landmarks', () => {
  it('one pair: world minus offset, wrapped', () => {
    expect(headingFromPair({ offsetDeg: 10, worldDeg: 5 })).toBeCloseTo(355);
    expect(headingFromPair({ offsetDeg: 0, worldDeg: 90 })).toBeCloseTo(90);
  });
  it('two pairs: circular mean across 0/360', () => {
    expect(
      headingFromPairs([
        { offsetDeg: 0, worldDeg: 350 },
        { offsetDeg: 0, worldDeg: 10 },
      ]),
    ).toBeCloseTo(0);
    expect(
      headingFromPairs([
        { offsetDeg: 0, worldDeg: 90 },
        { offsetDeg: 0, worldDeg: 100 },
      ]),
    ).toBeCloseTo(95);
    expect(circularMeanDeg([359, 1])).toBeCloseTo(0);
  });
  it('opposite headings have no mean', () => {
    expect(circularMeanDeg([10, 190])).toBeNull();
    expect(circularMeanDeg([])).toBeNull();
  });
  it('bearingDiffDeg wraps', () => {
    expect(bearingDiffDeg(10, 350)).toBeCloseTo(20);
    expect(bearingDiffDeg(350, 10)).toBeCloseTo(-20);
    expect(bearingDiffDeg(0, 180)).toBeCloseTo(180);
  });
});
describe('eye and photo pose', () => {
  it('eyePos lifts y only', () => {
    expect(eyePos([1, 2, 3], 1.6)).toEqual([1, 3.6, 3]);
  });
  it('a photo aimed east looks along +x', () => {
    const d = rotateVec(photoQuatFromHeading(90), [0, 0, -1]);
    expect(d[0]).toBeCloseTo(1);
    expect(d[2]).toBeCloseTo(0);
  });
});
describe('lookClickBearingDeg', () => {
  it('the view centre is the look yaw', () => {
    expect(
      lookClickBearingDeg({ yawDeg: 30, pitchDeg: -10, fovDeg: 70 }, 400, 200, 800, 400),
    ).toBeCloseTo(30);
  });
  it('the right edge at pitch 0 is yaw + atan(tan(35 deg) * aspect)', () => {
    expect(
      lookClickBearingDeg({ yawDeg: 0, pitchDeg: 0, fovDeg: 70 }, 800, 200, 800, 400),
    ).toBeCloseTo(54.47, 1);
  });
  it('wraps left of north', () => {
    expect(
      lookClickBearingDeg({ yawDeg: 0, pitchDeg: 0, fovDeg: 70 }, 0, 200, 800, 400),
    ).toBeCloseTo(305.53, 1);
  });
});
