import { describe, expect, it } from 'vitest';
import { defaultUtcOffsetMin, siteUtcOffsetMin } from './clock';
import { fromWgs84 } from './index';

describe('defaultUtcOffsetMin', () => {
  it('rounds the longitude to whole hours', () => {
    expect(defaultUtcOffsetMin(fromWgs84([48.1352, 29.0276, 0], 32639), 32639)).toBe(180);
    expect(defaultUtcOffsetMin(fromWgs84([-73.98, 40.75, 0], 32618), 32618)).toBe(-300);
  });
  it('is 0 for a CRS it cannot read', () => {
    expect(defaultUtcOffsetMin([0, 0, 0], 999999)).toBe(0);
  });
});

describe('siteUtcOffsetMin', () => {
  it('rounds the longitude to whole hours', () => {
    expect(siteUtcOffsetMin(fromWgs84([48.1352, 29.0276, 0], 32639), 32639)).toBe(180);
    expect(siteUtcOffsetMin(fromWgs84([-73.98, 40.75, 0], 32618), 32618)).toBe(-300);
  });
  it('is 0, not null, for a site near Greenwich', () => {
    expect(siteUtcOffsetMin(fromWgs84([2.35, 48.85, 0], 32631), 32631)).toBe(0);
    expect(siteUtcOffsetMin(fromWgs84([-2.1, 51.5, 0], 32630), 32630)).toBe(0);
  });
  it('is null when the position cannot be read', () => {
    expect(siteUtcOffsetMin([0, 0, 0], 999999)).toBeNull();
    expect(siteUtcOffsetMin([0, 0, 0], undefined)).toBeNull();
  });
});
