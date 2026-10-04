import { describe, expect, it } from 'vitest';
import { bboxPolygon, coverageFeatures, dragBbox } from './coverageData';

const kuwait = {
  id: 'kuwait',
  label: 'Kuwait streets',
  bbox: [46.5, 28.5, 48.5, 30.1] as [number, number, number, number],
  maxZoom: 15,
  sizeBytes: 1,
};
const world = {
  ...kuwait,
  id: 'world',
  label: 'World',
  bbox: [-180, -85, 180, 85] as const,
  maxZoom: 6,
};

describe('coverage map data', () => {
  it('draws a closed ring for a box', () => {
    expect(bboxPolygon([1, 2, 3, 4]).coordinates).toEqual([
      [
        [1, 2],
        [3, 2],
        [3, 4],
        [1, 4],
        [1, 2],
      ],
    ]);
  });

  it('marks the highlighted pack and leaves the world pack out of the outlines', () => {
    const fc = coverageFeatures([kuwait, { ...world, bbox: [-180, -85, 180, 85] }], 'kuwait');
    expect(fc.packs.features).toHaveLength(1);
    expect(fc.packs.features[0]?.properties).toEqual({
      id: 'kuwait',
      label: 'Kuwait streets',
      hi: true,
    });
    expect(fc.draft.features).toEqual([]);
  });

  it('adds the draft region', () => {
    const fc = coverageFeatures([], null, [50, 24, 52, 26]);
    expect(fc.draft.features).toHaveLength(1);
  });

  it('turns a drag between two points into a box', () => {
    expect(dragBbox({ lng: 52, lat: 24 }, { lng: 50.5, lat: 26.25 })).toEqual([
      50.5, 24, 52, 26.25,
    ]);
    expect(dragBbox({ lng: 50, lat: 24 }, { lng: 50, lat: 24 })).toBeNull();
  });
});
