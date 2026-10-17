import { describe, expect, it } from 'vitest';
import {
  bearingDeg,
  directionToAntennaFrame,
  gridToTrue,
  normalizeDeg180,
  normalizeDeg360,
  toAntennaFrame,
  trueAzimuthDeg,
} from './geometry';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** A horizontal unit vector at a bearing (clockwise from north), with an optional depression below the horizon. */
function dir(bearing: number, depressionDeg = 0) {
  return {
    east: Math.sin(bearing * RAD) * Math.cos(depressionDeg * RAD),
    north: Math.cos(bearing * RAD) * Math.cos(depressionDeg * RAD),
    up: -Math.sin(depressionDeg * RAD),
  };
}

describe('angle helpers', () => {
  it('normalises to [0, 360) and (-180, 180]', () => {
    expect(normalizeDeg360(-1)).toBeCloseTo(359, 12);
    expect(normalizeDeg360(720.5)).toBeCloseTo(0.5, 12);
    expect(normalizeDeg180(190)).toBeCloseTo(-170, 12);
    expect(normalizeDeg180(-180)).toBe(180);
    expect(normalizeDeg180(180)).toBe(180);
  });
  it('bearing is clockwise from north', () => {
    expect(bearingDeg({ east: 1, north: 0, up: 0 })).toBeCloseTo(90, 12);
    expect(bearingDeg({ east: 0, north: -1, up: 5 })).toBeCloseTo(180, 12);
    expect(bearingDeg({ east: -1, north: 1, up: 0 })).toBeCloseTo(315, 12);
  });
});

describe('true azimuth = grid azimuth + convergence', () => {
  it('adds the convergence and wraps', () => {
    expect(trueAzimuthDeg(120, 1.5)).toBeCloseTo(121.5, 12);
    expect(trueAzimuthDeg(359, 1.5)).toBeCloseTo(0.5, 12);
    expect(trueAzimuthDeg(1, -1.5)).toBeCloseTo(359.5, 12);
  });
  it('refuses a unit without a convergence (no CRS, spec D2)', () => {
    expect(() => trueAzimuthDeg(120, null)).toThrow(/convergence/i);
  });
  it('turns a grid vector clockwise by the convergence', () => {
    // Grid north with convergence 1.5 deg has a true bearing of 1.5 deg; length and up are kept.
    const v = gridToTrue({ east: 0, north: 100, up: -20 }, 1.5);
    expect(bearingDeg(v)).toBeCloseTo(1.5, 10);
    expect(Math.hypot(v.east, v.north)).toBeCloseTo(100, 10);
    expect(v.up).toBe(-20);
  });
});

describe('toAntennaFrame: rotate by true azimuth, then by mechanical downtilt', () => {
  it('boresight is azimuth 0, elevation 0', () => {
    const a = toAntennaFrame(dir(90), { trueAzimuthDeg: 90, mechanicalDowntiltDeg: 0 });
    expect(a.azimuthDeg).toBeCloseTo(0, 12);
    expect(a.downElevationDeg).toBeCloseTo(0, 12);
    expect(a.forward).toBeCloseTo(1, 12);
  });

  it('azimuth is positive clockwise (to the right of boresight)', () => {
    const a = toAntennaFrame(dir(30), { trueAzimuthDeg: 0, mechanicalDowntiltDeg: 0 });
    expect(a.azimuthDeg).toBeCloseTo(30, 12);
    expect(
      toAntennaFrame(dir(330), { trueAzimuthDeg: 0, mechanicalDowntiltDeg: 0 }).azimuthDeg,
    ).toBeCloseTo(-30, 12);
  });

  it('a point straight below is 90 deg down, and does not depend on the length', () => {
    const a = toAntennaFrame(
      { east: 0, north: 0, up: -28.5 },
      { trueAzimuthDeg: 0, mechanicalDowntiltDeg: 0 },
    );
    expect(a.downElevationDeg).toBeCloseTo(90, 12);
  });

  it('a point on the tilted boresight is on the beam axis', () => {
    // Boresight tilted 10 deg down: the point 10 deg below the horizon, on the same bearing.
    const a = toAntennaFrame(dir(200, 10), { trueAzimuthDeg: 200, mechanicalDowntiltDeg: 10 });
    expect(a.azimuthDeg).toBeCloseTo(0, 10);
    expect(a.downElevationDeg).toBeCloseTo(0, 10);
  });

  it('on boresight, mechanical tilt shifts the elevation one for one', () => {
    // Horizon point on the boresight bearing, beam 10 deg down: the point is 10 deg above the beam.
    const a = toAntennaFrame(dir(0), { trueAzimuthDeg: 0, mechanicalDowntiltDeg: 10 });
    expect(a.downElevationDeg).toBeCloseTo(-10, 10);
    expect(a.azimuthDeg).toBeCloseTo(0, 10);
  });

  it('45 deg off boresight, the effective tilt shrinks to atan(tan(tilt) cos 45)', () => {
    // Hand check. Antenna frame of a ground direction (f forward, r right, u up), tilt t:
    //   x' = f cos t - u sin t,  y' = r,  z' = f sin t + u cos t.
    // The beam plane (z' = 0) meets the vertical plane at 45 deg where u/f = -tan t.
    // With the horizontal part at 45 deg, f = cos 45 per unit horizontal distance, so the
    // depression below the horizon on that bearing is atan(tan 10 * cos 45) = 7.107 deg, not 10.
    const tilt = 10;
    const effective = Math.atan(Math.tan(tilt * RAD) * Math.cos(45 * RAD)) * DEG;
    expect(effective).toBeCloseTo(7.107, 3);
    const onPlane = toAntennaFrame(dir(45, effective), {
      trueAzimuthDeg: 0,
      mechanicalDowntiltDeg: tilt,
    });
    expect(onPlane.downElevationDeg).toBeCloseTo(0, 10);

    // A horizon point on the same bearing: z' = cos45 sin10, so it sits asin(cos45 sin10) = 7.053
    // deg above the beam, and its antenna azimuth is atan2(sin45, cos45 cos10) = atan(1/cos10) = 45.439.
    const horizon = toAntennaFrame(dir(45), { trueAzimuthDeg: 0, mechanicalDowntiltDeg: tilt });
    expect(horizon.downElevationDeg).toBeCloseTo(
      -Math.asin(Math.cos(45 * RAD) * Math.sin(tilt * RAD)) * DEG,
      10,
    );
    expect(horizon.downElevationDeg).toBeCloseTo(-7.053, 3);
    expect(horizon.azimuthDeg).toBeCloseTo(Math.atan(1 / Math.cos(tilt * RAD)) * DEG, 10);
    expect(horizon.azimuthDeg).toBeCloseTo(45.439, 3);
  });

  it('90 deg off boresight, mechanical tilt has no effect on a horizon point', () => {
    // f = 0, u = 0, so z' = 0: the tilt axis points at the target.
    const a = toAntennaFrame(dir(90), { trueAzimuthDeg: 0, mechanicalDowntiltDeg: 10 });
    expect(a.downElevationDeg).toBeCloseTo(0, 10);
    expect(a.azimuthDeg).toBeCloseTo(90, 10);
  });

  it('behind the antenna, mechanical downtilt lifts the back lobe', () => {
    // f = -1: z' = -sin t, so a horizon point behind is t below the (raised) rear of the beam plane.
    const a = toAntennaFrame(dir(180), { trueAzimuthDeg: 0, mechanicalDowntiltDeg: 10 });
    expect(a.downElevationDeg).toBeCloseTo(10, 10);
    expect(Math.abs(a.azimuthDeg)).toBeCloseTo(180, 10);
  });

  it('keeps a unit vector and refuses a zero direction', () => {
    const a = toAntennaFrame(
      { east: 3, north: -4, up: -12 },
      { trueAzimuthDeg: 77, mechanicalDowntiltDeg: 6 },
    );
    expect(Math.hypot(a.forward, a.right, a.up)).toBeCloseTo(1, 12);
    expect(() =>
      toAntennaFrame({ east: 0, north: 0, up: 0 }, { trueAzimuthDeg: 0, mechanicalDowntiltDeg: 0 }),
    ).toThrow();
  });
});

describe('directionToAntennaFrame (grid offsets, grid azimuth and convergence)', () => {
  it('convergence cancels when both the azimuth and the direction are on the grid', () => {
    // Grid azimuth 120, target 32.5 deg clockwise of it on the grid: 32.5 deg off boresight
    // whatever the convergence, because both sides turn by the same angle.
    const off = dir(152.5);
    for (const c of [0, 1.5, -2]) {
      const a = directionToAntennaFrame(off, {
        azimuthGridDeg: 120,
        convergenceDeg: c,
        mechanicalDowntiltDeg: 0,
      });
      expect(a.azimuthDeg).toBeCloseTo(32.5, 10);
    }
  });
  it('using the true azimuth with a grid direction is the wrong-way error it guards against', () => {
    // The mistake: true azimuth (121.5) against a grid bearing (152.5) gives 31 deg, not 32.5.
    const wrong = toAntennaFrame(dir(152.5), {
      trueAzimuthDeg: trueAzimuthDeg(120, 1.5),
      mechanicalDowntiltDeg: 0,
    });
    expect(wrong.azimuthDeg).toBeCloseTo(31, 10);
  });
  it('refuses a null convergence', () => {
    expect(() =>
      directionToAntennaFrame(dir(0), {
        azimuthGridDeg: 0,
        convergenceDeg: null,
        mechanicalDowntiltDeg: 0,
      }),
    ).toThrow(/convergence/i);
  });
});
