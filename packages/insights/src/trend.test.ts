import { describe, expect, it } from 'vitest';
import { volumeTrend } from './trend';

const p = (date: string, valueM3: number, capture = date) => ({ capture, date, valueM3 });

describe('volumeTrend', () => {
  it('says not enough dates with none or one', () => {
    expect(volumeTrend([]).status).toBe('not-enough-dates');
    const one = volumeTrend([p('2026-01-01', 100)]);
    expect(one).toMatchObject({
      status: 'not-enough-dates',
      dates: 1,
      lastM3: 100,
      rateM3PerDay: null,
      daysToEmpty: null,
    });
  });

  it('gives the rate between two dates but no forecast', () => {
    const t = volumeTrend([p('2026-01-11', 80), p('2026-01-01', 100)]);
    expect(t.status).toBe('not-enough-dates');
    expect(t.rateM3PerDay).toBeCloseTo(-2, 12);
    expect(t.lastChangeM3).toBe(-20);
    expect(t.daysToEmpty).toBeNull();
    expect(t.r2).toBeNull();
  });

  it('fits a straight line through three dates and forecasts the day it empties', () => {
    const t = volumeTrend([p('2026-01-01', 100), p('2026-01-11', 80), p('2026-01-21', 60)]);
    expect(t.status).toBe('ok');
    expect(t.rateM3PerDay).toBeCloseTo(-2, 12);
    expect(t.r2).toBeCloseTo(1, 12);
    expect(t.daysToEmpty).toBeCloseTo(30, 12);
    expect(t.emptyOn).toBe('2026-02-20');
    expect(t.in30DaysM3).toBeCloseTo(0, 12);
  });

  it('has no days to empty while the pile grows', () => {
    const t = volumeTrend([p('2026-01-01', 10), p('2026-01-11', 20), p('2026-01-21', 30)]);
    expect(t.rateM3PerDay).toBeCloseTo(1, 12);
    expect(t.daysToEmpty).toBeNull();
    expect(t.emptyOn).toBeNull();
    expect(t.in30DaysM3).toBeCloseTo(60, 12);
  });

  it('fits only the last five dates', () => {
    const t = volumeTrend([
      p('2026-01-01', 1000),
      p('2026-01-02', 10),
      p('2026-01-03', 20),
      p('2026-01-04', 30),
      p('2026-01-05', 40),
      p('2026-01-06', 50),
    ]);
    expect(t.window).toBe(5);
    expect(t.rateM3PerDay).toBeCloseTo(10, 12);
  });

  it('refuses a forecast when every date is the same day', () => {
    const t = volumeTrend([
      p('2026-01-01', 1, 'a'),
      p('2026-01-01', 2, 'b'),
      p('2026-01-01', 3, 'c'),
    ]);
    expect(t.status).toBe('not-enough-dates');
    expect(t.rateM3PerDay).toBeNull();
  });

  it('scores the last rate against the earlier ones (robust z)', () => {
    const steady = [
      p('2026-01-01', 100),
      p('2026-01-11', 110),
      p('2026-01-21', 121),
      p('2026-01-31', 130),
    ];
    // earlier rates 1, 1.1, 0.9 per day: median 1, MAD 0.1
    const t = volumeTrend([...steady, p('2026-02-10', 230)]);
    expect(t.lastRateZ).toBeCloseTo((10 - 1) / (1.4826 * 0.1), 9);
    // fewer than three earlier rates: no score
    expect(volumeTrend(steady).lastRateZ).toBeNull();
  });

  it('gives no score when the earlier rates do not spread', () => {
    const t = volumeTrend([
      p('2026-01-01', 0),
      p('2026-01-02', 1),
      p('2026-01-03', 2),
      p('2026-01-04', 3),
      p('2026-01-05', 10),
    ]);
    expect(t.lastRateZ).toBeNull();
  });
});
