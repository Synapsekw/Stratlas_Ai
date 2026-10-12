import type { Layer } from '@aio/schema';
import type { CaptureIndex } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPARE_WITH_ACTIONS,
  compareKindFor,
  compareTargets,
  planCompare,
  type CompareContext,
} from './compareWith';
import { splitWithFrames } from './framesModel';

// the shell reads window.aio at import; these tests never call the store-reading wrapper
vi.mock('../shell', () => ({ shell: { getState: () => ({}) } }));

const L = (kind: string, id: string, extra: object = {}) =>
  ({ kind, id, name: id, ...extra }) as unknown as Layer;
const pano = (id: string) => ({
  id,
  src: { path: `p/${id}.jpg` },
  pos: [0, 0, 0],
  headingDeg: 0,
});
const layers: Layer[] = [
  L('vector', 'vec-sep'),
  L('vector', 'vec-oct'),
  L('vector', 'vec-nov'),
  L('mesh', 'mesh-oct'),
  L('mesh', 'mesh-nov'),
  L('raster', 'ortho-oct'),
  L('raster', 'ortho-nov'),
  L('panoramas', 'pano-oct', { items: [pano('a')] }),
  L('panoramas', 'pano-nov', { items: [pano('b'), pano('c')] }),
  L('video', 'clip-nov'),
  L('photos', 'photos-oct', {
    items: [{ id: 'x' }, { id: 'y', pos: [0, 0, 0], q: [0, 0, 0, 1] }],
  }),
];
const index = {
  captures: [{ id: 'sep' }, { id: 'oct' }, { id: 'nov' }],
  layers: {
    sep: ['vec-sep'],
    oct: ['vec-oct', 'mesh-oct', 'ortho-oct', 'pano-oct', 'photos-oct'],
    nov: ['vec-nov', 'mesh-nov', 'ortho-nov', 'pano-nov', 'clip-nov'],
  },
  of: Object.fromEntries(
    ['sep', 'oct', 'nov'].flatMap((c) =>
      layers.filter((l) => l.id.endsWith(`-${c}`)).map((l) => [l.id, c]),
    ),
  ),
  epochs: {},
  slot: {},
} as unknown as CaptureIndex;
const ctx = (over: Partial<CompareContext> = {}): CompareContext => ({
  layers,
  index,
  stageMode: '3d',
  split: { left: '3d', right: 'map' },
  tier: 'high',
  ...over,
});

describe('compareKindFor', () => {
  it('maps layer kinds to the pane that compares them', () => {
    expect(compareKindFor(L('mesh', 'a'))).toBe('3d');
    expect(compareKindFor(L('pointcloud', 'a'))).toBe('3d');
    expect(compareKindFor(L('raster', 'a'))).toBe('raster');
    expect(compareKindFor(L('panoramas', 'a'))).toBe('pano');
    expect(compareKindFor(L('vector', 'a'))).toBe('map');
    expect(compareKindFor(L('video', 'a'))).toBe('frames');
    expect(compareKindFor(L('photos', 'a'))).toBe('frames');
    expect(compareKindFor(L('legacy', 'a'))).toBeNull();
    expect(compareKindFor(L('basemap', 'a'))).toBeNull();
  });
});

describe('planCompare for a date', () => {
  it('compares two 3D views on the 3D stage', () => {
    const p = planCompare({ from: 'nov', to: 'oct' }, ctx());
    expect(p?.split).toMatchObject({
      left: '3d',
      right: '3d',
      leftCapture: 'nov',
      rightCapture: 'oct',
    });
    expect(p?.notice).toBeUndefined();
  });
  it('compares two maps on the map stage', () => {
    const p = planCompare({ from: 'nov', to: 'oct' }, ctx({ stageMode: 'map' }));
    expect(p?.split).toMatchObject({ left: 'map', right: 'map' });
  });
  it('keeps the left kind of a per-date split', () => {
    const p = planCompare(
      { from: 'nov', to: 'oct' },
      ctx({ stageMode: 'split', split: { left: 'raster', right: 'map' } }),
    );
    expect(p?.split).toMatchObject({ left: 'raster', right: 'raster' });
  });
  it('falls back to two maps with a notice on the low tier', () => {
    const p = planCompare({ from: 'nov', to: 'oct' }, ctx({ tier: 'low' }));
    expect(p?.split).toMatchObject({ left: 'map', right: 'map' });
    expect(p?.notice).toBe('lowTierMaps');
  });
  it('gives null for the same or an unknown date', () => {
    expect(planCompare({ from: 'nov', to: 'nov' }, ctx())).toBeNull();
    expect(planCompare({ from: 'nov', to: 'jan' }, ctx())).toBeNull();
    expect(planCompare({ from: 'jan', to: 'nov' }, ctx())).toBeNull();
  });
});

describe('planCompare for layers', () => {
  it('compares panoramas, starting at the first of the layer', () => {
    const p = planCompare({ from: 'nov', to: 'oct', layers: ['pano-nov'] }, ctx());
    expect(p?.split).toMatchObject({
      left: 'pano',
      right: 'pano',
      leftCapture: 'nov',
      rightCapture: 'oct',
      pano: 'pano-nov/b',
    });
  });
  it('keeps the saved panorama when it is in the layer', () => {
    const p = planCompare(
      { from: 'nov', to: 'oct', layers: ['pano-nov'] },
      ctx({ split: { left: '3d', right: 'map', pano: 'pano-nov/c' } }),
    );
    expect(p?.split.pano).toBe('pano-nov/c');
  });
  it('compares an ortho raster', () => {
    const p = planCompare({ from: 'nov', to: 'oct', layers: ['ortho-nov'] }, ctx());
    expect(p?.split).toMatchObject({ left: 'raster', right: 'raster', raster: 'ortho-nov' });
  });
  it('compares a video through the Frames pane', () => {
    const p = planCompare({ from: 'nov', to: 'oct', layers: ['clip-nov'] }, ctx());
    expect(p?.frames).toEqual({ source: { kind: 'video', layer: 'clip-nov' }, other: 'oct' });
    expect(p?.split).toEqual(splitWithFrames(ctx().split));
  });
  it('compares photos from the first posed photo', () => {
    const p = planCompare({ from: 'oct', to: 'nov', layers: ['photos-oct'] }, ctx());
    expect(p?.frames?.source).toEqual({ kind: 'photo', layer: 'photos-oct', photo: 'y' });
  });
  it('takes the first comparable layer of a mixed group', () => {
    const p = planCompare({ from: 'nov', to: 'oct', layers: ['vec-nov', 'ortho-nov'] }, ctx());
    expect(p?.split).toMatchObject({ left: 'map', right: 'map' });
  });
  it('gives null when the other date lacks that kind', () => {
    expect(planCompare({ from: 'nov', to: 'sep', layers: ['pano-nov'] }, ctx())).toBeNull();
  });
});

describe('compareTargets', () => {
  it('disables dates without panoramas, newest first', () => {
    expect(compareTargets('nov', ['pano-nov'], ctx())).toEqual([
      { capture: 'oct', reason: null },
      { capture: 'sep', reason: 'compare.with.noPanoramas' },
    ]);
  });
  it('lists every other date for a date folder', () => {
    expect(compareTargets('oct', undefined, ctx())).toEqual([
      { capture: 'nov', reason: null },
      { capture: 'sep', reason: null },
    ]);
  });
  it('names the missing ortho and media', () => {
    expect(compareTargets('nov', ['ortho-nov'], ctx())[1]?.reason).toBe('compare.with.noRaster');
    expect(compareTargets('nov', ['clip-nov'], ctx())[1]?.reason).toBe('compare.with.noMedia');
  });
  it('disables every date for a photos layer without a posed photo', () => {
    const unposed = L('photos', 'photos-sep', { items: [{ id: 'z' }] });
    const c = ctx({ layers: [...layers, unposed] });
    const all = compareTargets('oct', ['photos-sep'], c);
    expect(all).toHaveLength(2);
    expect(all.every((x) => x.reason === 'compare.with.noPosedPhoto')).toBe(true);
  });
  it('disables every date for layers that cannot compare', () => {
    const c = ctx({ layers: [...layers, L('legacy', 'old')] });
    const all = compareTargets('nov', ['old'], c);
    expect(all).toHaveLength(2);
    expect(all.every((x) => x.reason === 'compare.with.nothing')).toBe(true);
  });
});

describe('COMPARE_WITH_ACTIONS', () => {
  it('starts empty and takes components', () => {
    expect(COMPARE_WITH_ACTIONS).toEqual([]);
    COMPARE_WITH_ACTIONS.push(() => null);
    expect(COMPARE_WITH_ACTIONS).toHaveLength(1);
    COMPARE_WITH_ACTIONS.pop();
  });
});
