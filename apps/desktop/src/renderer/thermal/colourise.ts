import { PALETTES, type PaletteId } from './palettes';
import type { ThermalRaster } from './raster';

export interface Isotherm {
  aboveC: number;
  rgba: [number, number, number, number];
}

function blank(width: number, height: number): ImageData {
  if (typeof ImageData !== 'undefined') return new ImageData(width, height);
  // no canvas here (a unit test): the same shape
  return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' };
}

/**
 * Paint a raster: `range[0]` takes palette entry 0 and `range[1]` entry 255, values outside are
 * clamped, pixels at or above the isotherm take its colour, and NaN stays transparent. Writes into
 * `out` when it has the raster's size, else makes a new image.
 */
export function colourise(
  r: ThermalRaster,
  range: [number, number],
  palette: PaletteId,
  isotherm?: Isotherm,
  out?: ImageData,
): ImageData {
  const fits = out?.width === r.width && out.height === r.height;
  const img = fits ? out : blank(r.width, r.height);
  const lut = PALETTES[palette];
  const [lo, hi] = range;
  const scale = hi > lo ? 255 / (hi - lo) : 0;
  const px = img.data;
  const n = r.width * r.height;
  for (let i = 0; i < n; i++) {
    const v = r.data[i] ?? Number.NaN;
    const o = i * 4;
    if (Number.isNaN(v)) {
      px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
    } else if (isotherm && v >= isotherm.aboveC) {
      px[o] = isotherm.rgba[0];
      px[o + 1] = isotherm.rgba[1];
      px[o + 2] = isotherm.rgba[2];
      px[o + 3] = isotherm.rgba[3];
    } else {
      const k = Math.min(255, Math.max(0, Math.round((v - lo) * scale))) * 4;
      px[o] = lut[k] ?? 0;
      px[o + 1] = lut[k + 1] ?? 0;
      px[o + 2] = lut[k + 2] ?? 0;
      px[o + 3] = lut[k + 3] ?? 255;
    }
  }
  return img;
}
