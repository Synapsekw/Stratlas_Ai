import { describe, expect, it } from 'vitest';
import { crsLabel, formatEastNorth, formatLocal, headingDeg, localToProject } from './coords';

describe('crsLabel', () => {
  it('names UTM zones', () => {
    expect(crsLabel({ epsg: 32639 })).toBe('UTM 39N · WGS84');
    expect(crsLabel({ epsg: 32739 })).toBe('UTM 39S · WGS84');
  });
  it('falls back to the EPSG code or a generic name', () => {
    expect(crsLabel({ epsg: 2193 })).toBe('EPSG 2193');
    expect(crsLabel({ wkt: 'PROJCS[...]' })).toBe('Project CRS');
  });
});

describe('localToProject', () => {
  it('applies the data conventions: E = x, N = -z, H = y', () => {
    expect(localToProject([245000, 3179000, 100], [10, 4, -20])).toEqual([245010, 3179020, 104]);
  });
});

describe('formatting', () => {
  it('groups easting and northing in threes', () => {
    expect(formatEastNorth(245884.94, 3179597.12)).toBe('E 245 884.9  N 3 179 597.1');
  });
  it('formats local coordinates', () => {
    expect(formatLocal([1.234, -0.5, 12])).toBe('X 1.23  Y -0.50  Z 12.00');
  });
});

describe('headingDeg', () => {
  it('measures clockwise from north (-Z)', () => {
    expect(headingDeg(0, -1)).toBeCloseTo(0);
    expect(headingDeg(1, 0)).toBeCloseTo(90);
    expect(headingDeg(0, 1)).toBeCloseTo(180);
    expect(headingDeg(-1, 0)).toBeCloseTo(270);
  });
});
