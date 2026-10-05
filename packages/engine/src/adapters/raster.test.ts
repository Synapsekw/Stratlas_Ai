import { describe, expect, it } from 'vitest';
import { rasterDraw, rasterSlot } from './raster';

describe('raster drawing', () => {
  it('cuts the transparent no-data collar of photographic rasters away', () => {
    const ortho = rasterDraw(0, 0, false);
    expect(ortho.alphaTest).toBe(0.5);
    expect(ortho.transparent).toBe(false);
    // plans blend their transparent background instead
    const plan = rasterDraw(2, 0, true);
    expect(plan.alphaTest).toBe(0);
    expect(plan.transparent).toBe(true);
  });

  it('keeps finer levels and later layers in front on a shared plane', () => {
    expect(rasterDraw(1, 0, false).offsetUnits).toBeLessThan(rasterDraw(0, 0, false).offsetUnits);
    // the coarsest level of a later layer still beats the finest level of an earlier one
    expect(rasterDraw(0, 1, false).offsetUnits).toBeLessThan(rasterDraw(3, 0, false).offsetUnits);
    expect(rasterDraw(0, 1, false).renderOrder).toBeGreaterThan(
      rasterDraw(0, 0, false).renderOrder,
    );
  });

  it('gives each layer one stable slot', () => {
    const a = rasterSlot('test-ortho-a');
    const b = rasterSlot('test-ortho-b');
    expect(b).toBe(a + 1);
    expect(rasterSlot('test-ortho-a')).toBe(a);
  });
});
