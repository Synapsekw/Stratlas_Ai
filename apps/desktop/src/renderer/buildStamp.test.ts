import { describe, expect, it } from 'vitest';
import { build, formatBuildTime } from './buildStamp';

// Built from local components, so the expectations hold in any time zone.
const local = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m, d, h, min).toISOString();

describe('formatBuildTime', () => {
  it('shows the build time in local time with the year', () => {
    expect(formatBuildTime(local(2026, 9, 4, 16, 0))).toBe('4 Oct 2026, 16:00');
  });

  it('drops the year for the compact form', () => {
    expect(formatBuildTime(local(2026, 0, 31, 9, 5), { year: false })).toBe('31 Jan 09:05');
  });

  it('converts a UTC stamp to the local clock', () => {
    const iso = '2026-10-04T14:00:00.000Z';
    const d = new Date(iso);
    const clock = [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
    expect(formatBuildTime(iso).endsWith(`, ${clock}`)).toBe(true);
  });

  it('gives nothing for a missing or broken time', () => {
    expect(formatBuildTime('')).toBe('');
    expect(formatBuildTime('not a date')).toBe('');
  });
});

describe('build', () => {
  it('falls back to "dev" when the bundle was not stamped', () => {
    expect(build).toEqual({ time: '', commit: 'dev', version: '' });
  });
});
