import type { SurveyMeasurement, SurveyTemplate } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { filterTerms, matchingMeasurements } from './measureFilter';

const m = (over: Partial<SurveyMeasurement>): SurveyMeasurement => ({
  id: 'm1',
  family: 'line',
  tool: 'distance',
  label: 'Kerb line',
  points: [],
  items: [],
  results: [],
  scope: { kind: 'site' },
  createdAt: '2026-10-16T00:00:00Z',
  ...over,
});

const pad: SurveyTemplate = {
  id: 'pad-check',
  name: 'Pad check',
  family: 'polygon',
  tool: 'volume',
  items: ['Cut', 'Fill'],
  fields: [],
  comparisons: [],
} as unknown as SurveyTemplate;

/** Whether `x` alone (no other row in the project) matches. */
const matches = (q: string, x: SurveyMeasurement) =>
  matchingMeasurements([x], q, [pad]).length === 1;
const ids = (q: string, list: SurveyMeasurement[]) =>
  matchingMeasurements(list, q, [pad]).map((x) => x.id);

describe('filterTerms', () => {
  it('splits on any whitespace and lowercases; blank is no filter', () => {
    expect(filterTerms('  Crew\tA  ')).toEqual(['crew', 'a']);
    expect(filterTerms('   ')).toEqual([]);
  });
});

describe('matchingMeasurements, one row alone', () => {
  it('matches the label case-insensitively, as a substring', () => {
    expect(matches('KERB', m({}))).toBe(true);
    expect(matches('erb li', m({}))).toBe(true);
    expect(matches('fence', m({}))).toBe(false);
  });

  it('falls back to every term matching, each anywhere', () => {
    expect(matches('kerb distance', m({}))).toBe(true);
    expect(matches('kerb fence', m({}))).toBe(false);
  });

  it("matches the tool's name, the folder and the custom field values", () => {
    expect(matches('distance', m({}))).toBe(true);
    expect(matches('azimuth', m({ tool: 'azimuth' }))).toBe(true);
    expect(matches('zone b', m({ folder: 'Zone B' }))).toBe(true);
    const crew = m({ fields: { crew: 'Crew A', lot: 42 } });
    expect(matches('Crew A', crew)).toBe(true);
    expect(matches('42', crew)).toBe(true);
    expect(matches('crew z', crew)).toBe(false);
  });

  it("does not match a field's id, only its value", () => {
    expect(matches('lot', m({ fields: { lot: 42 } }))).toBe(false);
  });

  it("matches the template's name and item names", () => {
    const x = m({ template: 'pad-check', tool: 'volume', family: 'polygon' });
    expect(matches('pad check', x)).toBe(true);
    expect(matches('fill', x)).toBe(true);
    expect(matches('fill', m({}))).toBe(false);
  });

  it('a term does not run across two texts', () => {
    expect(matches('line zone', m({ folder: 'Zone' }))).toBe(true);
    expect(matches('linezone', m({ folder: 'Zone' }))).toBe(false);
  });

  it('a blank query matches everything', () => {
    expect(matches('', m({}))).toBe(true);
  });
});

describe('matchingMeasurements, phrase first', () => {
  const crewA = m({ id: 'a', label: 'Pad 1', fields: { crew: 'Crew A' } });
  const crewB = [
    m({ id: 'b1', label: 'Pad 2', tool: 'area', family: 'polygon', fields: { crew: 'Crew B' } }),
    m({ id: 'b2', label: 'Access road', tool: 'azimuth', fields: { crew: 'Crew B' } }),
    m({ id: 'b3', label: 'Pad 3', tool: 'antenna-tilt', fields: { crew: 'Crew B' } }),
  ];

  it('"Crew A" is only the crew A, among Area, Azimuth and "Access road" rows', () => {
    expect(ids('Crew A', [crewA, ...crewB])).toEqual(['a']);
    expect(ids('  crew   a ', [crewA, ...crewB])).toEqual(['a']);
  });

  it('a digit finds it anywhere: "2" finds "Pad check 12"', () => {
    const list = [m({ id: 'p12', label: 'Pad check 12' }), m({ id: 'k', label: 'Kerb' })];
    expect(ids('2', list)).toEqual(['p12']);
  });

  it('with no phrase match, every term anywhere: "pad 12" finds "Pad check 12"', () => {
    const list = [m({ id: 'p12', label: 'Pad check 12' }), m({ id: 'p3', label: 'Pad check 3' })];
    expect(ids('pad 12', list)).toEqual(['p12']);
  });

  it('a phrase is in one text, not across two', () => {
    // "kerb line" is the label; "line distance" runs from the label into the tool's name
    expect(ids('line distance', [m({})])).toEqual(['m1']);
    const both = [m({ id: 'x' }), m({ id: 'y', label: 'Line distance check' })];
    expect(ids('line distance', both)).toEqual(['y']);
  });
});
