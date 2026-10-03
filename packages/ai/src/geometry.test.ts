import { describe, expect, it } from 'vitest';
import { parseFlight, passNear } from './geometry';

// A straight pass along X at 100 m height, 10 m/s, sampled every second.
const flight = parseFlight({
  schema: 'aio.flight/1',
  startUtcMs: 1_000_000,
  samples: Array.from({ length: 21 }, (_, i) => ({
    t: i * 1000,
    pos: [-100 + i * 10, 100, 0],
    q: [0, 0, 0, 1],
  })),
});

describe('flight files', () => {
  it('parses the aio.flight/1 format', () => {
    expect(flight?.samples).toHaveLength(21);
    expect(flight?.startUtcMs).toBe(1_000_000);
  });

  it('rejects anything else', () => {
    expect(parseFlight({ samples: 'nope' })).toBeNull();
    expect(parseFlight(null)).toBeNull();
  });
});

describe('passNear', () => {
  if (!flight) throw new Error('fixture did not parse');

  it('finds the closest approach and the time inside the radius', () => {
    const r = passNear(flight, 1_000_000, [0, 70, 0], 40);
    expect(r?.minDistanceM).toBeCloseTo(30);
    expect(r?.closestAtUtcMs).toBe(1_010_000);
    // Inside 40 m of the point while |x| <= sqrt(40^2 - 30^2) = 26.5 m: t = 8 s to 12 s.
    expect(r?.ranges).toEqual([[1_008_000, 1_012_000]]);
  });

  it('interpolates the closest point between samples', () => {
    const r = passNear(flight, 1_000_000, [5, 100, 0], 1);
    expect(r?.minDistanceM).toBeCloseTo(0);
    expect(r?.closestAtUtcMs).toBe(1_010_500);
  });

  it('returns null when the flight never comes within the radius', () => {
    expect(passNear(flight, 1_000_000, [0, 0, 500], 40)).toBeNull();
  });
});
