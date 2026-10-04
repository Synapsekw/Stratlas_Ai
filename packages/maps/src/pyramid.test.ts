import { describe, expect, it } from 'vitest';
import { levelMetresPerPx, pyramidView, type PyramidIndex } from './pyramid';

// The Ring Road pyramid: a 4259.84 m square, 1024 px tiles, levels 0 (4.16 m) to 7 (3.25 cm).
const index: PyramidIndex = {
  levels: Array.from({ length: 8 }, (_, z) => ({
    z,
    tileSize: 1024,
    cols: 2 ** z,
    rows: 2 ** z,
    pattern: `rasters/ortho/${z}/{x}_{y}.webp`,
  })),
  corners: { tl: [-2130, 0, -2131], tr: [2129.84, 0, -2131], bl: [-2130, 0, 2128.84] },
};

describe('kit pyramid on the map', () => {
  it('knows the ground size of a pixel per level', () => {
    expect(levelMetresPerPx(index, 0)).toBeCloseTo(4.16, 6);
    expect(levelMetresPerPx(index, 7)).toBeCloseTo(0.0325, 6);
  });

  it('picks the coarsest level still as sharp as the screen, and the tiles in view', () => {
    // 100 x 60 m around the origin at 6.5 cm per screen pixel: level 6 (6.5 cm) suffices.
    const v = pyramidView(index, { minX: -50, maxX: 50, minZ: -30, maxZ: 30 }, 0.065);
    expect(v?.z).toBe(6);
    // Level 6 tiles are 66.56 m: x from -50 is col floor(2080 / 66.56) = 31 to col 32.
    const xs = new Set(v?.tiles.map((t) => t.x));
    const ys = new Set(v?.tiles.map((t) => t.y));
    expect([...xs].sort()).toEqual([31, 32]);
    expect([...ys].sort()).toEqual([31, 32]);
    expect(v?.tiles[0]?.path).toMatch(/^rasters\/ortho\/6\/\d+_\d+\.webp$/);
  });

  it('uses the finest level when zoomed past it', () => {
    const v = pyramidView(index, { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 0.005);
    expect(v?.z).toBe(7);
  });

  it('drops to a coarser level rather than load too many tiles', () => {
    const v = pyramidView(index, { minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000 }, 0.03, 40);
    expect(v?.tiles.length).toBeLessThanOrEqual(40);
    expect(v?.z).toBeLessThan(7);
  });

  it('returns nothing outside the pyramid', () => {
    expect(pyramidView(index, { minX: 5000, maxX: 5100, minZ: 0, maxZ: 100 }, 0.1)).toBeNull();
  });
});
