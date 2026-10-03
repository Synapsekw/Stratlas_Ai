import { describe, expect, it } from 'vitest';
import type { RawImage } from './png';
import { lineArtBackground, lineArtToAlpha } from './rasterops';

/** A w x h image of `bg` with one line pixel `line` at (1, 1). */
function img(
  bg: readonly number[],
  line: readonly number[],
  channels: 3 | 4 = 3,
  w = 4,
  h = 3,
): RawImage {
  const data = new Uint8Array(w * h * channels);
  for (let p = 0; p < w * h; p++)
    data.set((p === w + 1 ? line : bg).slice(0, channels), p * channels);
  return { width: w, height: h, channels, data };
}
const px = (r: RawImage, x: number, y: number) => {
  const o = (y * r.width + x) * 4;
  return Array.from(r.data.subarray(o, o + 4));
};

describe('line art to alpha', () => {
  it('detects the background: own alpha, black or white ground', () => {
    expect(lineArtBackground(img([255, 255, 255, 0], [255, 255, 255, 200], 4))).toBe('alpha');
    expect(lineArtBackground(img([0, 0, 0], [255, 255, 255]))).toBe('black');
    expect(lineArtBackground(img([255, 255, 255], [0, 0, 0]))).toBe('white');
    // opaque RGBA is judged by its ground, not its alpha
    expect(lineArtBackground(img([250, 250, 250, 255], [10, 10, 10, 255], 4))).toBe('white');
  });

  it('makes a black ground transparent and keeps the line colour', () => {
    const r = lineArtToAlpha(img([0, 0, 0], [200, 100, 0]));
    expect(px(r, 0, 0)[3]).toBe(0);
    // a half covered orange edge pixel: alpha 200, colour un-mixed from black
    expect(px(r, 1, 1)).toEqual([255, 128, 0, 200]);
  });

  it('makes a white ground transparent and keeps the line colour', () => {
    const r = lineArtToAlpha(img([255, 255, 255], [0, 0, 255]));
    expect(px(r, 0, 0)[3]).toBe(0);
    expect(px(r, 1, 1)).toEqual([0, 0, 255, 255]);
    // the ground under alpha 0 carries the line colour, so filtering adds no pale fringe
    expect(px(r, 2, 1).slice(0, 3)).toEqual([0, 0, 255]);
  });

  it('keeps the alpha of transparent line art and tints monochrome lines', () => {
    const src = img([255, 255, 255, 0], [255, 255, 255, 90], 4);
    const r = lineArtToAlpha(src, { tint: [209, 15, 15] });
    expect(px(r, 1, 1)).toEqual([209, 15, 15, 90]);
    expect(px(r, 0, 0)).toEqual([209, 15, 15, 0]);
    // black lines on white are monochrome too
    expect(px(lineArtToAlpha(img([255, 255, 255], [0, 0, 0]), { tint: [1, 2, 3] }), 1, 1)).toEqual([
      1, 2, 3, 255,
    ]);
  });

  it('does not tint coloured line art', () => {
    const r = lineArtToAlpha(img([255, 255, 255], [0, 160, 0]), { tint: [209, 15, 15] });
    expect(px(r, 1, 1)).toEqual([0, 160, 0, 255]);
  });
});
