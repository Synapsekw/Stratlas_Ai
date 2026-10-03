import { describe, expect, it } from 'vitest';
import {
  cloudBoxSighting,
  cloudPointSighting,
  cloudPolygonSighting,
  pointsInBox,
  pointsInPolygon,
} from './cloud';
import { mapDrawReducer, initialMapDraw, mapSightingFromDraw } from './map';

describe('point cloud sightings', () => {
  it('makes a point sighting', () => {
    expect(cloudPointSighting('cloud', [1, 2, 3])).toEqual({
      on: 'pointcloud',
      layer: 'cloud',
      geom: { type: 'point3', p: [1, 2, 3] },
    });
  });

  it('makes a box from two corners in any order, padded', () => {
    expect(cloudBoxSighting('cloud', [2, 0, 5], [0, 3, 1], 0.5).geom).toEqual({
      type: 'box3',
      min: [-0.5, -0.5, 0.5],
      max: [2.5, 3.5, 5.5],
    });
  });

  it('makes a polygon region with a height', () => {
    const s = cloudPolygonSighting(
      'cloud',
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
      ],
      4,
    );
    expect(s.geom).toMatchObject({ type: 'polygon3', height: 4 });
  });

  const pos = new Float32Array([0, 0, 0, 1, 1, 1, 5, 5, 5, 0.5, 10, 0.5]);

  it('counts the points inside a box', () => {
    expect(pointsInBox(pos, { min: [-1, -1, -1], max: [2, 2, 2] })).toEqual([0, 1]);
  });

  it('selects points inside a ground polygon (XZ) within its height', () => {
    const ring: [number, number, number][] = [
      [-1, 0, -1],
      [2, 0, -1],
      [2, 0, 2],
      [-1, 0, 2],
    ];
    expect(pointsInPolygon(pos, ring)).toEqual([0, 1, 3]);
    expect(pointsInPolygon(pos, ring, 2)).toEqual([0, 1]);
  });
});

describe('map drawing', () => {
  it('a point finishes on the first click', () => {
    const s = mapDrawReducer(initialMapDraw('point'), { type: 'click', lngLat: [47.9, 29.3] });
    expect(s.done).toBe(true);
    expect(mapSightingFromDraw('basemap', s)).toEqual({
      on: 'map',
      layer: 'basemap',
      geojson: { type: 'Point', coordinates: [47.9, 29.3] },
    });
  });

  it('a polygon collects vertices and closes its ring on finish', () => {
    let s = initialMapDraw('polygon');
    for (const p of [
      [0, 0],
      [1, 0],
      [1, 1],
    ] as [number, number][]) {
      s = mapDrawReducer(s, { type: 'click', lngLat: p });
    }
    expect(mapSightingFromDraw('m', s)).toBeNull();
    s = mapDrawReducer(s, { type: 'finish' });
    expect(mapSightingFromDraw('m', s)?.geojson).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
  });

  it('a line needs two vertices; undo removes the last one; cancel clears', () => {
    let s = mapDrawReducer(initialMapDraw('line'), { type: 'click', lngLat: [0, 0] });
    s = mapDrawReducer(s, { type: 'finish' });
    expect(s.done).toBe(false);
    s = mapDrawReducer(s, { type: 'click', lngLat: [1, 1] });
    s = mapDrawReducer(s, { type: 'undo' });
    expect(s.vertices).toHaveLength(1);
    s = mapDrawReducer(s, { type: 'cancel' });
    expect(s.vertices).toEqual([]);
  });
});
