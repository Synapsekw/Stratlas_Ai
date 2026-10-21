import { describe, expect, it } from 'vitest';
import { PALETTES, PALETTE_IDS } from './palettes';

const px = (id: keyof typeof PALETTES, i: number) => [...PALETTES[id].slice(i * 4, i * 4 + 4)];

describe('palettes', () => {
  it('has 256 RGBA entries per palette, all opaque', () => {
    expect(PALETTE_IDS).toEqual(['iron', 'rainbow', 'whiteHot', 'blackHot', 'arctic']);
    for (const id of PALETTE_IDS) {
      expect(PALETTES[id].length).toBe(256 * 4);
      for (let i = 0; i < 256; i++) expect(px(id, i)[3]).toBe(255);
    }
  });
  it('whiteHot runs black to white and blackHot is its reverse', () => {
    expect(px('whiteHot', 0)).toEqual([0, 0, 0, 255]);
    expect(px('whiteHot', 255)).toEqual([255, 255, 255, 255]);
    for (let i = 0; i < 256; i++) expect(px('blackHot', i)).toEqual(px('whiteHot', 255 - i));
  });
  it('iron starts dark and ends bright', () => {
    const lum = (p: number[]) => (p[0] ?? 0) + (p[1] ?? 0) + (p[2] ?? 0);
    expect(lum(px('iron', 0))).toBeLessThan(lum(px('iron', 255)));
  });
});
