import { describe, expect, it } from 'vitest';
import { generateTicks, pickTickStep } from './ticks';

describe('pickTickStep', () => {
  it('chooses a step whose labels fit the width', () => {
    // 3 hours over 900 px: 30 min majors are 150 px apart.
    const s = pickTickStep(3 * 3_600_000, 900);
    expect(s.major).toBe(30 * 60_000);
    expect(s.minor).toBe(5 * 60_000);
  });
  it('goes down to seconds for short ranges', () => {
    const s = pickTickStep(11_000, 1300);
    expect(s.major).toBe(1_000);
  });
  it('never returns a zero step', () => {
    expect(pickTickStep(0, 100).major).toBeGreaterThan(0);
  });
});

describe('generateTicks', () => {
  it('aligns to the step and marks majors', () => {
    const ticks = generateTicks(1_500, 6_000, { major: 2_000, minor: 1_000 });
    expect(ticks.map((t) => t.t)).toEqual([2_000, 3_000, 4_000, 5_000, 6_000]);
    expect(ticks.filter((t) => t.major).map((t) => t.t)).toEqual([2_000, 4_000, 6_000]);
  });
  it('caps the number of ticks', () => {
    expect(generateTicks(0, 1e9, { major: 10, minor: 1 }).length).toBeLessThanOrEqual(2000);
  });
});
