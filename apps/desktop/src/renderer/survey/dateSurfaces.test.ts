// @vitest-environment jsdom
import type { HeightTiles, ProjectManifest, SitePoint } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { compareStore } from './compareStore';
import { ringShifts } from '@aio/survey';
import { shiftEN } from '@aio/schema';
import {
  drawnSampler,
  groundAt,
  hasPrepared,
  setDateSurfaceSource,
  storedFromPrepared,
} from './dateSurfaces';
import { storedPoints } from './measureDates';

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

  it('turns a drawn point back by a turned line-up before sampling', async () => {
    // the date is turned 90 degrees about (0, 0) now; its surface was prepared before the turn
    const turned = {
      ...manifest,
      captures: [
        {
          id: 'd3',
          label: 'three',
          date: '2026-03-01',
          lineUp: { eastM: 0, northM: 0 },
          lineUpTurn: { rotationDeg: 90, scale: 1, pivotE: 0, pivotN: 0 },
        },
      ],
    } as unknown as Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>;
    compareStore.setState({ surfaces: [surface('s3', 'd3')] });
    const asked: { es: number[]; ns: number[] } = { es: [], ns: [] };
    setDateSurfaceSource(() =>
      Promise.resolve((es, ns) => {
        asked.es.push(...es);
        asked.ns.push(...ns);
        return Promise.resolve(Float64Array.from(es, () => 7));
      }),
    );
    // stored (10, 0) is drawn at (0, 10) after the turn: the surface is read at (10, 0)
    await groundAt('d3', [[0, 10, 0]], turned);
    expect(asked.es[0]).toBeCloseTo(10, 9);
    expect(asked.ns[0]).toBeCloseTo(0, 9);
  });

  it('reads drawn points through drawnSampler where groundAt reads them', async () => {
    // re-lined-up after preparing: prepared at 0.5 m east, lined up 2 m east now
    compareStore.setState({
      surfaces: [surface('s2', 'd2', { dateShiftM: { eastM: 0.5, northM: 0 } })],
    });
    setDateSurfaceSource(() =>
      Promise.resolve((es) => Promise.resolve(Float64Array.from(es, (e) => e * 10))),
    );
    const sample = await drawnSampler('d2', manifest);
    const h = await sample?.(Float64Array.of(10), Float64Array.of(0));
    expect(Array.from(h ?? [])).toEqual([85]);
    expect(Array.from(await groundAt('d2', [[10, 0, 0]], manifest))).toEqual([85]);
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

describe('storedFromPrepared', () => {
  it('saves a region found on a re-lined-up date where the engine reads it back', () => {
    // prepared at 0.5 m east, lined up 2 m east now; the region's ring is in the prepared frame
    const surfaces = [surface('s2', 'd2', { dateShiftM: { eastM: 0.5, northM: 0 } })];
    compareStore.setState({ surfaces });
    const ring: SitePoint[] = [[10, 0, 0]];
    const scope = { kind: 'survey', capture: 'd2' } as const;
    // the engine samples the surface at the stored ring plus the prepared shift
    const { ringShift = [0, 0] } = ringShifts(surfaces, { d2: [2, 0] }, 'd2');
    const engineReads = (p: SitePoint) =>
      shiftEN(p, { eastM: ringShift[0], northM: ringShift[1] })[0];
    const stored = storedFromPrepared(ring, scope, manifest);
    expect(engineReads(stored[0] ?? [0, 0, 0])).toBeCloseTo(10, 9);
    // the current line-up taken off instead puts the region 1.5 m west of where it was found
    const old = storedPoints(ring, scope, manifest);
    expect(engineReads(old[0] ?? [0, 0, 0])).toBeCloseTo(8.5, 9);
  });

  it('keeps a site-wide region as it is', () => {
    const ring: SitePoint[] = [[10, 0, 0]];
    expect(storedFromPrepared(ring, { kind: 'site' }, manifest)).toEqual(ring);
  });
});
