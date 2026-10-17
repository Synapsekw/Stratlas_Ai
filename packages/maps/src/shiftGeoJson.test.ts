import { describe, expect, it } from 'vitest';
import { frameProjection } from './geo';
import { shiftedGeoJson } from './shiftGeoJson';

const proj = frameProjection({ epsg: 32639 }, [245747.13, 3179641.87, 0]);
if (!proj) throw new Error('projection');

describe('shiftedGeoJson', () => {
  it('moves every position of a GeoJSON by the shift', () => {
    const at = proj.toLonLat([10, 0, 20]);
    const gj: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { n: 1 }, geometry: { type: 'Point', coordinates: at } },
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [at, [at[0], at[1], 5]] },
        },
      ],
    };
    const out = shiftedGeoJson(gj, { eastM: 2, northM: 0 }, proj) as GeoJSON.FeatureCollection;
    const first = out.features[0];
    if (first?.geometry.type !== 'Point') throw new Error('point');
    const [x, , z] = proj.toLocal(
      first.geometry.coordinates[0] ?? 0,
      first.geometry.coordinates[1] ?? 0,
    );
    expect(x).toBeCloseTo(12, 3);
    expect(z).toBeCloseTo(20, 3);
    expect(first.properties).toEqual({ n: 1 });
    const line = out.features[1]?.geometry;
    if (line?.type !== 'LineString') throw new Error('line');
    expect(line.coordinates[1]?.[2]).toBe(5);
    expect(gj.features[0]?.geometry).toEqual({ type: 'Point', coordinates: at });
  });
});
