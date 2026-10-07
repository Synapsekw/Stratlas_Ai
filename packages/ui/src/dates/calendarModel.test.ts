import { describe, expect, it } from 'vitest';
import { monthGrid, stepMonth, surveyMonths } from './calendarModel';

describe('calendar model', () => {
  it('builds a Monday-first grid', () => {
    const g = monthGrid('2024-11'); // 1 Nov 2024 is a Friday
    expect(g[0]).toEqual([null, null, null, null, '2024-11-01', '2024-11-02', '2024-11-03']);
    expect(g.flat().filter(Boolean)).toHaveLength(30);
    expect(g.every((row) => row.length === 7)).toBe(true);
  });
  it('lists survey months once, sorted', () => {
    expect(surveyMonths(['2024-11-06', '2024-09-04', '2024-11-25'])).toEqual([
      '2024-09',
      '2024-11',
    ]);
  });
  it('steps only between survey months and clamps at the ends', () => {
    const m = ['2024-09', '2024-11', '2025-02'];
    expect(stepMonth(m, '2024-11', 1)).toBe('2025-02');
    expect(stepMonth(m, '2024-11', -1)).toBe('2024-09');
    expect(stepMonth(m, '2025-02', 1)).toBe('2025-02');
  });
});
