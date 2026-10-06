import { describe, expect, it } from 'vitest';
import { vectorChanges } from './vector';

/** About 1 m of longitude and latitude near the equator (synthetic site at 0, 0). */
const M = 1 / 111_195;
const line = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0 * M, y0 * M],
  [x1 * M, y1 * M],
];
const feature = (props: Record<string, unknown>, coordinates: number[][], id?: string) => ({
  type: 'Feature',
  ...(id ? { id } : {}),
  properties: props,
  geometry: { type: 'LineString', coordinates },
});
const fc = (...features: unknown[]) => ({ type: 'FeatureCollection', features });

describe('vector change of two counterpart layers', () => {
  const items = vectorChanges({
    layerFrom: 'tracks-d1',
    layerTo: 'tracks-d2',
    from: fc(
      feature({ name: 'Fence F-2', kind: 'fence' }, line(0, 0, 100, 0)),
      feature({ name: 'Gate', kind: 'gate', state: 'open' }, line(200, 0, 205, 0)),
      feature({ kind: 'drain' }, line(300, 0, 300, 50)),
      feature({ name: 'Old track' }, line(500, 0, 600, 0)),
    ),
    to: fc(
      // moved 3 m north
      feature({ name: 'Fence F-2', kind: 'fence' }, line(0, 3, 100, 3)),
      // attribute only
      feature({ name: 'Gate', kind: 'gate', state: 'closed' }, line(200, 0, 205, 0)),
      // no name: matched by geometry, reshaped
      feature({ kind: 'drain' }, [
        [300 * M, 0],
        [305 * M, 25 * M],
        [300 * M, 50 * M],
      ]),
      // added
      feature({ name: 'New track' }, line(700, 0, 800, 0)),
    ),
    toLocal: ([lon, lat]) => [lon / M, 0, -lat / M],
  });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));

  it('matches by name and finds the moved fence with its distance', () => {
    expect(by['vector:tracks-d1:Fence F-2']).toMatchObject({
      verdict: 'moved',
      method: 'property',
      layerFrom: 'tracks-d1',
      layerTo: 'tracks-d2',
    });
    const d = by['vector:tracks-d1:Fence F-2'];
    expect(d?.kind === 'vector' && d.distanceM).toBeCloseTo(3, 1);
    expect(d?.label).toBe('Fence F-2 moved 3 m');
  });

  it('reports an attribute-only change with the keys', () => {
    expect(by['vector:tracks-d1:Gate']).toMatchObject({ verdict: 'attributes', keys: ['state'] });
  });

  it('matches by geometry without a key and calls a bent line reshaped', () => {
    expect(by['vector:tracks-d1:#2']).toMatchObject({ verdict: 'reshaped', method: 'geometry' });
  });

  it('lists removed and added features, placed in the local frame', () => {
    expect(by['vector:tracks-d1:Old track']).toMatchObject({ verdict: 'removed' });
    const added = by['vector:tracks-d1:New track'];
    expect(added).toMatchObject({ verdict: 'added', featureTo: 3 });
    expect(added?.at?.[0]).toBeCloseTo(750, 0);
  });

  it('matches by the top-level feature id first', () => {
    const r = vectorChanges({
      layerFrom: 'a',
      layerTo: 'b',
      from: fc(feature({ name: 'x' }, line(0, 0, 10, 0), 'f1')),
      to: fc(feature({ name: 'renamed' }, line(0, 0, 10, 0), 'f1')),
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'vector:a:f1', verdict: 'attributes', keys: ['name'] });
  });
});
