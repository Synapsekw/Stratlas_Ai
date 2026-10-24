import { describe, expect, it } from 'vitest';
import {
  cutFillBars,
  monthTicks,
  snapToSurvey,
  stackSeries,
  stripScale,
  yTickLabel,
  yTicks,
  type StripDate,
} from './stripModel';

const DAY = 86_400_000;
const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe('stripScale', () => {
  it('round-trips and pads 4 % of the span each side', () => {
    const a = d('2020-12-31');
    const b = d('2021-01-10');
    const s = stripScale([b, a], 1000);
    const span = b - a;
    expect(s.t0).toBe(a - span * 0.04);
    expect(s.t1).toBe(b + span * 0.04);
    expect(s.x(a)).toBeCloseTo((0.04 / 1.08) * 1000, 6);
    expect(s.x(s.t0)).toBe(0);
    expect(s.x(s.t1)).toBe(1000);
    expect(s.t(s.x(a + 3 * DAY))).toBeCloseTo(a + 3 * DAY, 3);
  });

  it('takes a custom pad', () => {
    const s = stripScale([0, 100 * DAY], 500, 0);
    expect(s.t0).toBe(0);
    expect(s.t1).toBe(100 * DAY);
  });

  it('gives one date a 30-day window centred on it', () => {
    const a = d('2021-01-10');
    const s = stripScale([a], 600);
    expect(s.t0).toBe(a - 15 * DAY);
    expect(s.t1).toBe(a + 15 * DAY);
    expect(s.x(a)).toBe(300);
  });

  it('skips non-finite dates and never returns NaN', () => {
    const s = stripScale([Number.NaN, d('2021-01-10')], 600);
    expect(s.x(d('2021-01-10'))).toBe(300);
    const empty = stripScale([], 600);
    expect(Number.isFinite(empty.x(0))).toBe(true);
    expect(Number.isFinite(empty.t(10))).toBe(true);
  });
});

describe('monthTicks', () => {
  it('ticks the first of each month across a year end', () => {
    const ticks = monthTicks(d('2020-11-15'), d('2021-02-10'));
    expect(ticks.map((x) => x.label)).toEqual(['Dec 2020', 'Jan 2021', 'Feb 2021']);
    expect(ticks[0]?.t).toBe(d('2020-12-01'));
    expect(ticks[1]?.t).toBe(d('2021-01-01'));
  });

  it('includes a month that starts exactly at t0', () => {
    expect(monthTicks(d('2021-01-01'), d('2021-01-20')).map((x) => x.label)).toEqual(['Jan 2021']);
  });

  it('ticks January once when the range starts after the 1st of December', () => {
    const ticks = monthTicks(d('2020-12-15'), d('2021-03-10'));
    expect(ticks.map((x) => x.label)).toEqual(['Jan 2021', 'Feb 2021', 'Mar 2021']);
    expect(ticks[0]?.t).toBe(d('2021-01-01'));
  });

  it("labels the months in the app's language", () => {
    expect(monthTicks(d('2021-01-01'), d('2021-01-20'), 'fr')[0]?.label).toMatch(/janv/);
    expect(monthTicks(d('2021-09-01'), d('2021-09-20'), 'en')[0]?.label).toBe('Sep 2021');
  });

  it('is empty for a reversed or NaN range', () => {
    expect(monthTicks(d('2021-02-01'), d('2021-01-01'))).toEqual([]);
    expect(monthTicks(Number.NaN, 0)).toEqual([]);
  });
});

describe('snapToSurvey', () => {
  it('snaps to the nearest survey', () => {
    const dates = [d('2020-12-31'), d('2021-01-10'), d('2021-03-01')];
    expect(snapToSurvey(d('2021-01-04'), dates)).toBe(d('2020-12-31'));
    expect(snapToSurvey(d('2021-01-06'), dates)).toBe(d('2021-01-10'));
    expect(snapToSurvey(d('2022-01-01'), dates)).toBe(d('2021-03-01'));
  });

  it('keeps t without surveys', () => {
    expect(snapToSurvey(42, [])).toBe(42);
  });
});

describe('stackSeries', () => {
  const dates: StripDate[] = [
    {
      capture: 'b',
      t: d('2021-01-10'),
      groups: [
        { key: 'gravel', colour: 'var(--mat-1)', volumeM3: 40, tonnes: 64 },
        { key: 'sand', colour: 'var(--mat-2)', volumeM3: 10, tonnes: 15 },
      ],
    },
    { capture: 'x', t: null, groups: [{ key: 'gravel', colour: 'c', volumeM3: 999, tonnes: 1 }] },
    {
      capture: 'a',
      t: d('2020-12-31'),
      groups: [
        { key: 'gravel', colour: 'var(--mat-1)', volumeM3: 50, tonnes: 80 },
        { key: '', colour: 'var(--mat-none)', volumeM3: 5, tonnes: null },
      ],
    },
  ];

  it('stacks volumes by material in date order and skips undated captures', () => {
    const s = stackSeries(dates, 'volume');
    expect(s.layers.map((l) => l.key)).toEqual(['gravel', 'sand', '']);
    const gravel = s.layers[0];
    expect(gravel?.points).toEqual([
      { capture: 'a', t: d('2020-12-31'), y0: 0, y1: 50 },
      { capture: 'b', t: d('2021-01-10'), y0: 0, y1: 40 },
    ]);
    expect(s.layers[2]?.points[0]).toEqual({ capture: 'a', t: d('2020-12-31'), y0: 50, y1: 55 });
    expect(s.max).toBe(55);
    expect(s.min).toBe(0);
    expect(s.totals).toEqual([
      { capture: 'a', t: d('2020-12-31'), value: 55 },
      { capture: 'b', t: d('2021-01-10'), value: 50 },
    ]);
  });

  it('breaks a layer on a date its material has no figure, never drawing it as zero', () => {
    const s = stackSeries(dates, 'volume');
    // sand only on b, No material only on a: one point each, no zero-height point
    expect(s.layers[1]?.points).toEqual([{ capture: 'b', t: d('2021-01-10'), y0: 40, y1: 50 }]);
    expect(s.layers[2]?.points.map((p) => p.capture)).toEqual(['a']);
    expect(s.layers[2]?.runs).toHaveLength(1);
  });

  it('keeps the top of the stack at the total with a negative figure', () => {
    const s = stackSeries(
      [
        {
          capture: 'a',
          t: d('2021-01-01'),
          groups: [
            { key: 'gravel', colour: 'c', volumeM3: 30, tonnes: null },
            { key: '', colour: 'n', volumeM3: -10, tonnes: null },
          ],
        },
      ],
      'volume',
    );
    expect(s.totals[0]?.value).toBe(20);
    expect(s.layers.at(-1)?.points[0]?.y1).toBe(20);
    expect(s.max).toBe(30);
    const neg = stackSeries(
      [{ capture: 'a', t: 0, groups: [{ key: 'x', colour: 'c', volumeM3: -5, tonnes: null }] }],
      'volume',
    );
    expect(neg.min).toBe(-5);
    expect(neg.totals[0]?.value).toBe(-5);
  });

  it('leaves a gap for a date without a figure: the layers and the total break there', () => {
    const s = stackSeries(
      [
        { capture: 'a', t: 1, groups: [{ key: 'g', colour: 'c', volumeM3: 10, tonnes: null }] },
        { capture: 'b', t: 2, groups: [] },
        { capture: 'c', t: 3, groups: [{ key: 'g', colour: 'c', volumeM3: 12, tonnes: null }] },
      ],
      'volume',
    );
    expect(s.totals.map((x) => x.capture)).toEqual(['a', 'c']);
    expect(s.totalRuns.map((r) => r.map((x) => x.capture))).toEqual([['a'], ['c']]);
    expect(s.layers[0]?.runs.map((r) => r.map((x) => x.capture))).toEqual([['a'], ['c']]);
  });

  it('stacks tonnes, a material without density leaving its layer out', () => {
    const s = stackSeries(dates, 'tonnes');
    expect(s.totals.map((x) => x.value)).toEqual([80, 79]);
    expect(s.max).toBe(80);
    expect(s.layers[2]?.points).toEqual([]);
  });

  it('is empty in cut and fill mode', () => {
    expect(stackSeries(dates, 'cutFill')).toEqual({
      layers: [],
      totals: [],
      totalRuns: [],
      max: 0,
      min: 0,
    });
  });
});

describe('cutFillBars', () => {
  it('places a bar in each gap between consecutive surveys', () => {
    const times: Record<string, number> = { a: d('2020-12-31'), b: d('2021-01-10') };
    const s = stripScale([times.a ?? 0, times.b ?? 0], 1080, 0);
    const bars = cutFillBars(
      [
        { from: 'a', to: 'b', cutM3: 22598, fillM3: 1227 },
        { from: 'a', to: 'nodate', cutM3: 1, fillM3: 1 },
      ],
      s,
      (c) => times[c] ?? null,
    );
    expect(bars).toHaveLength(1);
    const bar = bars[0];
    expect(bar?.from).toBe('a');
    expect(bar?.cutM3).toBe(22598);
    expect(bar?.fillM3).toBe(1227);
    expect(bar?.netM3).toBe(1227 - 22598);
    expect(bar?.x0).toBeGreaterThan(0);
    expect(bar?.x1).toBeLessThan(1080);
    expect(((bar?.x0 ?? 0) + (bar?.x1 ?? 0)) / 2).toBeCloseTo(540, 6);
    expect(cutFillBars([], s, () => 0)).toEqual([]);
  });
});

describe('yTicks', () => {
  it('gives three nice ticks from zero', () => {
    expect(yTicks(63402)).toEqual([0, 40000, 80000]);
    expect(yTicks(100255)).toEqual([0, 60000, 120000]);
    expect(yTicks(8)).toEqual([0, 4, 8]);
  });

  it('never collapses', () => {
    expect(yTicks(0)).toEqual([0, 1, 2]);
    expect(yTicks(Number.NaN)).toEqual([0, 1, 2]);
  });

  it('labels compactly', () => {
    expect(yTickLabel(80000)).toBe('80k');
    expect(yTickLabel(1500000)).toBe('1.5M');
    expect(yTickLabel(0)).toBe('0');
  });
});
