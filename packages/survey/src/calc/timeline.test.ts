import type { ComparisonResult } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { stackRows, volumeRows } from './timeline';

const at = <T>(a: readonly T[], i: number): T => {
  const v = a[i];
  if (v === undefined) throw new Error('missing item');
  return v;
};

const res = (toCapture: string, netM3: number, over: Partial<ComparisonResult> = {}) =>
  ({
    item: 'i',
    status: 'ok',
    netM3,
    totalM3: Math.abs(netM3) + 1,
    toCapture,
    ...over,
  }) as ComparisonResult;
const caps = [
  { id: 'c3', date: '2026-03-01', label: 'Mar' },
  { id: 'c1', date: '2026-01-01', label: 'Jan' },
  { id: 'c2', date: '2026-02-01', label: 'Feb' },
];
const isStale = () => false;

describe('volumeRows', () => {
  it('rows sort by date and give change since previous', () => {
    const rows = volumeRows([res('c1', 100), res('c2', 130), res('c3', 120)], caps, { isStale });
    expect(rows.map((r) => r.capture)).toEqual(['c1', 'c2', 'c3']);
    expect(rows.map((r) => r.changeM3)).toEqual([null, 30, -10]);
    expect(rows.map((r) => r.latest)).toEqual([false, false, true]);
  });

  it('a refused date has no value and keeps its reason', () => {
    const rows = volumeRows(
      [res('c1', 100), res('c2', 0, { status: 'refused', reason: '23% outside the survey' })],
      caps,
      { isStale },
    );
    expect(rows[1]).toMatchObject({
      valueM3: null,
      status: 'refused',
      reason: '23% outside the survey',
    });
    expect(rows[2]).toMatchObject({ valueM3: null, status: 'missing' });
    expect(at(rows, 0).latest).toBe(true);
  });

  it('change skips rows without a value', () => {
    const rows = volumeRows([res('c1', 100), res('c3', 150)], caps, { isStale });
    expect(at(rows, 2).changeM3).toBe(50);
  });

  it('tonnes use density; absent density gives null', () => {
    const a = volumeRows([res('c1', 100)], caps, { isStale, densityTPerM3: 1.6 });
    expect(at(a, 0).tonnes).toBeCloseTo(160);
    expect(at(volumeRows([res('c1', 100)], caps, { isStale }), 0).tonnes).toBeNull();
    expect(at(volumeRows([res('c1', 100)], caps, { isStale, quantity: 'total' }), 0).valueM3).toBe(
      101,
    );
  });

  it('flags stale rows', () => {
    const rows = volumeRows([res('c1', 100)], caps, { isStale: () => true });
    expect(at(rows, 0).stale).toBe(true);
    expect(at(rows, 1).stale).toBe(false);
  });
});

describe('stackRows', () => {
  it('stackRows sums parts and lists piles missing on a date', () => {
    const a = volumeRows([res('c1', 100), res('c2', 50)], caps, { isStale });
    const b = volumeRows([res('c1', 20)], caps, { isStale });
    const out = stackRows(
      new Map([
        ['a', a],
        ['b', b],
      ]),
    );
    expect(out.map((r) => r.capture)).toEqual(['c1', 'c2', 'c3']);
    expect(out[0]).toMatchObject({ totalM3: 120, missing: [] });
    expect(out[1]).toMatchObject({ totalM3: 50, missing: ['b'] });
    expect(at(out, 1).parts).toEqual([{ id: 'a', valueM3: 50 }]);
  });
});
