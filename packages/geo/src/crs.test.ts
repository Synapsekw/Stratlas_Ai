import { describe, expect, it } from 'vitest';
import { GCC_CRS, gridConvergenceDeg, searchCrs, utmEpsgFor } from './crs';
import { fromWgs84 } from './index';

describe('GCC_CRS', () => {
  it('lists the WGS84 UTM north zones that cover the GCC', () => {
    expect(GCC_CRS.map((c) => c.epsg)).toEqual([32636, 32637, 32638, 32639, 32640]);
    expect(GCC_CRS.find((c) => c.epsg === 32639)?.label).toContain('Kuwait');
  });
});

describe('utmEpsgFor', () => {
  it('picks the zone from the longitude, north or south', () => {
    expect(utmEpsgFor(48.0, 29.4)).toBe(32639); // Kuwait City
    expect(utmEpsgFor(55.3, 25.2)).toBe(32640); // Dubai
    expect(utmEpsgFor(46.7, 24.7)).toBe(32638); // Riyadh
    expect(utmEpsgFor(18.4, -33.9)).toBe(32734); // Cape Town
  });
});

describe('searchCrs', () => {
  it('finds zones by country, zone number or EPSG code', () => {
    expect(searchCrs('dubai').map((c) => c.epsg)).toContain(32640);
    expect(searchCrs('39N').map((c) => c.epsg)).toEqual([32639]);
    expect(searchCrs('32638').map((c) => c.epsg)).toEqual([32638]);
  });

  it('offers any bundled EPSG code typed in full, outside the GCC list', () => {
    expect(searchCrs('EPSG:32633').map((c) => c.epsg)).toEqual([32633]);
    expect(searchCrs('4326').map((c) => c.epsg)).toEqual([4326]);
  });

  it('returns the whole GCC list for an empty query and nothing for unknown codes', () => {
    expect(searchCrs('')).toHaveLength(GCC_CRS.length);
    expect(searchCrs('99999')).toEqual([]);
  });
});

describe('gridConvergenceDeg', () => {
  it('is zero on the central meridian and grows away from it', () => {
    expect(Math.abs(gridConvergenceDeg(51, 29, 32639))).toBeLessThan(1e-6);
    const east = gridConvergenceDeg(53, 29, 32639);
    // gamma ~ dLon * sin(lat) = 2 * sin(29 deg) = 0.97 deg, true north west of grid north east of CM
    expect(east).toBeGreaterThan(0.9);
    expect(east).toBeLessThan(1.05);
    expect(gridConvergenceDeg(49, 29, 32639)).toBeCloseTo(-east, 3);
  });

  it('turns a true bearing into a grid bearing', () => {
    // a point 1 km true north of (48, 29.4) in zone 39 lies at grid azimuth -convergence
    const g = gridConvergenceDeg(48, 29.4, 32639);
    const a = fromWgs84([48, 29.4, 0], 32639);
    const b = fromWgs84([48, 29.4 + 1000 / 111_000, 0], 32639);
    const az = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
    expect(az).toBeCloseTo(-g, 2);
  });
});
