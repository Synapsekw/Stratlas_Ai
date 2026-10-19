import type { SurveyMeasurement, SurveyTemplate } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { filterTerms, measureMatcher } from './measureFilter';

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

const matches = (q: string, x: SurveyMeasurement) => measureMatcher(q, [pad])(x);

describe('filterTerms', () => {
  it('splits on any whitespace and lowercases; blank is no filter', () => {
    expect(filterTerms('  Crew\tA  ')).toEqual(['crew', 'a']);
    expect(filterTerms('   ')).toEqual([]);
  });
});

describe('measureMatcher', () => {
  it('matches the label case-insensitively, as a substring', () => {
    expect(matches('KERB', m({}))).toBe(true);
    expect(matches('erb li', m({}))).toBe(true);
    expect(matches('fence', m({}))).toBe(false);
  });

  it('needs every term to match, each anywhere', () => {
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

  it('a term does not run across two fields', () => {
    expect(matches('line zone', m({ folder: 'Zone' }))).toBe(true);
    expect(matches('linezone', m({ folder: 'Zone' }))).toBe(false);
  });

  it('a one-character term matches only at the start of a word', () => {
    // "Distance" holds an "a": "Crew A" is still only the crew A
    expect(matches('crew a', m({ fields: { crew: 'Crew A' } }))).toBe(true);
    expect(matches('crew a', m({ fields: { crew: 'Crew B' } }))).toBe(false);
    expect(matches('line 1', m({ label: 'Line 12' }))).toBe(true);
    expect(matches('line 2', m({ label: 'Line 12' }))).toBe(false);
    expect(matches('k', m({}))).toBe(true);
  });

  it('a blank query matches everything', () => {
    expect(matches('', m({}))).toBe(true);
  });
});
