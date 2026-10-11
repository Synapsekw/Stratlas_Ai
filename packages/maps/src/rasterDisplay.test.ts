import { describe, expect, it } from 'vitest';
import { rasterOpacity } from './rasterDisplay';

describe('raster opacity on the map', () => {
  it('keeps the old values until a choice is made', () => {
    expect(rasterOpacity('plan')).toBe(0.75);
    expect(rasterOpacity('plan', {})).toBe(0.75);
    expect(rasterOpacity('ortho')).toBe(0.95);
    expect(rasterOpacity('dsm', undefined, true)).toBe(1);
    expect(rasterOpacity('plan', undefined, true)).toBe(1);
  });

  it('a drawing takes the chosen opacity, coarse and fine tiles alike', () => {
    expect(rasterOpacity('plan', { opacity: 0.3 })).toBe(0.3);
    expect(rasterOpacity('plan', { opacity: 0.3 }, true)).toBe(0.3);
    expect(rasterOpacity('plan', { opacity: 0 })).toBe(0);
  });

  it('an ortho ignores it', () => {
    expect(rasterOpacity('ortho', { opacity: 0.3 })).toBe(0.95);
  });
});
