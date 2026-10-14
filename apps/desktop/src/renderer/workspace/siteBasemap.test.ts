import type { Layer, ProjectManifest } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boxPoints,
  landscapeOn,
  settledBox,
  siteBasemap,
  siteBasemapOn,
  streetMapExtent,
  streetMapRings,
  streetMapTool,
  wantsSiteBasemap,
  type StreetMap3d,
} from './siteBasemap';

const video = {
  kind: 'video',
  id: 'clip-1',
  name: 'Clip 1',
  visible: true,
  src: { path: 'video/clip-1.mp4' },
  flight: { src: { path: 'flights/clip-1.json' }, startUtcMs: 0 },
  lens: { model: 'pinhole', hfovDeg: 70, aspect: 16 / 9 },
  offsetMs: 0,
} as Layer;
const ortho = {
  kind: 'raster',
  id: 'ortho',
  name: 'Ortho',
  visible: true,
  src: { path: 'rasters/ortho.tif' },
  role: 'ortho',
  format: 'cog',
} as Layer;
const basemap = {
  kind: 'basemap',
  id: 'streets',
  name: 'Streets',
  visible: true,
  pack: 'gcc',
  style: 'dark',
} as Layer;

function manifest(layers: Layer[], crs: ProjectManifest['crs'] = { epsg: 32639 }) {
  return { crs, origin: [208800, 3255128, 0], layers } as unknown as ProjectManifest;
}

describe('site street map', () => {
  it('is offered for every project placed on the Earth without a basemap layer', () => {
    expect(wantsSiteBasemap(manifest([video]))).toBe(true);
    expect(wantsSiteBasemap(manifest([]))).toBe(true);
    expect(wantsSiteBasemap(manifest([ortho]))).toBe(true);
    expect(wantsSiteBasemap(manifest([video, basemap]))).toBe(false);
    expect(wantsSiteBasemap(manifest([video], { local: true } as never))).toBe(false);
  });

  it('starts on for every project, and a choice made with the button wins', () => {
    expect(siteBasemapOn({}, 'p')).toBe(true);
    expect(siteBasemapOn({ q: false }, 'p')).toBe(true);
    expect(siteBasemapOn({ p: false }, 'p')).toBe(false);
    expect(siteBasemapOn({ p: true }, 'p')).toBe(true);
  });

  it('covers the content with a margin', () => {
    const e = streetMapExtent([
      [100, 40, -200],
      [700, 50, 300],
    ]);
    // centred on what the content covers, a square
    expect((e.minX + e.maxX) / 2).toBeCloseTo(350, -2);
    expect(e.maxX - e.minX).toBeCloseTo(e.maxZ - e.minZ, 6);
    expect(e.minX).toBeLessThan(0);
    expect(e.maxX).toBeGreaterThan(700);
    expect(e.minZ).toBeLessThan(-200);
    expect(e.maxZ).toBeGreaterThan(300);
    expect(e.maxX - e.minX).toBeLessThan(2500);
  });

  it('keeps a useful size around the origin alone, and stops at 6 km', () => {
    const small = streetMapExtent([]);
    expect(small.maxX - small.minX).toBe(800);
    const huge = streetMapExtent([[40_000, 0, 0]]);
    expect(huge.maxX - huge.minX).toBe(12_000);
  });

  it('measures a model or a cloud by the corners of its box', () => {
    const points = boxPoints({ min: { x: -50, z: -80 }, max: { x: 900, z: 40 } });
    expect(points).toEqual([
      [-50, 0, -80],
      [900, 0, -80],
      [900, 0, 40],
      [-50, 0, 40],
    ]);
    const e = streetMapExtent(points);
    expect(e.minX).toBeLessThan(-50);
    expect(e.maxX).toBeGreaterThan(900);
  });
});

const square = (h: number, cx = 0, cz = 0) => ({
  minX: cx - h,
  maxX: cx + h,
  minZ: cz - h,
  maxZ: cz + h,
});
const half = (e: { minX: number; maxX: number }) => (e.maxX - e.minX) / 2;

describe('street map rings', () => {
  it('surrounds the near ring with rings four and sixteen times its size', () => {
    const rings = streetMapRings(square(500, 100, -50));
    expect(rings.map(half)).toEqual([500, 2000, 8000]);
    // one centre
    for (const r of rings) {
      expect((r.minX + r.maxX) / 2).toBe(100);
      expect((r.minZ + r.maxZ) / 2).toBe(-50);
    }
    expect(rings[0]).toEqual(square(500, 100, -50));
  });

  it('never reaches past 12 km', () => {
    expect(streetMapRings(square(1000)).map(half)).toEqual([1000, 4000, 12_000]);
  });

  it('leaves out a ring that adds little', () => {
    expect(streetMapRings(square(6000)).map(half)).toEqual([6000, 12_000]);
    expect(streetMapRings(square(2500)).map(half)).toEqual([2500, 10_000]);
  });
});

describe('waiting for the scene', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const box = (x: number) => ({ min: { x: 0, z: 0 }, max: { x, z: 10 } });

  it('answers once the content box has stopped changing', () => {
    vi.useFakeTimers();
    let now: ReturnType<typeof box> | null = null;
    const done = vi.fn();
    settledBox(() => now, done);
    vi.advanceTimersByTime(300);
    now = box(10);
    vi.advanceTimersByTime(300);
    now = box(40);
    vi.advanceTimersByTime(300);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(done).toHaveBeenCalledExactlyOnceWith(box(40));
    vi.advanceTimersByTime(5000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting after the cap, with or without a box', () => {
    vi.useFakeTimers();
    const done = vi.fn();
    settledBox(() => null, done);
    vi.advanceTimersByTime(2399);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(301);
    expect(done).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('stops asking when cancelled', () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const cancel = settledBox(() => box(1), done);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(done).not.toHaveBeenCalled();
  });
});

describe('the street map and the landscape from packs', () => {
  const ground = { offered: true, imagery: true, terrain: true, online: false };
  it('gives way while imagery or terrain around the site is drawn', () => {
    expect(landscapeOn({ aroundTerrain: false, aroundImagery: false }, ground)).toBe(false);
    expect(landscapeOn({ aroundTerrain: true, aroundImagery: false }, ground)).toBe(true);
    expect(landscapeOn({ aroundTerrain: false, aroundImagery: true }, ground)).toBe(true);
  });
  it('gives way for an online map as the 3D base, when the preset offers it', () => {
    const none = { aroundTerrain: false, aroundImagery: false };
    const nothing = { offered: true, imagery: false, terrain: false, online: true };
    expect(landscapeOn(none, nothing)).toBe(true);
    expect(landscapeOn(none, { ...nothing, offered: false })).toBe(false);
  });
  it('stays when the choice is on but nothing can be drawn', () => {
    const chosen = { aroundTerrain: true, aroundImagery: true };
    expect(landscapeOn(chosen, { ...ground, offered: false })).toBe(false);
    expect(
      landscapeOn(chosen, { offered: true, imagery: false, terrain: false, online: false }),
    ).toBe(false);
    expect(landscapeOn({ ...chosen, aroundImagery: false }, { ...ground, terrain: false })).toBe(
      false,
    );
  });
});

describe('the street map button', () => {
  const base: StreetMap3d = {
    projectId: 'p',
    wanted: true,
    on: true,
    covered: true,
    landscape: false,
    shown: true,
  };
  it('is pressed while the street map is on, and says what a click does', () => {
    expect(streetMapTool(base)).toEqual({
      label: 'stage.streetMap.hide',
      pressed: true,
      disabled: false,
    });
    expect(streetMapTool({ ...base, on: false, shown: false })).toEqual({
      label: 'stage.streetMap.show',
      pressed: false,
      disabled: false,
    });
    // still looking for a pack: it can be clicked
    expect(streetMapTool({ ...base, covered: null })?.disabled).toBe(false);
  });
  it('is greyed out with the reason', () => {
    expect(streetMapTool({ ...base, covered: false })).toEqual({
      label: 'stage.streetMap.none',
      pressed: false,
      disabled: true,
    });
    expect(streetMapTool({ ...base, landscape: true, shown: false })).toEqual({
      label: 'stage.streetMap.landscape',
      pressed: false,
      disabled: true,
    });
  });
  it('is absent for a project that cannot have the street map', () => {
    expect(streetMapTool({ ...base, wanted: false })).toBeNull();
    expect(streetMapTool({ ...base, projectId: null })).toBeNull();
  });
});

describe('the rings kept for the second view', () => {
  it('belong to one project', () => {
    siteBasemap.getState().setRings('a', '[1]');
    expect(siteBasemap.getState().rings).toEqual({ projectId: 'a', json: '[1]' });
    const kept = siteBasemap.getState().rings;
    siteBasemap.getState().setRings('a', '[1]');
    // the same rings again change nothing (no redraw)
    expect(siteBasemap.getState().rings).toBe(kept);
    siteBasemap.getState().setRings('b', '[2]');
    expect(siteBasemap.getState().rings).toEqual({ projectId: 'b', json: '[2]' });
  });
});
