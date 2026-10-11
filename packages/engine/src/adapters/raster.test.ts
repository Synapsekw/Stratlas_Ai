import { describe, expect, it } from 'vitest';
import { ON_TOP_ORDER, planDisplay, rasterDraw, rasterSlot } from './raster';

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

describe('how a drawing lies over the scene', () => {
  const base = rasterDraw(2, 3, true);

  it('draws as it always did until a choice is made', () => {
    expect(planDisplay(undefined, base)).toEqual({
      opacity: 1,
      depthTest: true,
      renderOrder: base.renderOrder,
    });
    expect(planDisplay({}, base).opacity).toBe(1);
  });

  it('takes the chosen opacity', () => {
    expect(planDisplay({ opacity: 0.35 }, base).opacity).toBe(0.35);
  });

  it('on top: no depth test, after the models and clouds, before the pick markers', () => {
    const top = planDisplay({ onTop: true }, base);
    expect(top.depthTest).toBe(false);
    expect(top.renderOrder).toBeGreaterThan(ON_TOP_ORDER - 1);
    expect(top.renderOrder).toBeLessThan(60);
    // two drawings on top keep their order
    const later = planDisplay({ onTop: true }, rasterDraw(2, 4, true));
    expect(later.renderOrder).toBeGreaterThan(top.renderOrder);
  });
});
