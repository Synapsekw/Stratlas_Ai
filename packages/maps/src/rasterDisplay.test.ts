import { describe, expect, it } from 'vitest';
import { loadsWithProject, rasterOpacity } from './rasterDisplay';

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
