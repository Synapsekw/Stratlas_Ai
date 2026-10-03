import { describe, expect, it } from 'vitest';
import {
  createFrame,
  crsDefinition,
  fromWgs84,
  localToProject,
  projectToLocal,
  toWgs84,
  utmToWgs84,
  wgs84ToUtm,
} from './index';

const close = (a: readonly number[], b: readonly number[], tol: number) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => {
    expect(Math.abs(v - (b[i] ?? Number.NaN))).toBeLessThan(tol);
  });
};

describe('createFrame', () => {
  it('round-trips UTM coordinates to 1 mm', () => {
    const f = createFrame([245_000, 3_179_000, 0], 32639);
    const p: [number, number, number] = [245_884.9123, 3_179_597.1456, 151.5];
    const back = f.toProject(f.toLocal(p));
    back.forEach((v, i) => {
      expect(Math.abs(v - (p[i] ?? 0))).toBeLessThan(0.001);
    });
  });

  it('puts the origin at local zero', () => {
    const f = createFrame([10, 20, 30], 32639);
    expect(f.toLocal([10, 20, 30])).toEqual([0, 0, 0]);
  });

  it('follows the local frame convention (Y up, X east, Z south)', () => {
    const f = createFrame([1000, 2000, 50], 32639);
    // 10 m east, 20 m north, 5 m up
    expect(f.toLocal([1010, 2020, 55])).toEqual([10, 5, -20]);
  });
});

describe('localToProject / projectToLocal', () => {
  const origin: [number, number, number] = [244_338.07, 3_179_515.72, 100];

  it('maps east to +x, north to -z and height to +y', () => {
    expect(localToProject([1, 0, 0], origin)).toEqual([origin[0] + 1, origin[1], origin[2]]);
    expect(localToProject([0, 0, -1], origin)).toEqual([origin[0], origin[1] + 1, origin[2]]);
    expect(localToProject([0, 2, 0], origin)).toEqual([origin[0], origin[1], origin[2] + 2]);
  });

  it('applies N = origin_y - z', () => {
    const [, n] = localToProject([0, 0, 12.5], origin);
    expect(n).toBeCloseTo(origin[1] - 12.5, 9);
  });

  it('round-trips at UTM magnitudes to well under 1 mm', () => {
    const p: [number, number, number] = [245_123.4567, 3_180_001.2345, 133.21];
    close(localToProject(projectToLocal(p, origin), origin), p, 1e-6);
  });
});

describe('CRS registry', () => {
  it('bundles WGS84 and UTM definitions', () => {
    expect(crsDefinition(4326)).toContain('longlat');
    expect(crsDefinition(32639)).toContain('+zone=39');
    expect(crsDefinition(32739)).toContain('+south');
    expect(() => crsDefinition(99999)).toThrow('EPSG:99999');
  });
});

describe('UTM 39N <-> WGS84', () => {
  // Al-Zour plant grid origin in UTM 39N (from the Mission mockup's PL2UTM).
  it('converts a Kuwait coastal point to lat/lon and back', () => {
    const [lon, lat] = utmToWgs84(244_338.07, 3_179_515.72, 39);
    expect(lat).toBeGreaterThan(28.6);
    expect(lat).toBeLessThan(28.8);
    expect(lon).toBeGreaterThan(48.3);
    expect(lon).toBeLessThan(48.5);
    const [e, n] = wgs84ToUtm(lon, lat, 39);
    close([e, n], [244_338.07, 3_179_515.72], 0.001);
  });

  it('puts the central meridian of zone 39 at easting 500 000', () => {
    const [e, n] = wgs84ToUtm(51, 0, 39);
    close([e, n], [500_000, 0], 0.001);
  });

  it('matches the meridian arc on the central meridian (51E, 29N)', () => {
    // On the central meridian E is the false easting and N = k0 * M(phi). Reference computed
    // independently with the WGS84 meridian arc series: 3 207 985.616 m.
    const [e, n] = wgs84ToUtm(51, 29, 39);
    expect(e).toBeCloseTo(500_000, 3);
    expect(Math.abs(n - 3_207_985.616)).toBeLessThan(0.01);
  });

  it('converts through an EPSG code for the project CRS', () => {
    const ll = toWgs84([500_000, 0, 7], 32639);
    close(ll, [51, 0, 7], 1e-9);
    close(fromWgs84(ll, 32639), [500_000, 0, 7], 1e-6);
  });
});
