import type { ChartSeries } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import type { HoverLine } from './linkedHover';
import {
  chainageOf,
  markerAt,
  pointAt,
  snapScreen,
  tagText,
  type TagFormat,
} from './linkedHoverGeom';

// L-shaped: 30 m east, then 40 m north (70 m long)
const L: readonly (readonly [number, number])[] = [
  [100, 200],
  [130, 200],
  [130, 240],
];

describe('pointAt and chainageOf', () => {
  it('round-trips along an L-shaped polyline', () => {
    for (const c of [0, 12.5, 30, 41.25, 70]) {
      const [e, n] = pointAt(L, c);
      const back = chainageOf(L, e, n);
      expect(back.chainageM).toBeCloseTo(c, 9);
      expect(back.offsetM).toBeCloseTo(0, 9);
    }
    expect(pointAt(L, 50)).toEqual([130, 220]);
  });

  it('clamps past the ends and never returns NaN', () => {
    expect(pointAt(L, -5)).toEqual([100, 200]);
    expect(pointAt(L, 999)).toEqual([130, 240]);
    expect(pointAt(L, Number.NaN)).toEqual([100, 200]);
    expect(pointAt([], 3)).toEqual([0, 0]);
  });

  it('gives the offset from the line', () => {
    const r = chainageOf(L, 110, 203);
    expect(r.chainageM).toBeCloseTo(10, 9);
    expect(r.offsetM).toBeCloseTo(3, 9);
  });
});

describe('snapScreen', () => {
  const screen: readonly (readonly [number, number])[] = [
    [0, 100],
    [200, 100],
  ];
  const cumul = [0, 50];

  it('snaps within 12 px to the chainage of the nearest point', () => {
    expect(snapScreen(screen, cumul, 100, 112)).toBeCloseTo(25, 9);
    expect(snapScreen(screen, cumul, 40, 95)).toBeCloseTo(10, 9);
  });

  it('returns null at 13 px', () => {
    expect(snapScreen(screen, cumul, 100, 113)).toBeNull();
  });

  it('honours maxPx and needs two points', () => {
    expect(snapScreen(screen, cumul, 100, 113, 20)).toBeCloseTo(25, 9);
    expect(snapScreen([[0, 0]], [0], 0, 0)).toBeNull();
  });
});

const series = (
  key: string,
  date: string | undefined,
  z: readonly (number | null)[],
): ChartSeries => ({
  key,
  label: key,
  kind: 'earlier',
  capture: `cap-${key}`,
  ...(date ? { date } : {}),
  chainage: [0, 10, 20],
  z,
});

const line = (s: readonly ChartSeries[]): HoverLine => ({
  key: 'measure:m',
  polyline: [
    [0, 0],
    [20, 0],
  ],
  series: s,
});

describe('markerAt', () => {
  it('with two series gives both z and the delta newest minus earlier', () => {
    const m = markerAt(
      line([series('old', '2026-01-01', [10, 12, 14]), series('new', '2026-02-01', [10, 11, 13])]),
      5,
    );
    expect(m.e).toBeCloseTo(5, 9);
    expect(m.n).toBeCloseTo(0, 9);
    expect(m.dots).toEqual([
      { key: 'old', capture: 'cap-old', z: 11 },
      { key: 'new', capture: 'cap-new', z: 10.5 },
    ]);
    expect(m.deltaM).toBeCloseTo(-0.5, 9);
  });

  it('with one series gives one dot and no delta', () => {
    const m = markerAt(line([series('only', '2026-01-01', [1, 2, 3])]), 15);
    expect(m.dots).toEqual([{ key: 'only', capture: 'cap-only', z: 2.5 }]);
    expect(m.deltaM).toBeNull();
  });

  it('with a gap in one series gives one dot and no delta, no NaN', () => {
    const m = markerAt(
      line([
        series('old', '2026-01-01', [10, null, 14]),
        series('new', '2026-02-01', [10, 11, 13]),
      ]),
      5,
    );
    expect(m.dots).toEqual([{ key: 'new', capture: 'cap-new', z: 10.5 }]);
    expect(m.deltaM).toBeNull();
    expect(Number.isNaN(m.e) || Number.isNaN(m.n)).toBe(false);
  });

  it('leaves out a series outside its chainage range and ignores undated series for the delta', () => {
    const design: ChartSeries = { ...series('design', undefined, [0, 0, 0]), kind: 'design' };
    const m = markerAt(line([design, series('new', '2026-02-01', [1, 1, 1])]), 10);
    expect(m.dots.map((d) => d.key)).toEqual(['design', 'new']);
    expect(m.deltaM).toBeNull();
    expect(markerAt(line([series('a', '2026-01-01', [1, 1, 1])]), 25).dots).toEqual([]);
  });
});

describe('tagText', () => {
  const fmt: TagFormat = {
    chainage: (m) => `${m.toFixed(1)} m`,
    magnitude: (m) => m.toFixed(2),
  };

  it('uses the minus sign for cut and a plus for fill', () => {
    expect(tagText(42.3, -1.63, fmt)).toBe('42.3 m · −1.63');
    expect(tagText(10, 0.02, fmt)).toBe('10.0 m · +0.02');
  });

  it('has no delta part when null, and no sign on a value that rounds to zero', () => {
    expect(tagText(42.3, null, fmt)).toBe('42.3 m');
    expect(tagText(1, -0.001, fmt)).toBe('1.0 m · 0.00');
  });
});
