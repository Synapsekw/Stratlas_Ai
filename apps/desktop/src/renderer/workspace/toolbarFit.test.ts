import { describe, expect, it } from 'vitest';
import { createToolbarFit, fitGroups, type GroupId } from './toolbarFit';

const ALL: GroupId[] = ['view', 'measure', 'display', 'video', 'annotate'];
const widths = new Map<GroupId, number>([
  ['view', 96],
  ['measure', 96],
  ['display', 100],
  ['video', 160],
  ['annotate', 36],
]);
// view modes (172) and the right panel toggle (36), each with its gap
const FIXED = 172 + 8 + 36 + 8;

describe('stage toolbar fit', () => {
  it('keeps every group on one row when the stage is wide enough', () => {
    expect(fitGroups(ALL, widths, FIXED, 828)).toEqual([]);
  });

  it('moves the least used groups into the overflow menu first as the stage narrows', () => {
    expect(fitGroups(ALL, widths, FIXED, 700)).toEqual(['display']);
    expect(fitGroups(ALL, widths, FIXED, 520)).toEqual(['display', 'video']);
    expect(fitGroups(ALL, widths, FIXED, 488)).toEqual(['display', 'video', 'view']);
    expect(fitGroups(ALL, widths, FIXED, 300)).toEqual([
      'display',
      'video',
      'view',
      'measure',
      'annotate',
    ]);
  });

  it('counts the overflow button once and skips groups the mode does not show', () => {
    const map: GroupId[] = ['view', 'display', 'video', 'annotate'];
    expect(fitGroups(map, widths, FIXED, 660)).toEqual([]);
    expect(fitGroups(map, widths, FIXED, 600)).toEqual(['display']);
  });

  it('keeps the point cloud group on the bar until only annotate is left', () => {
    const all: GroupId[] = ['view', 'measure', 'display', 'clouds', 'video', 'annotate'];
    const w = new Map(widths).set('clouds', 36);
    const hidden = fitGroups(all, w, FIXED, 380);
    expect(hidden).toEqual(['display', 'video', 'view', 'measure']);
    expect(fitGroups(all, w, FIXED, 200)).toEqual([
      'display',
      'video',
      'view',
      'measure',
      'clouds',
      'annotate',
    ]);
  });
});

describe('stage toolbar fit across the views', () => {
  // the smallest window (1100 x 700): the bar is 463 px wide. The same groups hold more tools on
  // the 3D view than on the map, and the 3D view has the environment tool beside the panel toggle.
  const BAR = 463;
  const W3D = new Map<GroupId, number>([
    ['view', 124],
    ['measure', 94],
    ['display', 94],
    ['video', 154],
    ['annotate', 34],
  ]);
  const WMAP = new Map<GroupId, number>([
    ['view', 64],
    ['measure', 34],
    ['display', 34],
    ['video', 64],
    ['annotate', 34],
  ]);
  const FIXED_3D = 94 + 8 + 34 + 8 + 34 + 8;
  const FIXED_MAP = 94 + 8 + 34 + 8;
  /** What the bar can measure: only the groups that are on it. */
  const onBar = (widths: ReadonlyMap<GroupId, number>, hidden: readonly GroupId[]) =>
    new Map([...widths].filter(([g]) => !hidden.includes(g)));

  it('fits the map by the widths its groups have on the map, after the 3D view folded them', () => {
    const bar = createToolbarFit();
    const folded = bar.fit('3d', ALL, W3D, FIXED_3D, BAR);
    expect(folded).toEqual(['display', 'video', 'view']);

    // the widths of the folded groups as the 3D view measured them would keep two folded
    const stale = new Map([...W3D, ...onBar(WMAP, folded)]);
    expect(fitGroups(ALL, stale, FIXED_MAP, BAR)).toEqual(['display', 'video']);

    // the map: what the 3D view folded has no width here yet, so everything goes on the bar
    expect(bar.fit('map', ALL, onBar(WMAP, folded), FIXED_MAP, BAR)).toEqual([]);
    // and measured there, it all fits
    expect(bar.fit('map', ALL, WMAP, FIXED_MAP, BAR)).toEqual([]);
  });

  it('measures every group of a view before it folds any, then remembers the folded ones', () => {
    const bar = createToolbarFit();
    expect(bar.fit('map', ALL, WMAP, FIXED_MAP, BAR)).toEqual([]);
    // to the 3D view with nothing folded: every group is on the bar and measured
    const folded = bar.fit('3d', ALL, W3D, FIXED_3D, BAR);
    expect(folded).toEqual(['display', 'video', 'view']);
    // later fits (a resize) see only the groups left on the bar and keep the others' widths
    expect(bar.fit('3d', ALL, onBar(W3D, folded), FIXED_3D, BAR)).toEqual(folded);
    expect(bar.fit('3d', ALL, onBar(W3D, folded), FIXED_3D, 640)).toEqual(['display', 'video']);
    expect(bar.fit('3d', ALL, onBar(W3D, ['display', 'video']), FIXED_3D, 800)).toEqual([]);
  });

  it('counts only the groups of the view that is showing', () => {
    const bar = createToolbarFit();
    // a project with point clouds: the 3D view has a group the map does not
    const with3d: GroupId[] = ['view', 'measure', 'display', 'clouds', 'video', 'annotate'];
    const w3d = new Map(W3D).set('clouds', 34);
    expect(bar.fit('3d', with3d, w3d, FIXED_3D, 800)).toEqual([]);
    // 414 is the map's five groups to the pixel: the point cloud group's 42 px would fold one
    expect(bar.fit('map', ALL, new Map(WMAP).set('clouds', 34), FIXED_MAP, 414)).toEqual([]);
  });

  it('measures again when the set of groups changes within a view', () => {
    const bar = createToolbarFit();
    const folded = bar.fit('3d', ALL, W3D, FIXED_3D, BAR);
    expect(folded).toEqual(['display', 'video', 'view']);
    // a point cloud arrives: the folded groups come back to be measured with the new one
    const next: GroupId[] = ['view', 'measure', 'display', 'clouds', 'video', 'annotate'];
    const w = new Map(W3D).set('clouds', 34);
    expect(bar.fit('3d', next, onBar(w, folded), FIXED_3D, BAR)).toEqual([]);
    expect(bar.fit('3d', next, w, FIXED_3D, BAR)).toEqual(['display', 'video', 'view']);
  });
});
