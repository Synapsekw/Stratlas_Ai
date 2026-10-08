import type { SurveyMeasurement, SurveyTemplate } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { dropdownFilters, filterMeasurements, groupByFolder, sortMeasurements } from './list';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const m = (
  id: string,
  label: string,
  extra: Partial<SurveyMeasurement> = {},
): SurveyMeasurement => ({
  id,
  family: 'line',
  tool: 'distance',
  label,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [1, 0, 0],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-08T06:00:00.000Z',
  ...extra,
});

const pad: SurveyTemplate = {
  id: 'pad-check',
  name: 'Pad check',
  family: 'polygon',
  tool: 'volume',
  items: [],
  fields: [{ id: 'crew', name: 'Crew', type: 'dropdown', options: ['North', 'South'] }],
  comparisons: [],
};

const list = [
  m('a', 'Kerb 2', { folder: 'Roads', createdBy: 'Rana Example' }),
  m('b', 'Kerb 10', { folder: 'Roads', createdAt: '2026-09-01T06:00:00.000Z' }),
  m('c', 'Pad A', {
    family: 'polygon',
    tool: 'volume',
    template: 'pad-check',
    fields: { crew: 'North' },
    scope: { kind: 'survey', capture: 'c2' },
  }),
  m('d', 'Pad B', {
    family: 'polygon',
    tool: 'volume',
    template: 'pad-check',
    fields: { crew: 'South' },
    material: 'gravel',
  }),
];

const ids = (xs: SurveyMeasurement[]) => xs.map((x) => x.id);

describe('measurement list', () => {
  it('searches labels, folders, template names and field values', () => {
    expect(ids(filterMeasurements(list, { search: 'roads' }))).toEqual(['a', 'b']);
    expect(ids(filterMeasurements(list, { search: 'pad check' }, [pad]))).toEqual(['c', 'd']);
    expect(ids(filterMeasurements(list, { search: 'south' }))).toEqual(['d']);
  });

  it('filters by template, me, the last 7 days, scope, a dropdown value and material', () => {
    expect(ids(filterMeasurements(list, { template: 'pad-check' }))).toEqual(['c', 'd']);
    expect(ids(filterMeasurements(list, { template: 'none' }))).toEqual(['a', 'b']);
    expect(ids(filterMeasurements(list, { createdBy: 'Rana Example' }))).toEqual(['a']);
    expect(ids(filterMeasurements(list, { lastSevenDays: true }, [], NOW))).toEqual([
      'a',
      'c',
      'd',
    ]);
    expect(ids(filterMeasurements(list, { scope: 'survey' }))).toEqual(['c']);
    expect(ids(filterMeasurements(list, { scope: 'survey:c1' }))).toEqual([]);
    expect(ids(filterMeasurements(list, { scope: 'site' }))).toEqual(['a', 'b', 'd']);
    expect(ids(filterMeasurements(list, { field: { id: 'crew', value: 'North' } }))).toEqual(['c']);
    expect(ids(filterMeasurements(list, { material: 'gravel' }))).toEqual(['d']);
  });

  it('sorts naturally and groups by folder, unfiled last', () => {
    expect(ids(sortMeasurements(list, 'name'))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(sortMeasurements(list, 'oldest'))[0]).toBe('b');
    expect(groupByFolder(list).map((g) => [g.folder, ids(g.measurements)])).toEqual([
      ['Roads', ['a', 'b']],
      ['', ['c', 'd']],
    ]);
  });

  it('offers the dropdown fields of the templates as filters', () => {
    expect(dropdownFilters([pad])).toEqual([
      { id: 'crew', name: 'Crew', options: ['North', 'South'] },
    ]);
  });
});
