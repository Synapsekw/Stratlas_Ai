import { describe, expect, it } from 'vitest';
import { photosFromClusterLeaves } from './photoPins';

describe('photosFromClusterLeaves', () => {
  it('keeps the leaves that name a photo', () => {
    expect(
      photosFromClusterLeaves([
        { properties: { photoLayer: 'ph', photoId: 'a' } },
        { properties: { photoId: 'b' } },
        { properties: null },
        { properties: { photoLayer: 'other', photoId: 'c' } },
      ]),
    ).toEqual([
      { layerId: 'ph', photoId: 'a' },
      { layerId: 'other', photoId: 'c' },
    ]);
  });
});
