import { describe, expect, it } from 'vitest';
import type { Layer } from '@aio/schema';
import { dsmGroundAt, dsmGroundLayers, dsmGroundProvider } from './dsmGround';

const ORIGIN = [500_000, 2_700_000, 100] as const;

describe('the DSM ground near a tower base', () => {
  it('takes the 5th percentile within 30 m, not the tower top under the point', () => {
    // ground at local y = 2 (102 m) with a 40 m tower in the middle 3 m
    const sample = (x: number, z: number) => (Math.hypot(x - 10, z + 10) < 3 ? 42 : 2);
    const g = dsmGroundAt(500_010, 2_700_010, [...ORIGIN], sample);
    expect(g).toBeCloseTo(102, 6);
  });

  it('answers null off the DSM, and asks a miss again only after a while', () => {
    let calls = 0;
    let now = 0;
    const p = dsmGroundProvider(
      ['dsm-1'],
      [...ORIGIN],
      () => {
        calls++;
        return null;
      },
      () => now,
    );
    expect(p(500_000, 2_700_000)).toBeNull();
    const first = calls;
    expect(p(500_000, 2_700_000)).toBeNull();
    expect(calls).toBe(first);
    now = 5000;
    p(500_000, 2_700_000);
    expect(calls).toBe(2 * first);
  });

  it('uses the first DSM that covers the base and remembers it', () => {
    let second = 0;
    const p = dsmGroundProvider(['a', 'b'], [...ORIGIN], (_x, _z, id) => {
      if (id === 'b') second++;
      return id === 'a' ? null : 5;
    });
    expect(p(500_000, 2_700_000)).toBe(105);
    const n = second;
    expect(p(500_000, 2_700_000)).toBe(105);
    expect(second).toBe(n);
  });

  it('reads the whole square window, corners included, as the job does', () => {
    // low ground only in the four corners beyond the 30 m circle (about 7% of the window)
    const sample = (x: number, z: number) => (Math.abs(x) > 22 && Math.abs(z) > 22 ? 0 : 10);
    expect(dsmGroundAt(500_000, 2_700_000, [...ORIGIN], sample)).toBeCloseTo(100, 6);
  });

  it('takes only COG DSMs, in manifest order, like the job', () => {
    const raster = (id: string, role: string, format: string) =>
      ({
        kind: 'raster',
        id,
        name: id,
        visible: true,
        role,
        format,
        src: { path: `${id}.tif` },
      }) as Layer;
    const layers = [
      raster('tiles', 'dsm', 'pmtiles'),
      raster('ortho', 'ortho', 'cog'),
      raster('b', 'dsm', 'cog'),
      raster('a', 'dsm', 'cog'),
    ];
    expect(dsmGroundLayers({ layers })).toEqual(['b', 'a']);
  });
});
