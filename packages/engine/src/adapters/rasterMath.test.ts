import { describe, expect, it } from 'vitest';
import {
  parseTileIndex,
  planTiles,
  quadPositions,
  tileCorners,
  type TileIndex,
} from './rasterMath';

const corners = {
  tl: [0, 0.3, -100] as [number, number, number],
  tr: [200, 0.3, -100] as [number, number, number],
  bl: [0, 0.3, 0] as [number, number, number],
};

describe('quadPositions', () => {
  it('derives the fourth corner and orders tl, tr, br, bl', () => {
    const p = quadPositions(corners);
    const want = [0, 0.3, -100, 200, 0.3, -100, 200, 0.3, 0, 0, 0.3, 0];
    want.forEach((v, i) => {
      expect(p[i]).toBeCloseTo(v, 5);
    });
  });

  it('handles a rotated placement (Al-Zour ortho, 18 degrees)', () => {
    const p = quadPositions({
      tl: [-1030.75, 0.3, -212.79],
      tr: [1044.35, 0.3, -886.99],
      bl: [-627.25, 0.3, 1029.13],
    });
    // published bottom-right corner from ortho.json
    expect(p[6]).toBeCloseTo(1447.85, 1);
    expect(p[8]).toBeCloseTo(354.92, 1);
  });
});

const index: TileIndex = {
  levels: [
    { z: 0, tileSize: 512, cols: 2, rows: 1, pattern: 'rasters/ortho/{z}/{x}_{y}.webp' },
    { z: 1, tileSize: 512, cols: 8, rows: 4, pattern: 'rasters/ortho/{z}/{x}_{y}.webp' },
  ],
  corners,
};

describe('parseTileIndex', () => {
  it('accepts aio.tiles/1 and sorts levels coarse to fine', () => {
    const raw = { schema: 'aio.tiles/1', levels: [...index.levels].reverse(), corners };
    expect(parseTileIndex(raw).levels.map((l) => l.z)).toEqual([0, 1]);
  });

  it('rejects anything else', () => {
    expect(() => parseTileIndex({ schema: 'x' })).toThrow('aio.tiles/1');
  });
});

describe('tileCorners', () => {
  it('splits the placement bilinearly', () => {
    const c = tileCorners(corners, 8, 4, 1, 2);
    expect(c.tl).toEqual([25, 0.3, -50]);
    expect(c.tr).toEqual([50, 0.3, -50]);
    expect(c.bl).toEqual([25, 0.3, -25]);
  });
});

describe('planTiles', () => {
  it('always keeps the coarse level and loads no fine tiles from far away', () => {
    const plan = planTiles(index, [100, 0, -50], 5000, new Set());
    expect(plan.load).toEqual(['0/0/0', '0/1/0']);
    expect(plan.drop).toEqual([]);
  });

  it('streams the nearest fine tiles around the target when close', () => {
    const plan = planTiles(index, [10, 0, -90], 40, new Set(['0/0/0', '0/1/0']));
    expect(plan.load[0]).toBe('1/0/0');
    expect(plan.load.length).toBeGreaterThan(0);
    expect(plan.load.length).toBeLessThanOrEqual(9);
    expect(plan.load.every((k) => k.startsWith('1/'))).toBe(true);
  });

  it('drops fine tiles that are far from the view', () => {
    const plan = planTiles(index, [10, 0, -90], 40, new Set(['0/0/0', '0/1/0', '1/7/3']));
    expect(plan.drop).toContain('1/7/3');
  });

  it('drops all fine tiles when zoomed out', () => {
    const plan = planTiles(index, [10, 0, -90], 5000, new Set(['0/0/0', '1/0/0']));
    expect(plan.drop).toEqual(['1/0/0']);
  });
});
