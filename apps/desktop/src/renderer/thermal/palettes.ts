export const PALETTE_IDS = ['iron', 'rainbow', 'whiteHot', 'blackHot', 'arctic'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

type Stop = readonly [number, number, number];

/** 256 opaque RGBA entries blended linearly between evenly spaced colour stops. */
function ramp(stops: readonly Stop[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256 * 4);
  const last = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * last;
    const k = Math.min(Math.floor(pos), last - 1);
    const f = pos - k;
    const a = stops[k] ?? [0, 0, 0];
    const b = stops[k + 1] ?? a;
    for (let c = 0; c < 3; c++)
      out[i * 4 + c] = Math.round((a[c] ?? 0) * (1 - f) + (b[c] ?? 0) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function reversed(lut: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(lut.length);
  for (let i = 0; i < 256; i++) out.set(lut.subarray((255 - i) * 4, (255 - i) * 4 + 4), i * 4);
  return out;
}

const whiteHot = ramp([
  [0, 0, 0],
  [255, 255, 255],
]);

/** 256 x RGBA lookup tables, coldest first. */
export const PALETTES: Record<PaletteId, Uint8ClampedArray> = {
  iron: ramp([
    [0, 0, 0],
    [32, 0, 110],
    [140, 20, 130],
    [210, 50, 60],
    [245, 140, 20],
    [255, 220, 60],
    [255, 255, 255],
  ]),
  rainbow: ramp([
    [20, 0, 130],
    [0, 80, 255],
    [0, 220, 220],
    [60, 220, 60],
    [255, 240, 0],
    [255, 120, 0],
    [255, 0, 0],
  ]),
  whiteHot,
  blackHot: reversed(whiteHot),
  arctic: ramp([
    [10, 20, 60],
    [30, 90, 170],
    [120, 200, 230],
    [235, 245, 250],
    [250, 200, 120],
    [220, 90, 40],
  ]),
};
