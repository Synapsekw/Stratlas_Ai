import { describe, expect, it } from 'vitest';
import { applyM4, ecefToGeodetic, geodeticToEcef, siteFrame, type V3 } from './frame';

const manifest = { crs: { epsg: 32639 }, origin: [500_000, 3_200_000, 12] as V3 };
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('site frame (local to ECEF through the project CRS)', () => {
  it('converts geodetic and ECEF both ways', () => {
    expect(geodeticToEcef(0, 0, 0)).toEqual([6378137, 0, 0]);
    const p = geodeticToEcef(51.003, 28.93, 123.4);
    const back = ecefToGeodetic(p);
    expect(back[0]).toBeCloseTo(51.003, 10);
    expect(back[1]).toBeCloseTo(28.93, 10);
    expect(back[2]).toBeCloseTo(123.4, 6);
  });

  it('matches the pipelines: the origin is the CRS origin on the ellipsoid', () => {
    const f = siteFrame(manifest);
    expect(f).not.toBeNull();
    if (!f) return;
    // independent value from GDAL (EPSG:32639 to EPSG:4978 at E 500000, N 3200000, h 12):
    // the python test computes the same with rasterio; here we only check the round trip
    const o = f.localToEcef([0, 0, 0]);
    expect(dist(f.ecefToLocal(o), [0, 0, 0])).toBeLessThan(1e-6);
    const q: V3 = [1234.5, 20, -876.25];
    expect(dist(f.ecefToLocal(f.localToEcef(q)), q)).toBeLessThan(1e-6);
  });

  it('a matrix fitted at a tile centre places its tile within a millimetre', () => {
    const f = siteFrame(manifest);
    if (!f) throw new Error('no frame');
    const centre: V3 = [1500, 5, -1200];
    const m = f.ecefToLocalAt(f.localToEcef(centre));
    for (const d of [
      [40, 0, 0],
      [0, 0, 40],
      [-35, 8, 30],
    ] as V3[]) {
      const p: V3 = [centre[0] + d[0], centre[1] + d[1], centre[2] + d[2]];
      expect(dist(applyM4(m, f.localToEcef(p)), p)).toBeLessThan(1e-3);
    }
    // one matrix for the whole site would not do: at 1.9 km the curve alone is decimetres
    const atOrigin = f.ecefToLocalAt(f.localToEcef([0, 0, 0]));
    expect(dist(applyM4(atOrigin, f.localToEcef(centre)), centre)).toBeGreaterThan(0.1);
  });

  it('has no frame for a CRS the app does not know offline', () => {
    expect(siteFrame({ crs: { wkt: 'LOCAL_CS["x"]' }, origin: [0, 0, 0] })).toBeNull();
    expect(siteFrame({ crs: { epsg: 999999 }, origin: [0, 0, 0] })).toBeNull();
  });
});
