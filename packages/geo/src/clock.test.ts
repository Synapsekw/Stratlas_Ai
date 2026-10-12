import { describe, expect, it } from 'vitest';
import { defaultUtcOffsetMin } from './clock';
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
