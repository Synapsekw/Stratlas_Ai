import { describe, expect, it } from 'vitest';
import { Georef } from './georef';

const full = {
  schema: 'aio.georef/1',
  crs: { epsg: 32633 },
  anchor: [400000.125, 5600000.25, 12.5],
  axes: 'x-east,y-up,z-south',
  units: 'm',
  modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 400000.125, 5600000.25, 12.5, 1],
  heading: { deg: 12.5, status: 'measured' },
  scale: { factor: 1, status: 'reference' },
  horizontal: { status: 'surveyed', accuracyM: 0.02 },
  vertical: { datum: 'EGM2008', status: 'user' },
  provenance: { by: 'place-model', runId: 'run-1' },
  deviation: { rmsM: 0.01, p95M: 0.03, samples: 120 },
};

describe('Georef', () => {
  it('accepts a full record', () => {
    expect(Georef.safeParse(full).success).toBe(true);
  });
  it('refuses axes other than the one literal', () => {
    expect(Georef.safeParse({ ...full, axes: 'x-east,y-north,z-up' }).success).toBe(false);
  });
  it('refuses an anchor with NaN', () => {
    expect(Georef.safeParse({ ...full, anchor: [1, Number.NaN, 3] }).success).toBe(false);
  });
  it('requires status unknown for an unknown datum, and the reverse', () => {
    expect(
      Georef.safeParse({ ...full, vertical: { datum: 'unknown', status: 'user' } }).success,
    ).toBe(false);
    expect(
      Georef.safeParse({ ...full, vertical: { datum: 'EGM2008', status: 'unknown' } }).success,
    ).toBe(false);
    expect(
      Georef.safeParse({ ...full, vertical: { datum: 'unknown', status: 'unknown' } }).success,
    ).toBe(true);
  });
});
