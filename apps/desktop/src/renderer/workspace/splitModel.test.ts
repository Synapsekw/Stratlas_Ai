import { describe, expect, it } from 'vitest';
import {
  chooseSide,
  DEFAULT_SPLIT,
  levelFor,
  paneOptions,
  parsePyramid,
  parseSplitPref,
  pyramidSize,
  resolveSplit,
  sideOf,
  takenBy,
  tilePath,
  visibleTiles,
} from './splitModel';

const hcl = [
  { kind: 'mesh' },
  { kind: 'pointcloud' },
  { kind: 'video' },
  { kind: 'photos' },
] as const;
const alzour = [
  { kind: 'mesh' },
  { kind: 'raster' },
  { kind: 'video' },
  { kind: 'panoramas' },
] as const;

describe('what each side of the split shows', () => {
  it('offers only the panes the project has data for', () => {
    expect(paneOptions(hcl, 1)).toEqual(['3d', 'map', 'video', 'photo', 'report']);
    expect(paneOptions(alzour, 0)).toEqual(['3d', 'map', 'video', 'raster']);
    expect(paneOptions([], 0)).toEqual(['3d', 'map']);
  });

  it('defaults to the 3D view on the left and the map on the right', () => {
    expect(resolveSplit(undefined, paneOptions(hcl, 1))).toEqual(DEFAULT_SPLIT);
  });

  it('keeps a remembered choice, falling back where the project no longer has the data', () => {
    const options = paneOptions(alzour, 0);
    expect(resolveSplit({ left: 'raster', right: 'video' }, options)).toMatchObject({
      left: 'raster',
      right: 'video',
    });
    // no reports here: the right side goes back to the map
    expect(resolveSplit({ left: 'video', right: 'report' }, options)).toMatchObject({
      left: 'video',
      right: 'map',
    });
    // a fallback that clashes with the left takes the next pane
    expect(resolveSplit({ left: 'map', right: 'report' }, options)).toMatchObject({
      left: 'map',
      right: '3d',
    });
  });

  it('never puts one pane on both sides (one 3D stage, one video player)', () => {
    const s = { left: '3d' as const, right: 'map' as const };
    expect(takenBy(s, 'left')).toBe('map');
    expect(takenBy(s, 'right')).toBe('3d');
    expect(chooseSide(s, 'right', '3d')).toBe(s);
    expect(chooseSide(s, 'right', 'video')).toEqual({ left: '3d', right: 'video' });
    expect(chooseSide(s, 'left', 'photo')).toEqual({ left: 'photo', right: 'map' });
    expect(sideOf(s, 'map')).toBe('right');
    expect(sideOf(s, 'video')).toBeUndefined();
    expect(parseSplitPref({ left: '3d', right: '3d' })).toBeNull();
  });

  it('reads back only well-formed choices', () => {
    expect(parseSplitPref({ left: 'video', right: 'report', report: 'report/a.pdf' })).toEqual({
      left: 'video',
      right: 'report',
      report: 'report/a.pdf',
    });
    expect(parseSplitPref({ left: 'video', right: 'tv' })).toBeNull();
    expect(parseSplitPref('3d')).toBeNull();
  });
});

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing');
  return v;
}

describe('the raster pane', () => {
  const levels = must(
    parsePyramid({
      levels: [
        { z: 2, tileSize: 2048, cols: 16, rows: 8, pattern: 'rasters/o/{z}/{x}_{y}.webp' },
        { z: 0, tileSize: 2048, cols: 4, rows: 2, pattern: 'rasters/o/{z}/{x}_{y}.webp' },
        { z: 9, tileSize: 0, cols: 1, rows: 1, pattern: 'bad' },
      ],
    }),
  );

  it('reads a tile index coarse to fine, dropping broken levels', () => {
    expect(levels.map((l) => l.z)).toEqual([0, 2]);
    expect(pyramidSize(levels)).toEqual({ width: 32768, height: 16384 });
    expect(parsePyramid({ levels: [] })).toBeNull();
    expect(parsePyramid(null)).toBeNull();
  });

  it('loads the coarsest level that is sharp at the zoom', () => {
    expect(levelFor(levels, 0.05)?.z).toBe(0);
    expect(levelFor(levels, 0.25)?.z).toBe(0);
    expect(levelFor(levels, 0.3)?.z).toBe(2);
    expect(levelFor(levels, 4)?.z).toBe(2);
  });

  it('loads only the tiles in view', () => {
    const fine = must(levels[1]);
    const size = pyramidSize(levels);
    expect(visibleTiles(fine, size, { x: 0, y: 0, width: 3000, height: 1000 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    // the view past the image edge clamps to the last tile
    expect(visibleTiles(fine, size, { x: 32000, y: 16000, width: 5000, height: 5000 })).toEqual([
      { x: 15, y: 7 },
    ]);
    const coarse = must(levels[0]);
    expect(visibleTiles(coarse, size, { x: -100, y: -100, width: 1e6, height: 1e6 })).toHaveLength(
      8,
    );
    expect(tilePath(coarse, 3, 1)).toBe('rasters/o/0/3_1.webp');
  });
});
