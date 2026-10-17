import { createWorkspace } from '@aio/workspace';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { frameProjection } from './geo';
import { addPhotoPins, photoPoints, photosFromClusterLeaves } from './photoPins';

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

const ORIGIN: [number, number, number] = [500_000, 4_000_000, 0];
const proj = frameProjection({ epsg: 32633 }, ORIGIN);

function workspace(lineUp: boolean) {
  const store = createWorkspace();
  const photos = {
    kind: 'photos',
    id: 'ph',
    name: 'Photos',
    visible: true,
    capture: 'd2',
    items: [{ id: 'a', name: 'a.jpg', src: { path: 'a.jpg' }, pos: [5, 20, 6] }],
  };
  store.setState({
    project: {
      id: 'p1',
      manifest: {
        crs: { epsg: 32633 },
        origin: ORIGIN,
        captures: [
          {
            id: 'd2',
            label: 'Second',
            date: '2026-02-10',
            ...(lineUp
              ? { lineUp: { eastM: 2, northM: 0, with: 'd1', at: '2026-10-16T08:00:00Z' } }
              : {}),
          },
        ],
        layers: [photos],
      },
    } as unknown as ReturnType<typeof store.getState>['project'],
  });
  return store.getState();
}

describe('photo pins', () => {
  it('moves a photo pin after its correction', () => {
    if (!proj) throw new Error('projection');
    const at = (s: ReturnType<typeof workspace>) => {
      const p = photoPoints(s, proj)[0];
      if (!p) throw new Error('pin');
      return proj.toLocal(p[0], p[1]);
    };
    const base = at(workspace(false));
    const moved = at(workspace(true));
    expect(moved[0] - base[0]).toBeCloseTo(2, 3);
    expect(moved[2]).toBeCloseTo(base[2], 3);
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
