import type { HeightTiles } from '@aio/schema';
import { encodeTile, lineMetrics, polygonAreas, TILE } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import type { SurfaceState } from '../surfaceStates';
import { emptyReason, heightAt, pointHistory, withSurface, type FetchTile } from './pointHistory';

const READY: SurfaceState = { kind: 'ready' };

/** A plane z = 10 + 0.5 E + 0.25 N on one 256 x 256 tile of 1 m cells (posts at cell centres). */
const plane = (e: number, n: number) => 10 + 0.5 * e + 0.25 * n;

function tiles(id: string, capture: string): HeightTiles {
  return {
    schema: 'aio.height-tiles/1',
    id,
    name: id,
    source: { kind: 'dsm', layer: 'dsm' },
    capture,
    crs: { epsg: 32640 },
    cellM: 1,
    tileSize: 256,
    originE: 0,
    originN: 0,
    cols: 1,
    rows: 1,
    levels: 1,
    bounds: [0, 0, 0, 256, 256, 300],
    tiles: ['0_0'],
    fingerprint: id,
    preparedAt: '2026-10-20T00:00:00Z',
  };
}

/** The plane's tile, with a hole (no data) where `hole` says so. */
async function planeTile(
  hole: (e: number, n: number) => boolean = () => false,
): Promise<FetchTile> {
  const heights = new Float64Array(TILE * TILE);
  for (let j = 0; j < TILE; j++)
    for (let i = 0; i < TILE; i++) {
      const e = i + 0.5;
      const n = j + 0.5;
      heights[j * TILE + i] = hole(e, n) ? NaN : plane(e, n);
    }
  const bytes = await encodeTile(heights);
  return (col, row) => Promise.resolve(col === 0 && row === 0 ? bytes : null);
}

describe('heightAt (moved from the elevation history panel)', () => {
  it('reads a prepared surface with the engine sampler', async () => {
    const z = await heightAt(tiles('s', 'a'), 100.3, 50.7, await planeTile());
    expect(z).toBeCloseTo(plane(100.3, 50.7), 6);
  });

  it('is null where the surface has no data, never 0', async () => {
    const fetch = await planeTile((e) => e > 120);
    expect(await heightAt(tiles('s', 'a'), 130, 50, fetch)).toBeNull();
    // outside the tiles altogether
    expect(await heightAt(tiles('s', 'a'), 400, 50, fetch)).toBeNull();
  });
});

describe('pointHistory', () => {
  it('reads every dated surface oldest first, with a gap where a date has no data', async () => {
    const full = await planeTile();
    const holed = await planeTile((e) => e > 90);
    const a = tiles('sa', 'a');
    const b = tiles('sb', 'b');
    const rows = await pointHistory(
      [
        { capture: 'b', label: 'June', date: '2026-06-01', state: READY, tiles: b },
        { capture: 'a', label: 'January', date: '2026-01-01', state: READY, tiles: a },
      ],
      100,
      40,
      (s) => (s.id === 'sb' ? holed : full),
    );
    expect(rows.map((r) => r.capture)).toEqual(['a', 'b']);
    expect(rows[0]?.z).toBeCloseTo(plane(100, 40), 6);
    expect(rows[1]?.z).toBeNull();
  });
});

describe('emptyReason', () => {
  it('names a surface still to come, no elevation, else not measured', () => {
    expect(emptyReason([READY, { kind: 'preparing', pct: 62 }])).toBe('mcard.surfacePreparing');
    // a missing surface is preparing only when a job runs or auto-prepare will start one
    expect(emptyReason([{ kind: 'missing' }], true)).toBe('mcard.surfacePreparing');
    expect(emptyReason([{ kind: 'missing' }])).toBe('mcard.notPrepared');
    expect(emptyReason([READY, { kind: 'missing' }], false)).toBe('mcard.notPrepared');
    // a date preparing is preparing whatever comes next
    expect(emptyReason([{ kind: 'preparing', pct: 5 }, { kind: 'missing' }], false)).toBe(
      'mcard.surfacePreparing',
    );
    expect(emptyReason([{ kind: 'none' }, { kind: 'none' }])).toBe('mcard.noElevation');
    expect(emptyReason([READY, { kind: 'none' }])).toBe('mcard.notMeasured');
  });

  it('a date with no surface yet reads null, never a height', async () => {
    const rows = await pointHistory(
      [
        {
          capture: 'a',
          label: 'January',
          date: '2026-01-01',
          state: { kind: 'missing' },
          tiles: null,
        },
      ],
      0,
      0,
      () => () => Promise.resolve(null),
    );
    expect(rows.map((r) => r.z)).toEqual([null]);
  });
});

describe('withSurface', () => {
  it('runs a line computation on the heights of a prepared surface', async () => {
    const pts: [number, number, number][] = [
      [10, 10, 0],
      [110, 10, 0],
    ];
    const m = await withSurface((h) => lineMetrics(pts, h, 1), tiles('s', 'a'), await planeTile());
    // along E the plane rises 0.5 m per metre: 100 m plan is 100 * sqrt(1.25) on the surface
    expect(m.terrainM).toBeCloseTo(100 * Math.sqrt(1.25), 6);
  });

  it('runs a polygon computation on the heights of a prepared surface', async () => {
    const ring: [number, number, number][] = [
      [10, 10, 0],
      [60, 10, 0],
      [60, 60, 0],
      [10, 60, 0],
    ];
    const a = await withSurface(
      (h) => polygonAreas(ring, h, 1),
      tiles('s', 'a'),
      await planeTile(),
    );
    // a plane's area is the plan area over the cosine of its slope
    expect(a.terrainM2).toBeCloseTo(2500 * Math.sqrt(1 + 0.25 + 0.0625), 4);
  });
});
