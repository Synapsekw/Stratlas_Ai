import { describe, expect, it } from 'vitest';
import {
  ABOVE_RASTERS,
  RASTERS_TOP,
  loadsWithProject,
  rasterBefore,
  rasterOpacity,
} from './rasterDisplay';

describe('raster opacity on the map', () => {
  it('keeps the old values until a choice is made', () => {
    expect(rasterOpacity('plan')).toBe(0.75);
    expect(rasterOpacity('plan', {})).toBe(0.75);
    expect(rasterOpacity('ortho')).toBe(0.95);
    expect(rasterOpacity('dsm', undefined, true)).toBe(1);
    expect(rasterOpacity('plan', undefined, true)).toBe(1);
  });

  it('a drawing takes the chosen opacity, coarse and fine tiles alike', () => {
    expect(rasterOpacity('plan', { opacity: 0.3 })).toBe(0.3);
    expect(rasterOpacity('plan', { opacity: 0.3 }, true)).toBe(0.3);
    expect(rasterOpacity('plan', { opacity: 0 })).toBe(0);
  });

  it('an ortho ignores it', () => {
    expect(rasterOpacity('ortho', { opacity: 0.3 })).toBe(0.95);
  });
});

describe('which rasters the map fetches when a project opens', () => {
  it('leaves a hidden drawing until it is shown', () => {
    expect(loadsWithProject({ role: 'plan', format: 'image' }, true)).toBe(false);
    expect(loadsWithProject({ role: 'plan', format: 'image' }, false)).toBe(true);
  });

  it('loads orthos and tiled plans as before, hidden or not', () => {
    expect(loadsWithProject({ role: 'ortho', format: 'image' }, true)).toBe(true);
    expect(loadsWithProject({ role: 'dsm', format: 'image' }, true)).toBe(true);
    expect(loadsWithProject({ role: 'plan', format: 'kit-pyramid' }, true)).toBe(true);
  });
});

describe('where a raster goes in the map layers', () => {
  /** Insert ids the way the map does: before the named layer. */
  const stack = (adds: readonly { id: string; role: 'ortho' | 'dsm' | 'plan' }[]) => {
    const layers = [RASTERS_TOP, ABOVE_RASTERS];
    for (const a of adds) layers.splice(layers.indexOf(rasterBefore(a.role)), 0, a.id);
    return layers;
  };

  it('a drawing lies over every ortho tile, whichever was added first', () => {
    // visible at open, then the ortho's finer tiles arrive after a zoom
    expect(
      stack([
        { id: 'ortho', role: 'ortho' },
        { id: 'sheet', role: 'plan' },
        { id: 'ortho-fine', role: 'ortho' },
      ]),
    ).toEqual(['ortho', 'ortho-fine', RASTERS_TOP, 'sheet', ABOVE_RASTERS]);
    // shown later (its picture is fetched on first show): the same place
    expect(
      stack([
        { id: 'ortho', role: 'ortho' },
        { id: 'ortho-fine', role: 'ortho' },
        { id: 'sheet', role: 'plan' },
      ]),
    ).toEqual(['ortho', 'ortho-fine', RASTERS_TOP, 'sheet', ABOVE_RASTERS]);
  });

  it('a DSM stays with the orthos', () => {
    expect(rasterBefore('dsm')).toBe(RASTERS_TOP);
  });
});
