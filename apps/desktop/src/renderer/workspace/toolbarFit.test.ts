import { describe, expect, it } from 'vitest';
import { fitGroups, type GroupId } from './toolbarFit';

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
