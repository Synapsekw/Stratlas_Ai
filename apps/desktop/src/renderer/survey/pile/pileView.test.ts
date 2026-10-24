import type { SitePoint } from '@aio/schema';
import type { ChartSeries, PileAxis, TimeRow } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import {
  createPileView,
  footprintM2,
  largestDrop,
  minusSigned,
  pileFigures,
  pilePosition,
  wasFigure,
} from './pileView';

const row = (capture: string, date: string, valueM3: number | null): TimeRow => ({
  capture,
  date,
  label: capture,
  valueM3,
  changeM3: null,
  tonnes: null,
  status: valueM3 === null ? 'missing' : 'ok',
  stale: false,
  latest: false,
});

const series = (key: string, z: (number | null)[]): ChartSeries => ({
  key,
  label: key,
  kind: 'earlier',
  chainage: z.map((_, i) => i * 10),
  z,
});

describe('pileView store', () => {
  it('starts on the overview, keeps one axis per pile and the history unit', () => {
    const s = createPileView();
    expect(s.getState().tab).toBe('overview');
    expect(s.getState().historyUnit).toBe('m3');
    const axis: PileAxis = { a: [0, 0], b: [10, 0], centre: [5, 0], angleDeg: 0, lengthM: 10 };
    s.getState().setAxis('p1', axis);
    s.getState().setTab('history');
    s.getState().setHistoryUnit('both');
    expect(s.getState().axis.get('p1')).toBe(axis);
    expect(s.getState().axis.has('p2')).toBe(false);
    expect(s.getState().tab).toBe('history');
    expect(s.getState().historyUnit).toBe('both');
  });
});

describe('pilePosition', () => {
  it('counts from one and names the neighbours, none past the ends', () => {
    expect(pilePosition(['a', 'b', 'c'], 'b')).toEqual({ n: 2, total: 3, prev: 'a', next: 'c' });
    expect(pilePosition(['a', 'b', 'c'], 'a')).toEqual({ n: 1, total: 3, prev: null, next: 'b' });
    expect(pilePosition(['a', 'b'], 'x')).toBeNull();
  });
});

describe('pileFigures', () => {
  it('takes the latest date with a figure and the one before with a figure', () => {
    const rows = [row('c1', '2020-12-31', 14686.7), row('c2', '2021-01-10', 11378.7)];
    const f = pileFigures(rows);
    expect(f.current?.capture).toBe('c2');
    expect(f.previous?.capture).toBe('c1');
    expect(f.changeM3).toBeCloseTo(-3308, 6);
    expect(f.changePct).toBeCloseTo(-22.524, 2);
  });
  it('has no previous on the first survey and skips dates without a figure', () => {
    expect(pileFigures([row('c1', '2021-01-10', 5)]).previous).toBeNull();
    const f = pileFigures([
      row('c0', '2020-12-01', 4),
      row('c1', '2020-12-31', null),
      row('c2', '2021-01-10', 5),
    ]);
    expect(f.previous?.capture).toBe('c0');
    expect(f.changeM3).toBe(1);
  });
  it('gives no percentage from a zero figure, and nothing without figures', () => {
    expect(
      pileFigures([row('c1', '2020-12-31', 0), row('c2', '2021-01-10', 5)]).changePct,
    ).toBeNull();
    expect(pileFigures([row('c1', '2020-12-31', null)])).toEqual({
      current: null,
      previous: null,
      changeM3: null,
      changePct: null,
    });
  });
});

describe('largestDrop', () => {
  it('finds the deepest fall of the later line under the earlier one, with its chainage', () => {
    const d = largestDrop(series('later', [10, 8, 7.04, 9]), series('earlier', [10, 10, 10, 9.5]));
    expect(d?.dz).toBeCloseTo(-2.96, 6);
    expect(d?.chainageM).toBe(20);
  });
  it('skips stations where either line has no height and is null when nothing falls', () => {
    expect(largestDrop(series('later', [null, 12]), series('earlier', [10, 11]))).toBeNull();
    expect(largestDrop(series('later', [null, 9]), series('earlier', [10, null]))).toBeNull();
  });
});

describe('footprintM2', () => {
  it('is the plan area of the ring whatever its winding', () => {
    const ring: SitePoint[] = [
      [0, 0, 5],
      [20, 0, 5],
      [20, 10, 6],
      [0, 10, 5],
    ];
    expect(footprintM2(ring)).toBe(200);
    expect(footprintM2([...ring].reverse())).toBe(200);
    expect(footprintM2(ring.slice(0, 2))).toBe(0);
  });
});

describe('minusSigned', () => {
  it('writes the Unicode minus for a loss and a plus for a gain', () => {
    expect(minusSigned('-3 308.0', -3308)).toBe('−3 308.0');
    expect(minusSigned('19.6', 19.6)).toBe('+19.6');
    expect(minusSigned('0.0', 0)).toBe('0.0');
  });
});

describe('wasFigure', () => {
  it('is the kit figure a standard-base figure replaced, on the stored figure’s date', () => {
    const was = wasFigure({
      origin: { kind: 'kit-pile', pile: 'k1' },
      items: [{ id: 'a' } as never],
      results: [{ item: 'a', toCapture: 'c1' } as never],
      previousResults: [
        {
          netM3: 14690.2,
          totalM3: 14690.2,
          label: 'kit, Toe line',
          replacedAt: '2026-10-24T00:00:00Z',
        },
      ],
    });
    expect(was).toEqual({ capture: 'c1', netM3: 14690.2 });
  });
  it('is null for a pile that never held a kit figure', () => {
    expect(
      wasFigure({
        items: [{ id: 'a' } as never],
        results: [{ item: 'a', toCapture: 'c1' } as never],
        previousResults: [
          { netM3: 1, totalM3: 1, label: 'Triangulated toe', replacedAt: '2026-10-24T00:00:00Z' },
        ],
      }),
    ).toBeNull();
  });
});
