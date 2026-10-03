import { describe, expect, it } from 'vitest';
import { drawPreview, isRepeatClick, type MapLngLat } from './draw';

const a: MapLngLat = [48.1, 29.1];
const b: MapLngLat = [48.2, 29.1];
const c: MapLngLat = [48.2, 29.2];

describe('map draw preview', () => {
  it('is empty when not drawing', () => {
    expect(drawPreview(null, [a]).features).toEqual([]);
    expect(drawPreview('line', []).features).toEqual([]);
  });

  it('shows the vertices of a point or a single click', () => {
    const fc = drawPreview('point', [a]);
    expect(fc.features.map((f) => f.geometry.type)).toEqual(['Point']);
  });

  it('draws the line so far, and closes the ring of a polygon once it has three vertices', () => {
    const line = drawPreview('line', [a, b, c]);
    const path = line.features.find((f) => f.geometry.type === 'LineString');
    expect(path?.geometry).toEqual({ type: 'LineString', coordinates: [a, b, c] });
    const poly = drawPreview('polygon', [a, b, c]);
    const ring = poly.features.find((f) => f.geometry.type === 'LineString');
    expect(ring?.geometry).toEqual({ type: 'LineString', coordinates: [a, b, c, a] });
    expect(drawPreview('polygon', [a, b]).features.at(-1)?.geometry).toEqual({
      type: 'LineString',
      coordinates: [a, b],
    });
  });
});

describe('repeat clicks', () => {
  it('drops the second click of a double click but keeps distinct or later clicks', () => {
    const first = { x: 100, y: 100, t: 0 };
    expect(isRepeatClick(null, first)).toBe(false);
    expect(isRepeatClick(first, { x: 101, y: 102, t: 200 })).toBe(true);
    expect(isRepeatClick(first, { x: 140, y: 100, t: 200 })).toBe(false);
    expect(isRepeatClick(first, { x: 100, y: 100, t: 2000 })).toBe(false);
  });
});
