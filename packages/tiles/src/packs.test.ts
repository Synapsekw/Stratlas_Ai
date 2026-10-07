import { describe, expect, it } from 'vitest';
import {
  createRasterTileSource,
  decodeTerrarium,
  lonLatToTileXY,
  orderRasterPacks,
  rasterCredits,
  rasterPackUrl,
  rasterPacksForTile,
  type RasterPack,
  type RasterTileReader,
} from './packs';

const pack = (id: string, over: Partial<RasterPack> = {}): RasterPack => ({
  id,
  kind: 'imagery',
  label: id,
  bbox: [-180, -85, 180, 85],
  minZoom: 0,
  maxZoom: 9,
  attribution: `© ${id}`,
  licence: 'CC-BY-4.0',
  ...over,
});

describe('raster pack providers (shared by the map, the site view and the Globe)', () => {
  it('addresses packs by kind on aio://', () => {
    expect(rasterPackUrl(pack('world'))).toBe('aio://packs/imagery/world.pmtiles');
    expect(rasterPackUrl({ id: 'dem', kind: 'terrain' })).toBe('aio://packs/terrain/dem.pmtiles');
    expect(() => rasterPackUrl(pack('../x'))).toThrow();
  });

  it('prefers the most detailed covering pack and falls back where it has no tile', async () => {
    const world = pack('world');
    const gcc = pack('gcc', { bbox: [46, 22, 57, 30], maxZoom: 14, attribution: '© gcc' });
    const site = pack('site', { bbox: [51, 28.9, 51.01, 28.94], minZoom: 10, maxZoom: 17 });
    const dem = pack('dem', { kind: 'terrain' });
    expect(orderRasterPacks([world, site, gcc]).map((p) => p.id)).toEqual(['site', 'gcc', 'world']);
    const [x, y] = lonLatToTileXY(51.005, 28.93, 12).map(Math.floor) as [number, number];
    expect(
      rasterPacksForTile(orderRasterPacks([world, site, gcc]), 12, x, y).map((p) => p.id),
    ).toEqual(['site', 'gcc']);
    const calls: string[] = [];
    const reader = (p: RasterPack): RasterTileReader => ({
      getZxy: (z) => {
        calls.push(`${p.id}/${String(z)}`);
        // the site pack is empty at this tile (transparent tiles are not stored)
        if (p.id === 'site') return Promise.resolve(undefined);
        return Promise.resolve({ data: new TextEncoder().encode(p.id).buffer });
      },
    });
    const src = createRasterTileSource('imagery', [world, site, gcc, dem], reader);
    expect(src.packs.map((p) => p.id)).toEqual(['site', 'gcc', 'world']);
    expect(src.maxZoom).toBe(17);
    const t = await src.getTile(12, x, y);
    expect(t?.pack.id).toBe('gcc');
    expect(calls).toEqual(['site/12', 'gcc/12']);
    expect(await src.getTile(16, 0, 0)).toBeUndefined();
    expect(src.credits()).toEqual(['© site', '© gcc', '© world']);
  });

  it('decodes Terrarium heights', () => {
    // 0 m, 123.45 m (rounded to 1/256), -10 m
    const enc = (h: number) => {
      const n = Math.round((h + 32768) * 256);
      return [n >> 16, (n >> 8) & 255, n & 255, 255];
    };
    const px = [...enc(0), ...enc(123.45), ...enc(-10)];
    const h = decodeTerrarium(px);
    expect(h[0]).toBe(0);
    expect(Math.abs((h[1] ?? 0) - 123.45)).toBeLessThan(1 / 256);
    expect(h[2]).toBe(-10);
  });

  it('lists each attribution once', () => {
    expect(rasterCredits([pack('a'), pack('b', { attribution: '© a' }), pack('c')])).toEqual([
      '© a',
      '© c',
    ]);
  });
});
