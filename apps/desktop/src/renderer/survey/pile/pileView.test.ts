import type { SitePoint } from '@aio/schema';
import { pileAxis, rotateAxis, type ChartSeries, type PileAxis, type TimeRow } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import {
  createPileView,
  footprintM2,
  figureParts,
  largestDrop,
  minusSigned,
  parseDecimal,
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

  it('shows the opened pile solid until Height is picked, for the session', () => {
    const s = createPileView();
    expect(s.getState().surface).toBe('solid');
    s.getState().setSurface('height');
    expect(s.getState().surface).toBe('height');
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

describe('fitAxisTo', () => {
  const ring: SitePoint[] = [
    [0, 0, 0],
    [40, 0, 0],
    [40, 20, 0],
    [0, 20, 0],
  ];
  const moved: SitePoint[] = [
    [100, 0, 0],
    [180, 0, 0],
    [180, 20, 0],
    [100, 20, 0],
  ];
  const key = (r: SitePoint[]) => JSON.stringify(r);

  it('refits a kept line when the outline changes, keeping its angle', () => {
    const s = createPileView();
    s.getState().fitAxisTo('p', key(ring), ring);
    const turned = rotateAxis(pileAxis(ring), ring, 30);
    s.getState().setAxis('p', turned);
    // the same outline again: the kept line stays as the person left it
    s.getState().fitAxisTo('p', key(ring), ring);
    expect(s.getState().axis.get('p')).toBe(turned);
    s.getState().fitAxisTo('p', key(moved), moved);
    const refit = s.getState().axis.get('p');
    expect(refit).toEqual(pileAxis(moved, { angleDeg: turned.angleDeg }));
    expect(refit?.centre[0]).toBeCloseTo(140, 6);
  });

  it('a pile without a kept line only notes the outline', () => {
    const s = createPileView();
    s.getState().fitAxisTo('p', key(ring), ring);
    s.getState().fitAxisTo('p', key(moved), moved);
    expect(s.getState().axis.has('p')).toBe(false);
  });

  it('a line kept before the outline was first seen is refitted once it changes', () => {
    const s = createPileView();
    const turned = pileAxis(ring, { angleDeg: 10 });
    s.getState().setAxis('p', turned);
    s.getState().fitAxisTo('p', key(ring), ring);
    expect(s.getState().axis.get('p')).toBe(turned);
    s.getState().fitAxisTo('p', key(moved), moved);
    expect(s.getState().axis.get('p')?.angleDeg).toBeCloseTo(10, 6);
    expect(s.getState().axis.get('p')?.centre[0]).toBeCloseTo(140, 6);
  });
});

describe('parseDecimal', () => {
  it('reads what the locale writes back, and a decimal comma in metric', () => {
    expect(parseDecimal('1.60', 'metric')).toBe(1.6);
    expect(parseDecimal('1 234.50', 'metric')).toBe(1234.5);
    expect(parseDecimal('1,6', 'metric')).toBe(1.6);
    expect(parseDecimal('1,234.50', 'imperial')).toBe(1234.5);
    expect(parseDecimal(' 2 ', 'imperial')).toBe(2);
    expect(parseDecimal('abc', 'metric')).toBeNull();
    expect(parseDecimal('', 'metric')).toBeNull();
  });
});

describe('figureParts', () => {
  it('marks the figures of a sentence and keeps its words, in the message order', () => {
    expect(
      figureParts('Largest drop {value} at {chainage}', { value: '−0.96 m', chainage: '22 m' }),
    ).toEqual([
      { text: 'Largest drop ', figure: false },
      { text: '−0.96 m', figure: true },
      { text: ' at ', figure: false },
      { text: '22 m', figure: true },
    ]);
  });

  it('leaves a placeholder it has no figure for as written', () => {
    expect(figureParts('{a} and {b}', { a: '1' })).toEqual([
      { text: '1', figure: true },
      { text: ' and ', figure: false },
      { text: '{b}', figure: false },
    ]);
  });
});
