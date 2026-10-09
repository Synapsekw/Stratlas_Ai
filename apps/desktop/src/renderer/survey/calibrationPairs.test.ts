import { CalibrationPair, GeoCalibrationParams } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { emptyRow, pairsRequest, parsePairsCsv, rowsOfPairs } from './calibrationPairs';

const CSV = [
  'name,grid N,grid E,grid Z,local N,local E,local Z,H,V',
  'CAL1,49870.1,9859.9,120,49863.3,9872.2,121.2,1,1',
  'CAL2,49880.2,10149.8,121.2,49873.5,10162.2,122.4,yes,no',
  'CAL3,50145.0,10134.9,122.1,50138.2,10147.3,123.3,,',
].join('\r\n');

describe('compute from point pairs', () => {
  it('reads a CSV of grid pairs with H and V, skipping the header', () => {
    const r = parsePairsCsv(CSV);
    expect(r.error).toBeNull();
    expect(r.kind).toBe('grid');
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toEqual({
      name: 'CAL1',
      a: '49870.1',
      b: '9859.9',
      c: '120',
      localN: '49863.3',
      localE: '9872.2',
      localZ: '121.2',
      useH: true,
      useV: true,
    });
    expect(r.rows[1]).toMatchObject({ useH: true, useV: false });
    // empty H and V columns keep the default: used
    expect(r.rows[2]).toMatchObject({ useH: true, useV: true });
  });

  it('knows a WGS84 header, takes semicolons and tabs, and says what is wrong', () => {
    expect(parsePairsCsv('Name;Latitude;Longitude;h;N;E;Z\nA;21.1;51.5;10;1;2;3').kind).toBe(
      'wgs84',
    );
    expect(parsePairsCsv('A\t21.1\t51.5\t10\t1\t2\t3').rows).toHaveLength(1);
    expect(parsePairsCsv('A,1,2,3,4,5').error).toMatch(/Line 1/);
    expect(parsePairsCsv('A,1,2,3,4,5,6\nB,1,2,3,4,5,6,maybe').error).toMatch(/Line 2: H and V/);
  });

  it('builds geo.calibration pairs the job accepts', () => {
    const { rows, kind } = parsePairsCsv(CSV);
    const r = pairsRequest(rows, kind ?? 'grid');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pairs[0]).toEqual({
      name: 'CAL1',
      local: [49863.3, 9872.2, 121.2],
      grid: [49870.1, 9859.9, 120],
      useH: true,
      useV: true,
    });
    for (const p of r.pairs) expect(CalibrationPair.safeParse(p).success).toBe(true);
    expect(GeoCalibrationParams.safeParse({ pairs: r.pairs, crs: { epsg: 32639 } }).success).toBe(
      true,
    );

    const w = pairsRequest(
      [{ ...emptyRow(1), a: '21.1', b: '51.5', c: '10', localN: '1', localE: '2', localZ: '3' }],
      'wgs84',
    );
    expect(w.ok).toBe(false); // one pair for the horizontal is not enough
    const v = pairsRequest(
      [
        {
          ...emptyRow(1),
          a: '21.1',
          b: '51.5',
          c: '10',
          localN: '1',
          localE: '2',
          localZ: '3',
          useH: false,
        },
      ],
      'wgs84',
    );
    expect(v.ok && v.pairs[0]?.wgs84).toEqual([21.1, 51.5, 10]);
  });

  it('refuses empty, half-typed, duplicate and out-of-range pairs', () => {
    expect(pairsRequest([], 'grid')).toMatchObject({ ok: false });
    expect(pairsRequest([emptyRow(1), emptyRow(2)], 'grid')).toMatchObject({
      ok: false,
      error: expect.stringContaining('number') as unknown,
    });
    const full = {
      ...emptyRow(1),
      a: '1',
      b: '2',
      c: '3',
      localN: '4',
      localE: '5',
      localZ: '6',
    };
    expect(pairsRequest([full, { ...full }], 'grid')).toMatchObject({
      ok: false,
      error: 'Two pairs are called P1.',
    });
    expect(pairsRequest([{ ...full, a: '95', useH: false }], 'wgs84')).toMatchObject({
      ok: false,
    });
    expect(
      pairsRequest(
        [
          { ...full, useH: false, useV: false },
          { ...full, name: 'P2', useH: false, useV: false },
        ],
        'grid',
      ),
    ).toMatchObject({ ok: false });
  });

  it('turns a computed calibration back into rows', () => {
    const { rows, kind } = rowsOfPairs([
      { name: 'A', local: [1, 2, 3], grid: [4, 5, 6], useH: true, useV: false, residualH: 0.01 },
    ]);
    expect(kind).toBe('grid');
    expect(rows[0]).toMatchObject({ name: 'A', a: '4', localZ: '3', useV: false });
  });
});
