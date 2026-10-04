import { describe, expect, it } from 'vitest';
import { parseDirectory, serializeDirectory, tileIdToZxy, zxyToTileId } from './format';

describe('tile ids', () => {
  it('follow the PMTiles v3 Hilbert order', () => {
    expect(zxyToTileId(0, 0, 0)).toBe(0);
    expect(zxyToTileId(1, 0, 0)).toBe(1);
    expect(zxyToTileId(1, 0, 1)).toBe(2);
    expect(zxyToTileId(1, 1, 1)).toBe(3);
    expect(zxyToTileId(1, 1, 0)).toBe(4);
    expect(zxyToTileId(2, 0, 0)).toBe(5);
    expect(zxyToTileId(3, 7, 0)).toBe(84);
    expect(zxyToTileId(20, 0, 0)).toBe(366503875925);
  });

  it('round-trip through z/x/y up to zoom 26', () => {
    for (const [z, x, y] of [
      [5, 17, 9],
      [12, 2683, 1700],
      [15, 21437, 13615],
      [26, 2 ** 26 - 1, 12345],
    ] as const) {
      expect(tileIdToZxy(zxyToTileId(z, x, y))).toEqual([z, x, y]);
    }
  });
});

describe('directories', () => {
  it('serialise and parse entries, with contiguous offsets packed as zero', () => {
    const entries = [
      { tileId: 0, offset: 0, length: 10, runLength: 1 },
      { tileId: 1, offset: 10, length: 5, runLength: 3 },
      { tileId: 9, offset: 2, length: 7, runLength: 1 },
      { tileId: 2 ** 40, offset: 2 ** 33, length: 1, runLength: 0 },
    ];
    expect(parseDirectory(serializeDirectory(entries))).toEqual(entries);
  });
});
