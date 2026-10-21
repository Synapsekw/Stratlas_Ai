import { describe, expect, it } from 'vitest';
import { autoRange } from './autoRange';
import { tempAt, type ThermalRaster } from './raster';

function raster(data: number[], width = data.length, height = 1): ThermalRaster {
  return { width, height, data: Float32Array.from(data), meta: {} as ThermalRaster['meta'] };
}

describe('autoRange', () => {
  it('ignores NaN and a few extreme pixels', () => {
    const d = Array.from({ length: 1000 }, (_, i) => 20 + (i % 100) / 10);
    d[0] = 500;
    d[1] = -300;
    d[2] = NaN;
    const [lo, hi] = autoRange(raster(d));
    expect(lo).toBeGreaterThanOrEqual(20);
    expect(hi).toBeLessThanOrEqual(30);
    expect(hi).toBeGreaterThan(29);
  });
  it('gives a default range for an all-NaN raster', () => {
    expect(autoRange(raster([NaN, NaN]))).toEqual([0, 1]);
  });
  it('widens a flat raster so the range is not empty', () => {
    const [lo, hi] = autoRange(raster([7, 7, 7]));
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('tempAt', () => {
  const r = raster([1, 2, 3, NaN], 2, 2);
  it('reads the nearest pixel', () => {
    expect(tempAt(r, 0.4, 0.4)).toBe(1);
    expect(tempAt(r, 1.2, 0.9)).toBe(2);
    expect(tempAt(r, 0.2, 1.7)).toBe(3);
  });
  it('is null outside and on NaN', () => {
    expect(tempAt(r, -1, 0)).toBeNull();
    expect(tempAt(r, 2.6, 0)).toBeNull();
    expect(tempAt(r, 1, 1)).toBeNull();
  });
});
