import { describe, expect, it } from 'vitest';
import { captureDateOf, weighRows } from './surveyDates';

const dateOf = captureDateOf([
  { id: 'd1', date: '2020-12-31' },
  { id: 'd2', date: '2021-01-10' },
]);

describe('weighRows', () => {
  it('weighs each date at the density on that date, an older-build density from its date on', () => {
    const rows = [
      { capture: 'd1', valueM3: 100, tonnes: null },
      { capture: 'd2', valueM3: 200, tonnes: null },
      { capture: 'd3', valueM3: null, tonnes: null },
    ];
    const agg = {
      id: 'agg',
      name: 'Aggregate',
      // densityTPerM3 saved alone after the history: an edit from the newest entry's date on
      densityTPerM3: 2,
      densityHistory: [
        { fromCapture: 'd1', tPerM3: 1.5 },
        { fromCapture: 'd2', tPerM3: 1.6 },
      ],
    };
    expect(weighRows(rows, agg, dateOf).map((r) => r.tonnes)).toEqual([150, 400, null]);
    expect(weighRows(rows, null, dateOf).map((r) => r.tonnes)).toEqual([null, null, null]);
  });
});
