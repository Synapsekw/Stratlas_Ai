import { describe, expect, it } from 'vitest';
import { buildParams, emptySurvey, noSurveys, surveyProblem } from './surveys';

const dsm = (date: string) => ({ ...emptySurvey(date), dsm: `D:/s/${date}_dsm.tif` });

describe('survey dates of a new volumetric project', () => {
  it('builds nothing when no file was picked', () => {
    expect(noSurveys([emptySurvey('2026-01-01')])).toBe(true);
    expect(surveyProblem([emptySurvey()])).toBeNull();
  });

  it('needs a date and a DSM or a point cloud per survey, and different dates', () => {
    expect(surveyProblem([{ ...emptySurvey(), ortho: 'o.tif' }])).toBe('builder.surveys.needDate');
    expect(surveyProblem([{ ...emptySurvey('2026-01-01'), ortho: 'o.tif' }])).toBe(
      'builder.surveys.needSurface',
    );
    expect(surveyProblem([dsm('2026-01-01'), dsm('2026-01-01')])).toBe('builder.surveys.sameDate');
    expect(
      surveyProblem([dsm('2026-01-01'), { ...emptySurvey('2026-01-10'), cloud: 'c.laz' }]),
    ).toBe(null);
  });

  it('orders the surveys by date as e1 and e2 and keeps the ortho', () => {
    const p = buildParams([
      { ...emptySurvey('2026-01-10'), cloud: 'D:/s/b.laz' },
      { ...dsm('2026-01-01'), ortho: 'D:/s/a_ortho.tif' },
    ]);
    expect(p).toEqual({
      config: {
        epochs: [
          {
            id: 'e1',
            date: '2026-01-01',
            dsm: 'D:/s/2026-01-01_dsm.tif',
            ortho: 'D:/s/a_ortho.tif',
          },
          { id: 'e2', date: '2026-01-10', cloud: 'D:/s/b.laz' },
        ],
      },
    });
  });

  it('refuses what the job would refuse', () => {
    expect(() => buildParams([{ ...emptySurvey('2026-01-01') }])).toThrow();
  });
});
