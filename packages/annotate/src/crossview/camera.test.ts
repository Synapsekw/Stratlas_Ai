import type { Layer, Quat, Sighting } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { sightingCamera, type CameraSources } from './camera';

const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const layers: Layer[] = [
  {
    kind: 'photos',
    id: 'photos',
    name: 'Photos',
    visible: true,
    items: [
      {
        id: 'F01',
        src: { path: 'photos/F01.jpg' },
        pos: [3, 10, 4],
        q: down,
        lens: { model: 'pinhole', hfovDeg: 90, aspect: 4 / 3 },
      },
      { id: 'nopose', src: { path: 'photos/x.jpg' } },
    ],
  },
];
const src = (size: [number, number] | null): CameraSources => ({
  layers: () => layers,
  flight: () => null,
  imageSize: () => size,
});
const box: Sighting = {
  on: 'image',
  layer: 'photos',
  photo: 'F01',
  geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 },
};

describe('sightingCamera', () => {
  it('builds the photo camera with its pixel size and shape', () => {
    expect(sightingCamera(box, src([1200, 900]))).toEqual({
      pose: { pos: [3, 10, 4], q: down },
      lens: { model: 'pinhole', hfovDeg: 90, aspect: 4 / 3 },
      size: [1200, 900],
      geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 },
    });
  });

  it('has no camera without a pose or a known size', () => {
    expect(sightingCamera(box, src(null))).toBeNull();
    expect(sightingCamera({ ...box, photo: 'nopose' }, src([10, 10]))).toBeNull();
    expect(sightingCamera({ on: 'map', layer: 'photos', geojson: {} }, src([10, 10]))).toBeNull();
  });
});
