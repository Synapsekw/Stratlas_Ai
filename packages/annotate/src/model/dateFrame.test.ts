import { fromWgs84, toWgs84 } from '@aio/geo';
import type { Sighting } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { linedUp } from '../testing';
import { movedSighting, shiftOfManifest, sightingInDateFrame } from './dateFrame';

const lonLatOf = (e: number, n: number): [number, number] => {
  const [lon, lat] = toWgs84([e, n, 0], 32639);
  return [lon, lat];
};

describe('sightings drawn on a lined-up date', () => {
  it('gives each layer its date shift', () => {
    const shiftOf = shiftOfManifest(linedUp);
    expect(shiftOf('model-d2')).toEqual({ eastM: 2, northM: 0 });
    expect(shiftOf('model-d1')).toBeNull();
    expect(shiftOfManifest(null)('model-d2')).toBeNull();
  });

  it("stores a mesh sighting placed on a shifted date in the date's own frame", () => {
    const picked: Sighting = {
      on: 'mesh',
      layer: 'model-d2',
      geom: { type: 'spoint', p: [12, 1, -3], n: [0, 1, 0] },
    };
    expect(sightingInDateFrame(picked, linedUp)).toEqual({
      on: 'mesh',
      layer: 'model-d2',
      geom: { type: 'spoint', p: [10, 1, -3], n: [0, 1, 0] },
    });
    const outline: Sighting = {
      on: 'mesh',
      layer: 'model-d2',
      geom: {
        type: 'spolygon',
        points: [
          [12, 0, 0],
          [14, 0, 0],
          [13, 0, 1],
        ],
      },
    };
    const stored = sightingInDateFrame(outline, linedUp);
    expect(stored.on === 'mesh' && stored.geom.type === 'spolygon' && stored.geom.points).toEqual([
      [10, 0, 0],
      [12, 0, 0],
      [11, 0, 1],
    ]);
    // a date that did not move keeps its pick
    const other = { ...picked, layer: 'model-d1' };
    expect(sightingInDateFrame(other, linedUp)).toBe(other);
  });

  it('stores a cloud sighting placed on a shifted date without the shift', () => {
    const box: Sighting = {
      on: 'pointcloud',
      layer: 'cloud-d2',
      geom: { type: 'box3', min: [12, 0, 0], max: [13, 1, 1] },
    };
    expect(sightingInDateFrame(box, linedUp)).toEqual({
      on: 'pointcloud',
      layer: 'cloud-d2',
      geom: { type: 'box3', min: [10, 0, 0], max: [11, 1, 1] },
    });
    const point: Sighting = {
      on: 'pointcloud',
      layer: 'cloud-d2',
      geom: { type: 'point3', p: [2, 0, 5] },
    };
    expect(sightingInDateFrame(point, linedUp)).toEqual({
      ...point,
      geom: { type: 'point3', p: [0, 0, 5] },
    });
  });

  it('says so when a map sighting is saved drawn because the CRS is unknown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const drawn: Sighting = {
      on: 'map',
      layer: 'ortho-d2',
      geojson: { type: 'Point', coordinates: [48, 29] },
    };
    const shift = { eastM: 2, northM: 0 };
    expect(movedSighting(drawn, shift, -1, { wkt: 'LOCAL_CS["site"]' })).toBe(drawn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('ortho-d2');
    // drawing it does not warn: only a save keeps the drawn place
    movedSighting(drawn, shift, 1, { wkt: 'LOCAL_CS["site"]' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("stores a map sighting placed on a shifted date in the date's own frame", () => {
    // drawn on the lined-up ortho at E 500012, N 3200000: saved 2 m west, at E 500010
    const at = lonLatOf(500012, 3200000);
    const drawn: Sighting = {
      on: 'map',
      layer: 'ortho-d2',
      geojson: { type: 'Point', coordinates: at, bbox: [...at, ...at] },
    };
    const stored = sightingInDateFrame(drawn, linedUp);
    // a bounding box no longer holds once the positions move
    expect(stored.on === 'map' && 'bbox' in stored.geojson).toBe(false);
    const c = stored.on === 'map' ? (stored.geojson.coordinates as number[]) : [];
    const [e, n] = fromWgs84([c[0] ?? 0, c[1] ?? 0, 0], 32639);
    expect(e).toBeCloseTo(500010, 3);
    expect(n).toBeCloseTo(3200000, 3);
    // a polygon: every vertex moves, the ring stays closed
    const ring = [lonLatOf(500012, 3200000), lonLatOf(500014, 3200000), lonLatOf(500012, 3200000)];
    const poly = sightingInDateFrame(
      { on: 'map', layer: 'ortho-d2', geojson: { type: 'Polygon', coordinates: [ring] } },
      linedUp,
    );
    const out = poly.on === 'map' ? (poly.geojson.coordinates as number[][][])[0] : undefined;
    const es = (out ?? []).map(([lon = 0, lat = 0]) => fromWgs84([lon, lat, 0], 32639)[0]);
    expect(es.map((v) => Math.round(v * 1000) / 1000)).toEqual([500010, 500012, 500010]);
  });

  it('keeps image, video and pano sightings as they are', () => {
    const img: Sighting = {
      on: 'image',
      layer: 'model-d2',
      photo: 'F01',
      geom: { type: 'point', x: 1, y: 2 },
    };
    expect(sightingInDateFrame(img, linedUp)).toBe(img);
  });
});
