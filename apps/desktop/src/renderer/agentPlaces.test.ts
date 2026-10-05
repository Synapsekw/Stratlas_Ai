import type { RoadModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { chainageKm, chainagePlace, pilePlaces } from './agentPlaces';

describe('agent places', () => {
  it('reads chainages the ways people write them', () => {
    expect(chainageKm('km 12.4')).toBe(12.4);
    expect(chainageKm('chainage 3')).toBe(3);
    expect(chainageKm('ch 12+400')).toBeCloseTo(12.4);
    expect(chainageKm('7.25 km')).toBe(7.25);
    expect(chainageKm('tank 3')).toBeNull();
  });

  it('puts a chainage on the centreline', () => {
    const road = {
      centreline: {
        points: [
          [0, 0, 0],
          [1000, 0, 0],
          [1000, 0, -1000],
        ],
        chainageKm: [0, 1, 2],
      },
    } as unknown as RoadModel;
    const [p] = chainagePlace(road, 'km 1.5');
    expect(p).toMatchObject({ kind: 'chainage', name: 'km 1.5', p: [1000, 0, -500] });
    expect(p?.aliases).toEqual(['1+500']);
    expect(chainagePlace(road, 'the jetty')).toEqual([]);
  });

  it('sizes stockpiles by their zone and height', () => {
    const [p] = pilePlaces([
      {
        id: 'P1',
        name: 'Pile 1',
        material: 'Gabbro',
        zoneRing: [
          [0, 0],
          [20, 0],
          [20, 10],
          [0, 10],
        ],
        epochs: { e1: { heightM: 6 }, e2: { heightM: 8 } },
      },
    ]);
    expect(p).toMatchObject({
      id: 'pile:P1',
      kind: 'pile',
      detail: 'Gabbro',
      box: { min: [0, 0, 0], max: [20, 8, 10] },
      p: [10, 4, 5],
    });
  });
});
