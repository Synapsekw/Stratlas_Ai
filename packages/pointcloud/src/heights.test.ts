import { describe, expect, it } from 'vitest';
import { HEIGHT_SAMPLES, robustHeightRange, sampleHeights } from './heights';

describe('sampleHeights', () => {
  it('keeps every height of a small chunk', () => {
    expect([...sampleHeights(4, (i) => i * 2)]).toEqual([0, 2, 4, 6]);
  });

  it('spreads at most the sample size over a large chunk, first point first', () => {
    const s = sampleHeights(100_000, (i) => i);
    expect(s.length).toBe(HEIGHT_SAMPLES);
    expect(s[0]).toBe(0);
    // evenly spread: the last sample sits in the last stride
    expect(s[s.length - 1]).toBeGreaterThan(100_000 - 100_000 / HEIGHT_SAMPLES - 1);
  });

  it('skips non-finite heights and handles an empty chunk', () => {
    expect([...sampleHeights(3, (i) => (i === 1 ? NaN : i))]).toEqual([0, 2]);
    expect(sampleHeights(0, () => 1).length).toBe(0);
  });
});

describe('robustHeightRange', () => {
  const ramp = (n: number, lo: number, hi: number) =>
    Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));

  it('is null without heights', () => {
    expect(robustHeightRange([])).toBeNull();
    expect(robustHeightRange([{ heights: [NaN, Infinity] }])).toBeNull();
  });

  it('spans the 1st to 99th percentile, so stray points do not squash the ramp', () => {
    // ground and plant from -17 to 76 m (Al-Zour, local Y), a -9999 no-data point and sky noise
    const heights = [-9999, ...ramp(998, -17, 76), 2000];
    const r = robustHeightRange([{ heights }]);
    expect(r?.extent).toEqual([-9999, 2000]);
    const [lo, hi] = r?.range ?? [NaN, NaN];
    expect(lo).toBeGreaterThan(-17.1);
    expect(lo).toBeLessThan(-15);
    expect(hi).toBeGreaterThan(74);
    expect(hi).toBeLessThan(76.1);
  });

  it('takes custom percentiles', () => {
    const r = robustHeightRange([{ heights: ramp(101, 0, 100) }], 0.1, 0.9);
    expect(r?.range).toEqual([10, 90]);
    expect(robustHeightRange([{ heights: ramp(101, 0, 100) }], 0, 1)?.range).toEqual([0, 100]);
  });

  it('weights each sample by the points it stands for', () => {
    // 1 000 points low (sampled twice) against 10 points high (sampled twice)
    const r = robustHeightRange(
      [
        { heights: [0, 1], weight: 500 },
        { heights: [50, 60], weight: 5 },
      ],
      0.01,
      0.95,
    );
    expect(r?.range).toEqual([0, 1]);
    expect(r?.extent).toEqual([0, 60]);
  });

  it('falls back to the extent for a flat cloud', () => {
    const heights = [...new Array<number>(200).fill(3), 3.5];
    expect(robustHeightRange([{ heights }])?.range).toEqual([3, 3.5]);
  });
});
