import { describe, expect, it } from 'vitest';
import { ON_TOP_ORDER, lazyPicture, planDisplay, rasterDraw, rasterSlot } from './raster';

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

  it('on top: no depth test, after the models and clouds, under what is drawn on them', () => {
    const top = planDisplay({ onTop: true }, base);
    expect(top.depthTest).toBe(false);
    // models, clouds and the ground imagery draw at 0 or below
    expect(top.renderOrder).toBeGreaterThan(0);
    expect(top.renderOrder).toBeGreaterThanOrEqual(ON_TOP_ORDER);
    // the selection highlight (2), outlines (3 and up) and the measure line (30) stay above it
    expect(top.renderOrder).toBeLessThan(2);
    // two drawings on top keep their order
    const later = planDisplay({ onTop: true }, rasterDraw(2, 4, true));
    expect(later.renderOrder).toBeGreaterThan(top.renderOrder);
  });
});

describe('a picture that is loaded when it is first shown', () => {
  const setup = () => {
    const loads: { resolve: (t: { dispose(): void }) => void; reject: (e: Error) => void }[] = [];
    const applied: unknown[] = [];
    const failed: unknown[] = [];
    const picture = lazyPicture(
      () =>
        new Promise<{ dispose(): void }>((resolve, reject) => {
          loads.push({ resolve, reject });
        }),
      (t) => applied.push(t),
      (e) => failed.push(e),
    );
    return { loads, applied, failed, picture };
  };
  const texture = () => {
    const t = { disposed: 0, dispose: () => void (t.disposed += 1) };
    return t;
  };

  it('loads nothing until it is wanted, and then once', async () => {
    const { loads, applied, picture } = setup();
    expect(loads).toHaveLength(0);
    expect(picture.ready()).toBe(false);
    picture.want();
    picture.want();
    expect(loads).toHaveLength(1);
    const t = texture();
    loads[0]?.resolve(t);
    await Promise.resolve();
    expect(applied).toEqual([t]);
    expect(picture.ready()).toBe(true);
    picture.want();
    expect(loads).toHaveLength(1);
  });

  it('a picture that arrives after its layer went away is released, never shown', async () => {
    const { loads, applied, picture } = setup();
    picture.want();
    picture.dispose();
    const t = texture();
    loads[0]?.resolve(t);
    await Promise.resolve();
    expect(applied).toEqual([]);
    expect(t.disposed).toBe(1);
  });

  it('tries again on the next show after a load failed', async () => {
    const { loads, failed, picture } = setup();
    picture.want();
    loads[0]?.reject(new Error('gone'));
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).toHaveLength(1);
    picture.want();
    expect(loads).toHaveLength(2);
  });
});
