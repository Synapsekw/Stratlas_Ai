import { describe, expect, it } from 'vitest';
import { GAP_MS_AT_1X, advance, createDatesPlayer, playStops } from './datesPlayer';

const DAY = 86_400_000;
// gaps of 10 days and 50 days: each still takes 2 s at 1x
const dates = [0, 10 * DAY, 60 * DAY];

describe('advance', () => {
  it('takes 2 s per gap at 1x whatever its length in days', () => {
    expect(GAP_MS_AT_1X).toBe(2000);
    const a = advance(0, dates, 2000, 1, false);
    expect(a).toEqual({ t: 10 * DAY, passed: 10 * DAY, next: 60 * DAY, f: 0, ended: false });
    const b = advance(10 * DAY, dates, 2000, 1, false);
    expect(b.t).toBe(60 * DAY);
    expect(b.ended).toBe(true);
  });

  it('skips zero-length and same-day gaps: two surveys on one day never take a gap', () => {
    expect(playStops([10 * DAY, 0, 10 * DAY + DAY / 2, 10 * DAY, 60 * DAY])).toEqual([
      0,
      10 * DAY + DAY / 2,
      60 * DAY,
    ]);
    const same = [0, 10 * DAY, 10 * DAY + DAY / 2, 60 * DAY];
    const a = advance(0, same, 2000, 1, false);
    expect(a.passed).toBe(10 * DAY + DAY / 2);
    expect(a.next).toBe(60 * DAY);
  });

  it('takes 1 s per gap at 2x', () => {
    expect(advance(0, dates, 1000, 2, false).t).toBe(10 * DAY);
  });

  it('reports f 0.5 at the middle of a gap, in that gap', () => {
    const m = advance(10 * DAY, dates, 1000, 1, false);
    expect(m.f).toBeCloseTo(0.5, 9);
    expect(m.t).toBe(35 * DAY);
    expect(m.passed).toBe(10 * DAY);
    expect(m.next).toBe(60 * DAY);
  });

  it('crosses a survey in one step and keeps the remainder', () => {
    const m = advance(5 * DAY, dates, 2000, 1, false);
    expect(m.passed).toBe(10 * DAY);
    expect(m.f).toBeCloseTo(0.5, 9);
  });

  it('stops at the last survey without loop', () => {
    const e = advance(55 * DAY, dates, 10_000, 1, false);
    expect(e).toEqual({ t: 60 * DAY, passed: 60 * DAY, next: null, f: 0, ended: true });
  });

  it('wraps to the first survey with loop', () => {
    // from the second survey, 1.5 gaps: one gap to the end, back to the first, half a gap on
    const w = advance(10 * DAY, dates, 3000, 1, true);
    expect(w.ended).toBe(false);
    expect(w.passed).toBe(0);
    expect(w.f).toBeCloseTo(0.5, 9);
    expect(w.t).toBe(5 * DAY);
  });

  it('ignores undated captures and sorts the dates', () => {
    const m = advance(0, [60 * DAY, Number.NaN, 10 * DAY, 0], 3000, 1, false);
    expect(m.passed).toBe(10 * DAY);
    expect(m.f).toBeCloseTo(0.5, 9);
    expect(Number.isNaN(m.t)).toBe(false);
  });

  it('starts from the first survey when t is before it', () => {
    expect(advance(-5 * DAY, dates, 0, 1, false).t).toBe(0);
  });

  it('ends at once with fewer than two surveys', () => {
    expect(advance(3, [7], 100, 1, false)).toEqual({
      t: 7,
      passed: 7,
      next: null,
      f: 0,
      ended: true,
    });
    expect(advance(3, [], 100, 1, true).ended).toBe(true);
  });
});

describe('datesPlayer store', () => {
  it('plays, ticks and pauses at the end without loop', () => {
    const p = createDatesPlayer();
    expect(p.getState()).toMatchObject({
      playing: false,
      speed: 1,
      loop: false,
      t: null,
      between: 'crossfade',
    });
    p.getState().play(dates);
    expect(p.getState().t).toBe(0);
    p.getState().tick(1000, dates);
    expect(p.getState().frame?.f).toBeCloseTo(0.5, 9);
    p.getState().tick(10_000, dates);
    expect(p.getState().playing).toBe(false);
    expect(p.getState().t).toBe(60 * DAY);
  });

  it('with loop, stays on the last survey for a gap, then goes round from the first', () => {
    const p = createDatesPlayer();
    p.getState().toggleLoop();
    p.getState().play(dates);
    p.getState().tick(3000, dates);
    expect(p.getState().frame?.passed).toBe(10 * DAY);
    // past the end: on the last survey, still playing
    p.getState().tick(1500, dates);
    expect(p.getState().frame).toEqual({
      t: 60 * DAY,
      passed: 60 * DAY,
      next: null,
      f: 0,
      ended: false,
    });
    expect(p.getState().playing).toBe(true);
    p.getState().tick(1500, dates);
    expect(p.getState().frame?.passed).toBe(60 * DAY);
    // the hold over, half a gap left: back on the first survey, a quarter into its gap
    p.getState().tick(1000, dates);
    expect(p.getState().frame?.passed).toBe(0);
    expect(p.getState().frame?.f).toBeCloseTo(0.25, 9);
    expect(p.getState().playing).toBe(true);
  });

  it('restarts from the first survey when played at the end', () => {
    const p = createDatesPlayer();
    p.getState().seek(60 * DAY);
    p.getState().play(dates);
    expect(p.getState().t).toBe(0);
  });

  it('does not move while paused', () => {
    const p = createDatesPlayer();
    p.getState().seek(10 * DAY);
    p.getState().tick(1000, dates);
    expect(p.getState().t).toBe(10 * DAY);
    p.getState().play(dates);
    p.getState().pause();
    expect(p.getState().playing).toBe(false);
  });

  it('sets speed, loop and the between mode, and a seek clears the frame', () => {
    const p = createDatesPlayer();
    p.getState().setSpeed(2);
    p.getState().toggleLoop();
    p.getState().setBetween('hold');
    p.getState().play(dates);
    p.getState().tick(500, dates);
    expect(p.getState().frame?.f).toBeCloseTo(0.5, 9);
    p.getState().seek(10 * DAY);
    expect(p.getState()).toMatchObject({ speed: 2, loop: true, between: 'hold', frame: null });
    p.getState().tick(4000, dates);
    expect(p.getState().playing).toBe(true);
  });
});
