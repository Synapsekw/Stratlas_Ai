import { describe, expect, it } from 'vitest';
import { toAntennaFrame } from './geometry';
import {
  DEFAULT_AM_DB,
  DEFAULT_SLAV_DB,
  combineCutsDb,
  horizontalCutDb,
  makeTwoCutPattern,
  parametricFromPort,
  patternGainDb,
  patternLossDb,
  verticalCutDb,
  type ParametricPattern,
} from './pattern';

const generic: ParametricPattern = {
  kind: 'parametric',
  hBeamwidthDeg: 65,
  vBeamwidthDeg: 7,
  eTiltDeg: 0,
};

describe('38.901 Table 7.3-1 cuts', () => {
  it('defaults Am = SLAv = 30 dB', () => {
    expect(DEFAULT_AM_DB).toBe(30);
    expect(DEFAULT_SLAV_DB).toBe(30);
  });

  it('A_H is 0 at boresight, -3 dB at half the beamwidth, symmetric, capped at Am', () => {
    // 12 (32.5/65)^2 = 12/4 = 3.
    expect(horizontalCutDb(0, 65)).toBeCloseTo(0, 12);
    expect(horizontalCutDb(32.5, 65)).toBeCloseTo(-3, 12);
    expect(horizontalCutDb(-32.5, 65)).toBeCloseTo(-3, 12);
    // 12 (90/65)^2 = 23.006
    expect(horizontalCutDb(90, 65)).toBeCloseTo(-23.006, 3);
    // 12 (180/65)^2 = 92 > 30
    expect(horizontalCutDb(180, 65)).toBe(-30);
    expect(horizontalCutDb(180, 65, 25)).toBe(-25);
    // Angles wrap: 350 deg is 10 deg left of boresight.
    expect(horizontalCutDb(350, 65)).toBeCloseTo(horizontalCutDb(-10, 65), 12);
  });

  it('A_V is centred on the electrical tilt (positive down) and capped at SLAv', () => {
    // Zenith form: 12((theta - 90 - etilt)/theta3dB)^2 with theta = 90 + downElevation.
    expect(verticalCutDb(4, 7, 4)).toBeCloseTo(0, 12);
    expect(verticalCutDb(7.5, 7, 4)).toBeCloseTo(-3, 12);
    expect(verticalCutDb(0.5, 7, 4)).toBeCloseTo(-3, 12);
    // At the horizon with 6 deg of e-tilt: 12 (6/7)^2 = 8.816.
    expect(verticalCutDb(0, 7, 6)).toBeCloseTo(-8.816, 3);
    expect(verticalCutDb(90, 7, 0)).toBe(-30);
    expect(verticalCutDb(90, 7, 0, 20)).toBe(-20);
  });

  it('combines as A = -min(-(A_H + A_V), Am)', () => {
    expect(combineCutsDb(-3, -3, 30)).toBeCloseTo(-6, 12);
    expect(combineCutsDb(-25, -8.8, 25)).toBe(-25);
    expect(combineCutsDb(-0, -0, 30)).toBe(0);
  });
});

describe('patternGainDb, parametric', () => {
  it('peak is 0 dB on the tilted vertical axis', () => {
    expect(patternGainDb({ ...generic, eTiltDeg: 4 }, 0, 4)).toBeCloseTo(0, 12);
    expect(patternLossDb({ ...generic, eTiltDeg: 4 }, 0, 4)).toBeCloseTo(0, 12);
  });
  it('the corner at both 3 dB edges is 6 dB down', () => {
    expect(patternLossDb({ ...generic, eTiltDeg: 4 }, 32.5, 7.5)).toBeCloseTo(6, 12);
  });
  it('the back lobe is capped at the front-to-back value (Am)', () => {
    // Behind at the horizon with 6 deg e-tilt: A_H = -25 (capped), A_V = -8.816, sum 33.8 > 25.
    const p: ParametricPattern = { ...generic, eTiltDeg: 6, amDb: 25 };
    expect(patternLossDb(p, 180, 0)).toBe(25);
  });
  it('parametricFromPort takes the catalogue port and Am from the front-to-back value', () => {
    const p = parametricFromPort({ hBeamwidthDeg: 65, vBeamwidthDeg: 6.5, frontToBackDb: 28 }, 3);
    expect(p).toEqual({
      kind: 'parametric',
      hBeamwidthDeg: 65,
      vBeamwidthDeg: 6.5,
      eTiltDeg: 3,
      amDb: 28,
    });
  });
  it('refuses a non-positive beamwidth', () => {
    expect(() => patternGainDb({ ...generic, hBeamwidthDeg: 0 }, 0, 0)).toThrow(/beamwidth/i);
  });
});

describe('mechanical tilt is a rotation, not added to the electrical tilt', () => {
  // Horizon targets, 6 deg of tilt either mechanical (rotation) or electrical (shifted vertical cut).
  const at = (offDeg: number, mech: number, etilt: number) => {
    const t = {
      east: Math.sin(offDeg * (Math.PI / 180)),
      north: Math.cos(offDeg * (Math.PI / 180)),
      up: 0,
    };
    const a = toAntennaFrame(t, { trueAzimuthDeg: 0, mechanicalDowntiltDeg: mech });
    return patternLossDb({ ...generic, eTiltDeg: etilt }, a.azimuthDeg, a.downElevationDeg);
  };
  it('on boresight both give the same loss: 12 (6/7)^2 = 8.816 dB', () => {
    expect(at(0, 6, 0)).toBeCloseTo(8.816, 3);
    expect(at(0, 0, 6)).toBeCloseTo(8.816, 3);
  });
  it('at 90 deg off boresight, mechanical tilt fades out but electrical tilt does not', () => {
    // Mechanical: only A_H(90) = 23.006. Electrical: 23.006 + 8.816 = 31.8, capped at 30.
    expect(at(90, 6, 0)).toBeCloseTo(23.006, 3);
    expect(at(90, 0, 6)).toBe(30);
  });
  it('at 45 deg the mechanical tilt is partly felt', () => {
    // Antenna frame: down = -asin(cos45 sin6) = -4.239, az = atan2(sin45, cos45 cos6) = 45.157,
    // so 12 (45.157/65)^2 + 12 (4.239/7)^2 = 5.792 + 4.400 = 10.192 (vs 14.568 for e-tilt).
    const mech = at(45, 6, 0);
    const expected =
      12 *
        (Math.atan2(Math.SQRT1_2, Math.SQRT1_2 * Math.cos(6 * (Math.PI / 180))) /
          (65 * (Math.PI / 180))) **
          2 +
      12 * ((Math.asin(Math.SQRT1_2 * Math.sin(6 * (Math.PI / 180))) * (180 / Math.PI)) / 7) ** 2;
    expect(mech).toBeCloseTo(expected, 10);
    expect(mech).toBeCloseTo(10.192, 2);
    // Electrical 6 deg at 45: 12 (45/65)^2 + 8.816 = 5.752 + 8.816 = 14.568.
    expect(at(45, 0, 6)).toBeCloseTo(14.568, 3);
  });
});

describe('two-cut summing (MSI)', () => {
  // Horizontal: 0.1 dB per degree from boresight, so H(10) = 1, H(-1) = H(359) = 0.1.
  const horizontalDb = Array.from({ length: 360 }, (_, i) => 0.1 * Math.min(i, 360 - i));
  // Vertical: tilt baked in at 4 deg: V(d) = 0.5 |d - 4| for the front half.
  const verticalDb = Array.from({ length: 360 }, (_, i) => {
    const d = i > 180 ? i - 360 : i;
    return 0.5 * Math.abs(d - 4);
  });
  const p = makeTwoCutPattern(horizontalDb, verticalDb, 25);

  it('reads integer angles and sums the cuts', () => {
    expect(patternLossDb(p, 10, 4)).toBeCloseTo(1, 12);
    expect(patternLossDb(p, 10, 6)).toBeCloseTo(2, 12);
  });
  it('interpolates linearly between degrees, across the 359 to 0 seam', () => {
    expect(patternLossDb(p, 10.5, 4)).toBeCloseTo(1.05, 12);
    // -0.5 deg is index 359.5: halfway between H(359) = 0.1 and H(0) = 0.
    expect(patternLossDb(p, -0.5, 4)).toBeCloseTo(0.05, 12);
    // Up is negative down-elevation: -2 deg reads index 358, V = 0.5 * 6 = 3.
    expect(patternLossDb(p, 0, -2)).toBeCloseTo(3, 12);
  });
  it('caps the sum at the front-to-back value', () => {
    // H(180) = 18, V(-30) = 17: 35 capped at 25.
    expect(patternLossDb(p, 180, -30)).toBe(25);
    expect(patternGainDb(p, 180, -30)).toBe(-25);
  });
  it('refuses cuts that are not 360 finite values', () => {
    expect(() => makeTwoCutPattern(horizontalDb.slice(1), verticalDb, 25)).toThrow(/360/);
    expect(() => makeTwoCutPattern(horizontalDb, [...verticalDb.slice(1), Number.NaN], 25)).toThrow(
      /finite/,
    );
  });
});
