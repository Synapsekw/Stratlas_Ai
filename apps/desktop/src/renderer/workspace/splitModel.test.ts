import { describe, expect, it } from 'vitest';
import {
  blockedFor,
  chooseAt,
  chooseCapture,
  chooseSide,
  compareSplit,
  DEFAULT_SPLIT,
  focusedSide,
  followsFocus,
  sideCapture,
  sidesOf,
  twiceAllowed,
  twinAllowed,
  levelFor,
  paneGroups,
  paneOptions,
  paneValue,
  parsePaneValue,
  parsePyramid,
  parseSplitPref,
  pyramidSize,
  resolveSplit,
  sideOf,
  splitWithPhoto,
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
    expect(paneOptions(alzour, 0)).toEqual(['3d', 'map', 'video', 'raster', 'pano']);
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

describe('two walks in the two 360 panes', () => {
  const walkSplit = { left: 'walk360', right: 'walk360' } as const;
  const options = paneOptions([{ kind: 'mesh' }], 0, 0, { walks: 2 });
  const dates = { captures: ['d1', 'd2'] };

  it('allows 360 video on both sides, which is not a date compare', () => {
    expect(twiceAllowed('walk360', undefined)).toBe(true);
    expect(twiceAllowed('walk360', dates)).toBe(true);
    expect(twinAllowed('walk360', dates)).toBe(false);
    expect(twiceAllowed('video', dates)).toBe(false);
    expect(twiceAllowed('3d', dates)).toBe(true);
  });

  it('keeps both 360 panes when resolving, choosing and reading the remembered split', () => {
    expect(resolveSplit(walkSplit, options)).toEqual(walkSplit);
    expect(chooseSide({ left: 'walk360', right: 'map' }, 'right', 'walk360')).toEqual(walkSplit);
    expect(blockedFor({ left: 'walk360', right: 'map' }, 'right')).toBeNull();
    expect(parseSplitPref(walkSplit)).toEqual(walkSplit);
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

describe('focusedSide', () => {
  const dates = { captures: ['jan', 'jun'] };

  it('is the last focused pane when it is drawn per date', () => {
    expect(focusedSide({ left: '3d', right: '3d' }, 'right', dates)).toBe('right');
    expect(focusedSide({ left: '3d', right: 'map' }, 'left', dates)).toBe('left');
  });

  it('falls back to the other side when the focused pane has no date', () => {
    expect(focusedSide({ left: '3d', right: 'video' }, 'right', dates)).toBe('left');
    expect(focusedSide({ left: 'report', right: 'pano' }, 'left', dates)).toBe('right');
  });

  it('is null with no pane drawn per date, or fewer than two dates', () => {
    expect(focusedSide({ left: 'video', right: 'report' }, 'left', dates)).toBeNull();
    expect(focusedSide({ left: '3d', right: 'map' }, 'left', { captures: ['jan'] })).toBeNull();
    expect(focusedSide({ left: '3d', right: 'map' }, 'left')).toBeNull();
  });
});

describe('the Panoramas pane and the picker grouped by date', () => {
  const dates = { captures: ['sep', 'oct', 'nov'] };
  const all = ['3d', 'map', 'video', 'raster', 'pano'] as const;
  const has = (k: string, c: string) =>
    k === 'raster' ? c === 'nov' : k === 'pano' && c !== 'sep';

  it('offers Panoramas only with a panoramas layer', () => {
    expect(paneOptions([{ kind: 'panoramas' }], 0)).toContain('pano');
    expect(paneOptions(hcl, 0)).not.toContain('pano');
  });

  it('shows Panoramas twice for two dates, first left and last right', () => {
    expect(twinAllowed('pano', { captures: ['a', 'b'] })).toBe(true);
    expect(twinAllowed('pano', { captures: ['a'] })).toBe(false);
    const r = resolveSplit({ left: 'pano', right: 'pano' }, ['3d', 'map', 'pano'], dates);
    expect([r.leftCapture, r.rightCapture]).toEqual(['sep', 'nov']);
  });

  it('reads and writes the saved pano pair', () => {
    const saved = {
      left: 'pano',
      right: 'pano',
      leftCapture: 'a',
      rightCapture: 'b',
      pano: 'L/p1',
    };
    expect(parseSplitPref(saved)).toEqual(saved);
    expect(parseSplitPref({ ...saved, pano: 42 })).toEqual({
      left: 'pano',
      right: 'pano',
      leftCapture: 'a',
      rightCapture: 'b',
    });
    expect(parseSplitPref({ left: 'pano', right: 'pano' })).toBeNull();
    expect(parseSplitPref({ left: 'zzz', right: 'map' })).toBeNull();
  });

  it('turns a choice into a picker value and back', () => {
    expect(paneValue('pano', 'nov')).toBe('pano@nov');
    expect(paneValue('video', null)).toBe('video');
    expect(parsePaneValue('pano@nov')).toEqual({ kind: 'pano', capture: 'nov' });
    expect(parsePaneValue('video')).toEqual({ kind: 'video', capture: null });
    expect(parsePaneValue('nope@x')).toBeNull();
  });

  it('groups the options by date, newest first, then the undated ones', () => {
    const g = paneGroups({ left: '3d', right: 'map' }, 'right', all, dates, has);
    expect(g.map((x) => x.capture)).toEqual(['nov', 'oct', 'sep', null]);
    const kinds = (c: string | null) => g.find((x) => x.capture === c)?.options.map((o) => o.kind);
    expect(kinds('nov')).toEqual(['3d', 'map', 'raster', 'pano']);
    expect(kinds('oct')).toEqual(['3d', 'map', 'pano']);
    expect(kinds('sep')).toEqual(['3d', 'map']);
    expect(kinds(null)).toEqual(['video']);
  });

  it('disables what the other side already shows', () => {
    const find = (g: ReturnType<typeof paneGroups>, v: string) =>
      g.flatMap((x) => x.options).find((o) => o.value === v)?.disabled;
    const a = paneGroups(
      { left: 'pano', right: 'map', leftCapture: 'oct' },
      'right',
      all,
      dates,
      has,
    );
    expect(find(a, 'pano@oct')).toBe(true);
    expect(find(a, 'pano@nov')).toBe(false);
    const b = paneGroups({ left: 'video', right: 'map' }, 'right', all, dates, has);
    expect(find(b, 'video')).toBe(true);
  });

  it('lists everything in one undated group without two dates', () => {
    const g = paneGroups({ left: '3d', right: 'map' }, 'right', all, { captures: ['a'] }, has);
    expect(g).toHaveLength(1);
    expect(g[0]?.capture).toBeNull();
    expect(g[0]?.options.map((o) => o.value)).toEqual([...all]);
  });

  it('chooses a pane and its date together', () => {
    const r = chooseAt({ left: '3d', right: 'map' }, 'right', 'pano', 'oct', dates);
    expect([r.right, r.rightCapture]).toEqual(['pano', 'oct']);
    const s = chooseAt(
      { left: 'pano', right: 'map', leftCapture: 'oct' },
      'right',
      'pano',
      'oct',
      dates,
    );
    expect([s.right, s.rightCapture, s.leftCapture]).toEqual(['pano', 'oct', 'nov']);
  });
});

describe('a clicked photo beside the view', () => {
  it('puts the map on the left and the photo on the right', () => {
    expect(splitWithPhoto({ left: '3d', right: 'map', raster: 'o' }, 'map')).toEqual({
      left: 'map',
      right: 'photo',
      raster: 'o',
    });
  });

  it('keeps the 3D view where it is and gives the photo the other side', () => {
    expect(splitWithPhoto({ left: '3d', right: 'map' }, '3d')).toEqual({
      left: '3d',
      right: 'photo',
    });
    expect(splitWithPhoto({ left: 'raster', right: '3d', raster: 'o' }, '3d')).toEqual({
      left: 'photo',
      right: '3d',
      raster: 'o',
    });
  });

  it('brings the 3D view back on the left when the split was not showing it', () => {
    expect(splitWithPhoto({ left: 'map', right: 'photo' }, '3d')).toEqual({
      left: '3d',
      right: 'photo',
    });
  });
});
