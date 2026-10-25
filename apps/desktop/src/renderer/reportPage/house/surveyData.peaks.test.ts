import type { ComparisonResult } from '@aio/schema';
import type { TimeRow } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import { peaksOf } from './surveyData';

const result = (capture: string, over: Partial<ComparisonResult> = {}): ComparisonResult =>
  ({ item: 'a', status: 'ok', toCapture: capture, netM3: 10, ...over }) as ComparisonResult;

const row = (capture: string, over: Partial<TimeRow> = {}): TimeRow => ({
  capture,
  date: '2026-10-01',
  label: capture,
  valueM3: 10,
  changeM3: null,
  tonnes: null,
  status: 'ok',
  stale: false,
  latest: false,
  ...over,
});

describe('peak height per date', () => {
  it('takes each date from the result its row was read from', () => {
    const series = [result('c1', { peakM: 3 }), result('c2', { peakM: 4.5 })];
    expect(peaksOf(series, [row('c1'), row('c2')])).toEqual({ c1: 3, c2: 4.5 });
  });

  it('leaves out a stale, refused or peakless date', () => {
    const series = [
      result('c1', { peakM: 3 }),
      result('c2', { status: 'refused', peakM: 2 }),
      result('c3'),
      result('c4', { peakM: 1 }),
    ];
    const rows = [
      row('c1', { stale: true }),
      row('c2', { valueM3: null, status: 'refused' }),
      row('c3'),
      row('c4'),
    ];
    expect(peaksOf(series, rows)).toEqual({ c4: 1 });
  });
});
