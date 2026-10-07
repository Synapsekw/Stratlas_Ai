import type { Layer, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  hasOwnGround,
  siteBasemapDefault,
  siteBasemapOn,
  streetMapExtent,
  wantsSiteBasemap,
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

  it('starts on while the project has no ground of its own, or has stockpiles', () => {
    expect(hasOwnGround(manifest([video]))).toBe(false);
    expect(siteBasemapDefault(manifest([video]), false)).toBe(true);
    expect(siteBasemapDefault(manifest([video, ortho]), false)).toBe(false);
    expect(siteBasemapDefault(manifest([video, ortho]), true)).toBe(true);
    // a choice made in the Layers popover wins
    expect(siteBasemapOn({ p: false }, 'p', true)).toBe(false);
    expect(siteBasemapOn({}, 'p', true)).toBe(true);
  });

  it('covers the flights with a margin instead of a fixed 5 km square', () => {
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

  it('keeps a useful size around the origin alone, and the old square with own ground', () => {
    const small = streetMapExtent([]);
    expect(small.maxX - small.minX).toBe(800);
    const own = streetMapExtent([[10, 0, 10]], true);
    expect(own.maxX - own.minX).toBe(5000);
    const huge = streetMapExtent([[40_000, 0, 0]]);
    expect(huge.maxX - huge.minX).toBe(12_000);
  });
});
