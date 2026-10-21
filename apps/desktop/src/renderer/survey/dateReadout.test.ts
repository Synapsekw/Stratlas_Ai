import type { SurveyMeasurement } from '@aio/schema';
import { measurementReadout, type PointSampler } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import { readoutOn } from './dateReadout';

const line = {
  id: 'm1',
  tool: 'distance',
  points: [
    [0, 0, 0],
    [10, 0, 0],
  ],
} as unknown as SurveyMeasurement;

const five: PointSampler = (es) => Promise.resolve(new Float64Array(es.length).fill(5));

describe('readoutOn', () => {
  it('fills terrain rows from the sampler', async () => {
    const rows = await readoutOn(line, undefined, five);
    expect(rows).toEqual(measurementReadout(line, { surface: { heightAt: () => 5 } }));
  });

  it('without a sampler is measurementReadout without a surface', async () => {
    expect(await readoutOn(line, undefined, null)).toEqual(measurementReadout(line, {}));
  });
});
