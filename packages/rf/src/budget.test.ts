import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARGINS,
  DEFAULT_RSRP_THRESHOLDS,
  PENETRATION_MARGIN_DB,
  dbmFromWatts,
  eirpDbm,
  evaluatePoint,
  fadeMarginDb,
  inverseNormalCdf,
  margins,
  perReOffsetDb,
  rsrpClass,
  rsrpDbm,
  subcarrierCount,
  wattsFromDbm,
} from './budget';

describe('power and resource elements', () => {
  it('converts watts and dBm', () => {
    expect(dbmFromWatts(1)).toBeCloseTo(30, 12);
    expect(dbmFromWatts(20)).toBeCloseTo(43.0103, 4);
    expect(dbmFromWatts(40)).toBeCloseTo(46.0206, 4);
    expect(wattsFromDbm(46.0206)).toBeCloseTo(40, 3);
    expect(() => dbmFromWatts(0)).toThrow();
  });
  it('subcarriers are 12 N_RB (LTE 20 MHz 1200, NR 100 MHz at 30 kHz 3276)', () => {
    expect(subcarrierCount({ tech: 'lte', bandwidthMHz: 20 })).toBe(1200);
    expect(subcarrierCount({ tech: 'nr', bandwidthMHz: 100, scsKHz: 30 })).toBe(3276);
    // 10 log10(1200) = 30.792, 10 log10(3276) = 35.153
    expect(perReOffsetDb({ tech: 'lte', bandwidthMHz: 20 })).toBeCloseTo(30.7918, 4);
    expect(perReOffsetDb({ tech: 'nr', bandwidthMHz: 100, scsKHz: 30 })).toBeCloseTo(35.1534, 4);
  });
  it('EIRP is port power minus feeder loss plus gain', () => {
    expect(eirpDbm(46, 0.5, 17.5)).toBeCloseTo(63, 12);
  });
});

describe('margins (D13)', () => {
  it('presets: outdoor 0, in car 7, indoor 15, deep indoor 20', () => {
    expect(PENETRATION_MARGIN_DB).toEqual({
      outdoor: 0,
      'in-car': 7,
      indoor: 15,
      'deep-indoor': 20,
    });
  });
  it('inverse normal CDF', () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 9);
    expect(inverseNormalCdf(0.9)).toBeCloseTo(1.2815516, 6);
    expect(inverseNormalCdf(0.1)).toBeCloseTo(-1.2815516, 6);
    expect(inverseNormalCdf(0.95)).toBeCloseTo(1.6448536, 6);
    expect(inverseNormalCdf(0.99)).toBeCloseTo(2.3263479, 6);
    expect(inverseNormalCdf(0.999)).toBeCloseTo(3.0902323, 6);
    expect(inverseNormalCdf(0.01)).toBeCloseTo(-2.3263479, 6);
    expect(() => inverseNormalCdf(0)).toThrow();
    expect(() => inverseNormalCdf(1)).toThrow();
  });
  it('fade margin at 90 % edge probability is 1.28 sigma (10.25 dB for 8 dB)', () => {
    expect(fadeMarginDb(0.9, 8)).toBeCloseTo(10.2524, 4);
    expect(fadeMarginDb(0.5, 8)).toBeCloseTo(0, 9);
    expect(fadeMarginDb(0.9, 0)).toBe(0);
  });
  it('sums penetration, body loss and fade', () => {
    expect(DEFAULT_MARGINS).toEqual({
      marginPreset: 'outdoor',
      bodyLossDb: 3,
      edgeProbability: 0.9,
      shadowSigmaDb: 8,
    });
    const m = margins({ ...DEFAULT_MARGINS, marginPreset: 'indoor' });
    expect(m.penetrationDb).toBe(15);
    expect(m.bodyLossDb).toBe(3);
    expect(m.fadeDb).toBeCloseTo(10.2524, 4);
    expect(m.totalDb).toBeCloseTo(28.2524, 4);
  });
});

describe('RSRP', () => {
  it('RSRP = P - 10 log10(12 N_RB) - L + G + A - PL - margins, by hand', () => {
    // 43 - 30.7918 - 0.5 + 17.5 - 0 - 120 - (0 + 3 + 10.2524) = -104.0442
    const r = rsrpDbm({
      portPowerDbm: 43,
      subcarriers: 1200,
      feederLossDb: 0.5,
      antennaGainDbi: 17.5,
      patternLossDb: 0,
      pathLossDb: 120,
      marginDb: margins(DEFAULT_MARGINS).totalDb,
    });
    expect(r).toBeCloseTo(-104.0442, 4);
  });

  it('classes take the threshold as the floor of the better class', () => {
    expect(DEFAULT_RSRP_THRESHOLDS).toEqual({
      excellentDbm: -80,
      goodDbm: -95,
      fairDbm: -105,
      poorDbm: -115,
    });
    expect(rsrpClass(-70)).toBe('excellent');
    expect(rsrpClass(-80)).toBe('excellent');
    expect(rsrpClass(-80.01)).toBe('good');
    expect(rsrpClass(-95)).toBe('good');
    expect(rsrpClass(-100)).toBe('fair');
    expect(rsrpClass(-105)).toBe('fair');
    expect(rsrpClass(-110)).toBe('poor');
    expect(rsrpClass(-115)).toBe('poor');
    expect(rsrpClass(-115.01)).toBe('none');
    expect(rsrpClass(Number.NEGATIVE_INFINITY)).toBe('none');
    expect(rsrpClass(-90, { excellentDbm: -90, goodDbm: -100, fairDbm: -110, poorDbm: -120 })).toBe(
      'excellent',
    );
  });
});

describe('evaluatePoint', () => {
  it('chains grid geometry, the pattern and the budget', () => {
    // Antenna grid azimuth 90, convergence 1.5, no tilt; target 32.5 deg clockwise on the grid at
    // the horizon: horizontal 3 dB edge, so 3 dB below the boresight case.
    const b = Math.PI / 180;
    const base = {
      azimuthGridDeg: 90,
      convergenceDeg: 1.5,
      mechanicalDowntiltDeg: 0,
      pattern: { kind: 'parametric', hBeamwidthDeg: 65, vBeamwidthDeg: 7, eTiltDeg: 0 },
      portPowerDbm: 43,
      carrier: { tech: 'lte', bandwidthMHz: 20 },
      feederLossDb: 0.5,
      antennaGainDbi: 17.5,
      pathLossDb: 120,
      margins: DEFAULT_MARGINS,
    } as const;
    const r = evaluatePoint({
      ...base,
      directionGrid: { east: Math.sin(122.5 * b), north: Math.cos(122.5 * b), up: 0 },
    });
    expect(r.trueAzimuthDeg).toBeCloseTo(91.5, 12);
    expect(r.antennaAzimuthDeg).toBeCloseTo(32.5, 10);
    expect(r.antennaDownElevationDeg).toBeCloseTo(0, 10);
    expect(r.attenuationDb).toBeCloseTo(3, 10);
    expect(r.rsrpDbm).toBeCloseTo(-107.0442, 4);
    expect(r.rsrpClass).toBe('poor');
  });
});
