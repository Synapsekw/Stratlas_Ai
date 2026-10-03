import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatClock,
  formatCompact,
  formatCount,
  formatDate,
  formatDuration,
  formatTimecode,
} from './format';

describe('formatBytes', () => {
  it('uses binary units with one decimal below 10', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(186 * 1024 ** 3)).toBe('186 GB');
    expect(formatBytes(1.4 * 1024 ** 4)).toBe('1.4 TB');
  });
});

describe('formatCount and formatCompact', () => {
  it('groups thousands', () => {
    expect(formatCount(1182)).toBe('1,182');
  });
  it('compacts large counts', () => {
    expect(formatCompact(950)).toBe('950');
    expect(formatCompact(280_000)).toBe('280 k');
    expect(formatCompact(1_400_000)).toBe('1.4 M');
    expect(formatCompact(842_000_000)).toBe('842 M');
  });
});

describe('dates and times', () => {
  it('formats ISO dates as day month year', () => {
    expect(formatDate('2023-02-21')).toBe('21 Feb 2023');
    expect(formatDate('2023-11-22T09:18:00Z')).toBe('22 Nov 2023');
    expect(formatDate('not a date')).toBe('not a date');
  });
  it('formats a UTC clock', () => {
    expect(formatClock(Date.UTC(2023, 1, 21, 15, 11, 16, 500))).toBe('15:11:16');
  });
  it('formats a timecode with frames', () => {
    expect(formatTimecode(Date.UTC(2023, 1, 21, 0, 1, 23, 500), 30)).toBe('00:01:23:15');
  });
  it('formats durations', () => {
    expect(formatDuration(11_000)).toBe('0:11');
    expect(formatDuration(62_000)).toBe('1:02');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });
});
