import { describe, expect, it } from 'vitest';
import { hhmm, siteClock, siteInstant } from './envClock';

describe('site clock', () => {
  it('shows an instant in site time', () => {
    // 10:22 UTC is 13:22 in Kuwait (UTC+3)
    expect(siteClock(Date.UTC(2023, 1, 21, 10, 22), 3)).toEqual({
      date: '2023-02-21',
      minutes: 802,
    });
    // 22:30 UTC is already the next day in Kuwait
    expect(siteClock(Date.UTC(2023, 1, 21, 22, 30), 3)).toEqual({
      date: '2023-02-22',
      minutes: 90,
    });
  });

  it('round-trips a site date and time', () => {
    const ms = siteInstant('2023-02-21', 17 * 60 + 30, 3);
    expect(ms).toBe(Date.UTC(2023, 1, 21, 14, 30));
    expect(siteClock(ms ?? 0, 3)).toEqual({ date: '2023-02-21', minutes: 1050 });
    expect(siteInstant('not a date', 0, 3)).toBeNull();
  });

  it('formats minutes as hours and minutes', () => {
    expect(hhmm(0)).toBe('00:00');
    expect(hhmm(802)).toBe('13:22');
  });
});
