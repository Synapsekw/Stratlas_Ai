import type { HeightTiles } from '@aio/schema';
import { encodeTile, TILE } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import type { FetchTile } from './card/pointHistory';
import { heightAt } from './card/pointHistory';
import { createMapHeights, fallbackZ } from './mapHeights';

/** A plane on one 256 x 256 tile of 1 m cells (posts at cell centres). */
const plane = (e: number, n: number) => 40 + 0.5 * e + 0.25 * n;

function tiles(id: string): HeightTiles {
  return {
    schema: 'aio.height-tiles/1',
    id,
    name: id,
    source: { kind: 'dsm', layer: 'dsm' },
    capture: 'a',
    crs: { epsg: 32640 },
    cellM: 1,
    tileSize: 256,
    originE: 1000,
    originN: 2000,
    cols: 1,
    rows: 1,
    levels: 1,
    bounds: [1000, 2000, 0, 1256, 2256, 300],
    tiles: ['0_0'],
    fingerprint: id,
    preparedAt: '2026-10-20T00:00:00Z',
  };
}

async function planeTile(hole: (e: number) => boolean = () => false): Promise<FetchTile> {
  const heights = new Float64Array(TILE * TILE);
  for (let j = 0; j < TILE; j++)
    for (let i = 0; i < TILE; i++) {
      const e = 1000 + i + 0.5;
      const n = 2000 + j + 0.5;
      heights[j * TILE + i] = hole(e) ? NaN : plane(e, n);
    }
  const bytes = await encodeTile(heights);
  return (col, row) => Promise.resolve(col === 0 && row === 0 ? bytes : null);
}

describe('fallbackZ', () => {
  it('fallbackZ prefers the surface, then the previous vertex, then the origin height', () => {
    expect(fallbackZ(12.5, [0, 0, 30], 51)).toBe(12.5);
    expect(fallbackZ(null, [0, 0, 30], 51)).toBe(30);
    expect(fallbackZ(null, null, 51)).toBe(51);
    // a non-finite surface height is no height
    expect(fallbackZ(Number.NaN, null, 51)).toBe(51);
  });
});

describe('createMapHeights', () => {
  it('at returns null before warm and the bilinear height after', async () => {
    const fetch = await planeTile();
    const h = createMapHeights('p', () => fetch);
    expect(h.at(1100.3, 2050.7)).toBeNull();
    await h.warm(tiles('s'));
    const z = h.at(1100.3, 2050.7);
    expect(z).toBeCloseTo(plane(1100.3, 2050.7), 6);
    // the same height the card's engine sampler reads
    expect(z).toBeCloseTo((await heightAt(tiles('s'), 1100.3, 2050.7, fetch)) ?? NaN, 9);
    // outside the surface, or where it has no data: null, never 0
    expect(h.at(5000, 2050)).toBeNull();
  });

  it('is null in a hole and forgets the surface on warm(null)', async () => {
    const fetch = await planeTile((e) => e > 1120);
    const h = createMapHeights('p', () => fetch);
    await h.warm(tiles('s'));
    expect(h.at(1130, 2050)).toBeNull();
    expect(h.at(1110, 2050)).toBeCloseTo(plane(1110, 2050), 6);
    await h.warm(null);
    expect(h.at(1110, 2050)).toBeNull();
  });

  it('warm around a view loads only the tiles it touches', async () => {
    const asked: string[] = [];
    const fetch = await planeTile();
    const h = createMapHeights('p', () => (c, r) => {
      asked.push(`${String(c)}_${String(r)}`);
      return fetch(c, r);
    });
    await h.warm(tiles('s'), { minE: 5000, minN: 5000, maxE: 5100, maxN: 5100 });
    expect(asked).toEqual([]);
    await h.warm(tiles('s'), { minE: 1050, minN: 2050, maxE: 1100, maxN: 2100 });
    expect(asked).toEqual(['0_0']);
    expect(h.at(1060, 2060)).toBeCloseTo(plane(1060, 2060), 6);
  });
});
