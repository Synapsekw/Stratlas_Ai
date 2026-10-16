import { expect, it } from 'vitest';
import { photosInRect } from './photoBox';

it('picks the photos whose screen point lies in the box, whichever way it was dragged', () => {
  const pts = [
    { layerId: 'ph', photoId: 'a', x: 10, y: 10 },
    { layerId: 'ph', photoId: 'b', x: 50, y: 60 },
    { layerId: 'ph', photoId: 'c', x: 200, y: 5 },
  ];
  expect(photosInRect(pts, { x0: 100, y0: 100, x1: 0, y1: 0 }).map((p) => p.photoId)).toEqual([
    'a',
    'b',
  ]);
});
