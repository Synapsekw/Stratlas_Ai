import { describe, expect, it } from 'vitest';
import {
  blockedFor,
  chooseCapture,
  chooseSide,
  compareSplit,
  DEFAULT_SPLIT,
  followsFocus,
  sideCapture,
  sidesOf,
  twinAllowed,
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

describe('comparing two survey dates in the split', () => {
  const dates = { captures: ['d1', 'd2', 'd3'] };
  const masafi = [{ kind: 'mesh' }, { kind: 'raster' }] as const;
  const options = paneOptions(masafi, 0);

  it('puts the 3D view at most once per date: twice for two dates, never twice for one', () => {
    expect(twinAllowed('3d', dates)).toBe(true);
    expect(twinAllowed('map', dates)).toBe(true);
    expect(twinAllowed('raster', dates)).toBe(true);
    expect(twinAllowed('video', dates)).toBe(false);
    expect(twinAllowed('3d', { captures: ['d1'] })).toBe(false);
    expect(twinAllowed('3d', undefined)).toBe(false);
    // the Low graphics tier runs one 3D view
    expect(twinAllowed('3d', { ...dates, twin3d: false })).toBe(false);
    expect(twinAllowed('map', { ...dates, twin3d: false })).toBe(true);
  });

  it('opens compare with the first date on the left and the last on the right', () => {
    const s = compareSplit(DEFAULT_SPLIT, '3d', dates);
    expect(s).toEqual({ left: '3d', right: '3d', leftCapture: 'd1', rightCapture: 'd3' });
    expect(resolveSplit(s, options, dates)).toEqual(s);
    expect(sidesOf(s, '3d')).toEqual(['left', 'right']);
    expect(blockedFor(s, 'left', dates)).toBeNull();
  });

  it('defaults both dates when none is remembered, never the same date twice', () => {
    expect(resolveSplit({ left: 'map', right: 'map' }, options, dates)).toMatchObject({
      leftCapture: 'd1',
      rightCapture: 'd3',
    });
    expect(
      resolveSplit(
        { left: '3d', right: '3d', leftCapture: 'd2', rightCapture: 'd2' },
        options,
        dates,
      ),
    ).toMatchObject({ leftCapture: 'd2', rightCapture: 'd1' });
    // a split of two different panes shows the latest survey on both
    expect(resolveSplit(undefined, options, dates)).toMatchObject({
      left: '3d',
      right: 'map',
      leftCapture: 'd3',
      rightCapture: 'd3',
    });
    // a date the project no longer has falls back
    expect(
      resolveSplit(
        { left: '3d', right: '3d', leftCapture: 'gone', rightCapture: 'd2' },
        options,
        dates,
      ),
    ).toMatchObject({ leftCapture: 'd1', rightCapture: 'd2' });
  });

  it('turns two 3D views back into 3D and map without a second date or on the Low tier', () => {
    const s = compareSplit(DEFAULT_SPLIT, '3d', dates);
    expect(resolveSplit(s, options)).toMatchObject({ left: '3d', right: 'map' });
    expect(resolveSplit(s, options, { ...dates, twin3d: false })).toMatchObject({
      left: '3d',
      right: 'map',
    });
    expect(blockedFor(s, 'left', { ...dates, twin3d: false })).toBe('3d');
  });

  it('picks a free date when a side takes the pane the other shows', () => {
    const s = { left: '3d' as const, right: 'map' as const, leftCapture: 'd3', rightCapture: 'd3' };
    expect(chooseSide(s, 'right', '3d', dates)).toMatchObject({
      left: '3d',
      right: '3d',
      leftCapture: 'd3',
      rightCapture: 'd1',
    });
    expect(chooseSide(s, 'right', '3d')).toBe(s);
  });

  it('swaps the dates when a side picks the date the other shows', () => {
    const s = compareSplit(DEFAULT_SPLIT, 'map', dates);
    expect(chooseCapture(s, 'left', 'd3', dates)).toMatchObject({
      leftCapture: 'd3',
      rightCapture: 'd1',
    });
    expect(chooseCapture(s, 'left', 'd2', dates)).toMatchObject({
      leftCapture: 'd2',
      rightCapture: 'd3',
    });
    expect(sideCapture({ left: '3d', right: 'map' }, 'left', dates)).toBe('d3');
    expect(sideCapture({ left: '3d', right: 'map' }, 'left', undefined)).toBeUndefined();
  });

  it('remembers two dates, and the link, but not the same pane twice on one date', () => {
    expect(
      parseSplitPref({
        left: '3d',
        right: '3d',
        leftCapture: 'd1',
        rightCapture: 'd3',
        unlinked: true,
      }),
    ).toEqual({ left: '3d', right: '3d', leftCapture: 'd1', rightCapture: 'd3', unlinked: true });
    expect(
      parseSplitPref({ left: '3d', right: '3d', leftCapture: 'd1', rightCapture: 'd1' }),
    ).toBeNull();
    expect(
      parseSplitPref({ left: 'video', right: 'video', leftCapture: 'd1', rightCapture: 'd2' }),
    ).toBeNull();
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

describe('followsFocus', () => {
  const at = (focus: string | null, splitting: boolean, projectId: string | null = 'p') => ({
    projectId,
    focus,
    splitting,
  });

  it('keeps the split defaults when the split opens on the focused date', () => {
    expect(followsFocus(at('nov', false), at('nov', true))).toBe(false);
  });

  it('follows a date bar change while the split stays open', () => {
    expect(followsFocus(at('nov', true), at('oct', true))).toBe(true);
  });

  it('ignores changes with the split closed, or closing it', () => {
    expect(followsFocus(at('nov', false), at('oct', false))).toBe(false);
    expect(followsFocus(at('nov', true), at('oct', false))).toBe(false);
    expect(followsFocus(at('nov', true), at('nov', true))).toBe(false);
  });

  it('ignores the first focus of a project and a switch to another project', () => {
    expect(followsFocus(at(null, true), at('nov', true))).toBe(false);
    expect(followsFocus(at('nov', true), at(null, true))).toBe(false);
    expect(followsFocus(at('nov', true, 'p'), at('oct', true, 'q'))).toBe(false);
  });
});
