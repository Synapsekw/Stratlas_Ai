import type { HeightTiles, SurveyMeasurement } from '@aio/schema';
import { measurementReadout, type PointSampler } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import { onPreparedSurface, readoutOn } from './dateReadout';

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

  it('reads stored points where a surface prepared with a line-up holds them', async () => {
    const east: PointSampler = (es) => Promise.resolve(Float64Array.from(es));
    const s = { id: 's', dateShiftM: { eastM: 0.5, northM: 0 } } as unknown as HeightTiles;
    const sample = onPreparedSurface(east, s, [0, 0, 0]);
    expect([...(await sample(Float64Array.of(10, 20), Float64Array.of(0, 0)))]).toEqual([
      10.5, 20.5,
    ]);
    // a surface prepared with no line-up is read as it is
    expect(onPreparedSurface(east, { id: 's' } as unknown as HeightTiles, [0, 0, 0])).toBe(east);
    expect(onPreparedSurface(east, null, [0, 0, 0])).toBe(east);
  });

  it('without a sampler is measurementReadout without a surface', async () => {
    expect(await readoutOn(line, undefined, null)).toEqual(measurementReadout(line, {}));
  });
});
