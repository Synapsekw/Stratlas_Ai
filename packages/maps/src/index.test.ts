import { describe, expect, it } from 'vitest';
import {
  bboxOf,
  orderPacks,
  packCovers,
  packFileUrl,
  packsForTile,
  packUrl,
  tileBbox,
  zoomForBbox,
  type MapPack,
} from './index';

const world: MapPack = {
  id: 'world',
  label: 'World',
  bbox: [-180, -85, 180, 85],
  maxZoom: 6,
  sizeBytes: 45e6,
};
const gcc: MapPack = {
  id: 'gcc',
  label: 'GCC',
  bbox: [34.5, 12.0, 60.0, 32.5],
  maxZoom: 15,
  sizeBytes: 1.3e9,
};
const kuwait: MapPack = {
  id: 'kuwait',
  label: 'Kuwait',
  bbox: [46.5, 28.5, 48.5, 30.1],
  maxZoom: 15,
  sizeBytes: 24e6,
};

describe('map packs', () => {
  it('builds a pmtiles url', () => {
    expect(packUrl({ id: 'gcc' })).toBe('pmtiles://aio://packs/gcc.pmtiles');
    expect(packFileUrl({ id: 'gcc' })).toBe('aio://packs/gcc.pmtiles');
  });

  it('rejects path-like ids', () => {
    expect(() => packUrl({ id: '../x' })).toThrow('Invalid map pack id');
  });

  it('knows Al-Zour is inside the GCC pack', () => {
    expect(packCovers({ bbox: [34.5, 12.0, 60.0, 32.5] }, 48.4, 28.7)).toBe(true);
    expect(packCovers(kuwait, 55.3, 25.2)).toBe(false);
  });

  it('orders packs most detailed and smallest area first', () => {
    expect(orderPacks([world, gcc, kuwait]).map((p) => p.id)).toEqual(['kuwait', 'gcc', 'world']);
  });

  it('picks packs per tile: detail where covered, world elsewhere', () => {
    const ordered = orderPacks([world, gcc, kuwait]);
    // z14 tile over Al-Zour (48.397 E, 28.719 N).
    expect(packsForTile(ordered, 14, 10394, 6826).map((p) => p.id)).toEqual(['kuwait', 'gcc']);
    // z14 tile over Dubai.
    expect(packsForTile(ordered, 14, 10707, 7006).map((p) => p.id)).toEqual(['gcc']);
    // z10 tile over Paris: no detail pack, world stops at z6.
    expect(packsForTile(ordered, 10, 518, 352)).toEqual([]);
    // Low zoom: the world pack is complete, prefer it so tiles are never clipped.
    expect(packsForTile(ordered, 4, 10, 6).map((p) => p.id)).toEqual(['world', 'kuwait', 'gcc']);
  });
});

describe('tile maths', () => {
  it('computes a tile bbox', () => {
    expect(tileBbox(0, 0, 0)[0]).toBeCloseTo(-180);
    expect(tileBbox(0, 0, 0)[3]).toBeCloseTo(85.0511, 3);
    const [w, s, e, n] = tileBbox(14, 10394, 6826);
    expect(48.397).toBeGreaterThan(w);
    expect(48.397).toBeLessThan(e);
    expect(28.719).toBeGreaterThan(s);
    expect(28.719).toBeLessThan(n);
  });

  it('computes the bbox of points', () => {
    expect(
      bboxOf([
        [48.1, 29.2],
        [48.4, 28.7],
        [47.9, 29.0],
      ]),
    ).toEqual([47.9, 28.7, 48.4, 29.2]);
    expect(bboxOf([])).toBeNull();
  });

  it('finds the zoom that fits a bbox in a viewport', () => {
    // A 2.2 km wide site at 28.7 N in 800x600 px (512 px tiles): about z14.6.
    const z = zoomForBbox([48.385, 28.712, 48.408, 28.726], 800, 600);
    expect(z).toBeGreaterThan(14.4);
    expect(z).toBeLessThan(14.8);
    // The whole world in 512 px is z0, in 1024 px z1.
    expect(zoomForBbox([-180, -85.0511, 180, 85.0511], 512, 512)).toBeCloseTo(0, 2);
    expect(zoomForBbox([-180, -85.0511, 180, 85.0511], 1024, 1024)).toBeCloseTo(1, 2);
    // Degenerate bbox clamps to maxZoom.
    expect(zoomForBbox([48, 29, 48, 29], 800, 600, { maxZoom: 17 })).toBe(17);
  });
});
