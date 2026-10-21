import { describe, expect, it } from 'vitest';
import { colourise } from './colourise';
import { PALETTES } from './palettes';
import type { ThermalRaster } from './raster';

function raster(data: number[], width = data.length, height = 1): ThermalRaster {
  return { width, height, data: Float32Array.from(data), meta: {} as ThermalRaster['meta'] };
}
const at = (img: { data: Uint8ClampedArray }, i: number) => [...img.data.slice(i * 4, i * 4 + 4)];
const lut = (i: number) => [...PALETTES.iron.slice(i * 4, i * 4 + 4)];

describe('colourise', () => {
  it('maps min to entry 0 and max to entry 255, clamping outside', () => {
    const img = colourise(raster([10, 20, 5, 30]), [10, 20], 'iron');
    expect(at(img, 0)).toEqual(lut(0));
    expect(at(img, 1)).toEqual(lut(255));
    expect(at(img, 2)).toEqual(lut(0));
    expect(at(img, 3)).toEqual(lut(255));
  });
  it('leaves NaN transparent', () => {
    const img = colourise(raster([NaN, 15]), [10, 20], 'iron');
    expect(at(img, 0)).toEqual([0, 0, 0, 0]);
    expect(at(img, 1)[3]).toBe(255);
  });
  it('paints isotherm pixels at or above the limit', () => {
    const img = colourise(raster([10, 20, 25]), [10, 30], 'iron', {
      aboveC: 20,
      rgba: [1, 2, 3, 4],
    });
    expect(at(img, 0)).toEqual(lut(0));
    expect(at(img, 1)).toEqual([1, 2, 3, 4]);
    expect(at(img, 2)).toEqual([1, 2, 3, 4]);
  });
  it('reuses out when it fits', () => {
    const out = colourise(raster([1, 2]), [1, 2], 'whiteHot');
    expect(colourise(raster([2, 1]), [1, 2], 'whiteHot', undefined, out)).toBe(out);
  });
  it('copes with an empty range', () => {
    const img = colourise(raster([5, 5]), [5, 5], 'whiteHot');
    expect(at(img, 0)[3]).toBe(255);
  });
});
