/**
 * Volume rate and forecast, two executors, one formula (ADR 0009): every case of
 * `packages/schema/src/__fixtures__/survey/trend.json` run through `volumeTrend` agrees with the
 * stored result to 1e-9 relative, with the same statuses and dates. The Python twin
 * (`python/src/aio_pipelines/survey/trend.py`) reproduces the same file in
 * `python/tests/test_survey_trend.py`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { volumeTrend, type TrendPoint, type VolumeTrend } from './trend';

const FILE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'schema',
  'src',
  '__fixtures__',
  'survey',
  'trend.json',
);

interface TrendCase {
  id: string;
  note: string;
  points: TrendPoint[];
  expected: VolumeTrend;
}

const { cases } = JSON.parse(readFileSync(FILE, 'utf8')) as { cases: TrendCase[] };

describe('volumeTrend parity with the shared fixture', () => {
  it('has the cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const c of cases)
    it(`${c.id}: ${c.note}`, () => {
      const got = volumeTrend(c.points);
      expect(Object.keys(got).sort()).toEqual(Object.keys(c.expected).sort());
      for (const [k, want] of Object.entries(c.expected)) {
        const v = got[k as keyof VolumeTrend];
        if (typeof want === 'number') {
          expect(typeof v, k).toBe('number');
          expect(Math.abs((v as number) - want), k).toBeLessThanOrEqual(
            1e-9 * Math.max(1, Math.abs(want)),
          );
        } else expect(v, k).toEqual(want);
      }
    });
});
