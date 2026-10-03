import { describe, expect, it } from 'vitest';
import { frameProjection, lonLatToUtm, utmToLonLat } from './geo';

// Reference values from proj4 (+proj=utm +zone=39 +datum=WGS84).
// Al-Zour LNG tank 20-T-0001: UTM 39N E 245747.13, N 3179641.87.
const TANK_UTM: [number, number] = [245747.13, 3179641.87];
const TANK_LONLAT: [number, number] = [48.39709173227198, 28.719105268785743];

describe('UTM <-> lon/lat', () => {
  it('converts the Al-Zour tank from UTM 39N to lon/lat within 1 cm', () => {
    const [lon, lat] = utmToLonLat(TANK_UTM[0], TANK_UTM[1], 39, false);
    expect(lon).toBeCloseTo(TANK_LONLAT[0], 7);
    expect(lat).toBeCloseTo(TANK_LONLAT[1], 7);
  });

  it('converts lon/lat to UTM 39N', () => {
    const [e, n] = lonLatToUtm(48.0, 29.0, 39, false);
    expect(e).toBeCloseTo(207728.92892990675, 2);
    expect(n).toBeCloseTo(3211697.373345432, 2);
  });

  it('round-trips', () => {
    const [lon, lat] = utmToLonLat(612345.6, 2712345.6, 40, false);
    const [e, n] = lonLatToUtm(lon, lat, 40, false);
    expect(e).toBeCloseTo(612345.6, 3);
    expect(n).toBeCloseTo(2712345.6, 3);
  });
});

describe('frameProjection', () => {
  // A project whose origin sits 100 m west and 50 m north of the tank.
  const origin: [number, number, number] = [TANK_UTM[0] - 100, TANK_UTM[1] + 50, 0];
  const proj = frameProjection({ epsg: 32639 }, origin);

  it('maps local (X east, Z south) to lon/lat via the manifest origin', () => {
    expect(proj).not.toBeNull();
    // Tank is +100 m east (x) and 50 m south (z = +50) of the origin.
    const ll = proj?.toLonLat([100, 0, 50]);
    expect(ll?.[0]).toBeCloseTo(TANK_LONLAT[0], 7);
    expect(ll?.[1]).toBeCloseTo(TANK_LONLAT[1], 7);
  });

  it('maps lon/lat back to local', () => {
    const p = proj?.toLocal(TANK_LONLAT[0], TANK_LONLAT[1]);
    expect(p?.[0]).toBeCloseTo(100, 2);
    expect(p?.[2]).toBeCloseTo(50, 2);
  });

  it('supports geographic projects', () => {
    const geo = frameProjection({ epsg: 4326 }, [48, 29, 0]);
    expect(geo?.toLonLat([0, 0, 0])).toEqual([48, 29]);
  });

  it('returns null for an unsupported CRS', () => {
    expect(frameProjection({ epsg: 2154 }, [0, 0, 0])).toBeNull();
    expect(frameProjection({ wkt: 'LOCAL_CS["plant"]' }, [0, 0, 0])).toBeNull();
  });
});
