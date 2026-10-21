// @vitest-environment jsdom
import type { HeightTiles, ProjectManifest, SitePoint } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { compareStore } from './compareStore';
import { groundAt, hasPrepared, setDateSurfaceSource } from './dateSurfaces';

const surface = (id: string, capture: string, extra: Partial<HeightTiles> = {}) =>
  ({
    id,
    name: id,
    capture,
    source: { kind: 'photogrammetry' },
    fingerprint: id,
    ...extra,
  }) as unknown as HeightTiles;

const manifest = {
  origin: [0, 0, 0],
  layers: [],
  captures: [
    { id: 'd1', label: 'one', date: '2026-01-01' },
    { id: 'd2', label: 'two', date: '2026-02-01', lineUp: { eastM: 2, northM: 0 } },
  ],
} as unknown as Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>;

afterEach(() => {
  setDateSurfaceSource(null);
  compareStore.setState({ surfaces: [] });
});

describe('hasPrepared', () => {
  it('is false for a date whose only surface is of another date', () => {
    const surfaces = [surface('s1', 'd1')];
    expect(hasPrepared(surfaces, 'd1')).toBe(true);
    expect(hasPrepared(surfaces, 'd2')).toBe(false);
  });
});

describe('groundAt', () => {
  it('samples a lined-up date at drawn minus its shift plus the prepared shift', async () => {
    compareStore.setState({
      surfaces: [surface('s2', 'd2', { dateShiftM: { eastM: 0.5, northM: 0 } })],
    });
    const asked: { es: number[]; ns: number[] } = { es: [], ns: [] };
    setDateSurfaceSource(() =>
      Promise.resolve((es, ns) => {
        asked.es.push(...es);
        asked.ns.push(...ns);
        return Promise.resolve(Float64Array.from(es, () => 7));
      }),
    );
    const drawn: SitePoint[] = [[10, 0, 0]];
    const h = await groundAt('d2', drawn, manifest);
    expect(asked.es).toEqual([8.5]);
    expect(asked.ns).toEqual([0]);
    expect(Array.from(h)).toEqual([7]);
  });

  it('is all NaN for a date without a prepared surface', async () => {
    setDateSurfaceSource(() => Promise.resolve(null));
    const h = await groundAt(
      'd1',
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      manifest,
    );
    expect(h).toHaveLength(2);
    expect(Array.from(h).every(Number.isNaN)).toBe(true);
  });
});
