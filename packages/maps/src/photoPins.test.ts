import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { addPhotoPins, photosFromClusterLeaves } from './photoPins';

describe('addPhotoPins', () => {
  it('keeps the photo points as an invisible, queryable layer under the markers', () => {
    const added: { id: string; paint?: Record<string, unknown> }[] = [];
    const map = {
      addSource: () => undefined,
      addLayer: (l: { id: string; paint?: Record<string, unknown> }) => added.push(l),
    } as unknown as MapLibreMap;
    addPhotoPins(map);
    expect(added.map((l) => l.id)).toEqual(['aio-photos-cluster', 'aio-photos-pt']);
    const pt = added.find((l) => l.id === 'aio-photos-pt');
    expect(pt?.paint?.['circle-opacity']).toBe(0);
    expect(pt?.paint?.['circle-stroke-opacity']).toBe(0);
    expect(pt?.paint?.['circle-radius']).toBe(14);
  });
});

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
