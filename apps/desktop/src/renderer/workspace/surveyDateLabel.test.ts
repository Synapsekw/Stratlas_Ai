import { describe, expect, it } from 'vitest';
import { surveyDateLabel } from './surveyDateLabel';

describe('surveyDateLabel', () => {
  it('drops the year of a label that is just the survey date', () => {
    expect(surveyDateLabel({ date: '2020-12-31', label: '31 Dec 2020' })).toBe('31 Dec');
  });
  it('keeps any other name whole, in any language', () => {
    expect(surveyDateLabel({ date: '2020-12-31', label: 'Pre-pour survey' })).toBe(
      'Pre-pour survey',
    );
    expect(surveyDateLabel({ date: '2020-12-31', label: '31 décembre 2020' })).toBe(
      '31 décembre 2020',
    );
  });
});
