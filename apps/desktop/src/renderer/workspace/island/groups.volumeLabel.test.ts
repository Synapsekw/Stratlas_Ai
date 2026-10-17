// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { surveyDateLabel } from './groups';

describe('surveyDateLabel', () => {
  it('is the survey label less its year, as the Volumes tab shows it', () => {
    expect(surveyDateLabel('31 Dec 2020')).toBe('31 Dec');
  });
  it('keeps a label that is not a date', () => {
    expect(surveyDateLabel('Pre-pour survey')).toBe('Pre-pour survey');
  });
});
