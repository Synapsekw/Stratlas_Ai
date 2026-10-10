import { RasterPackMeta } from '@aio/schema';
import { PMTiles, TileType, type Source } from 'pmtiles';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { terrariumHeight } from '../terrarium';
import { lonLatToTileXY } from '../tiles';
import { pmtilesOf, solidPng, squareMvt, syntheticPackMeta, terrariumPng } from './synthetic';

const memory = (buf: Buffer): Source => ({
  getKey: () => 'memory',
  getBytes: (offset, length) =>
    Promise.resolve({
      data: buf.buffer.slice(
        buf.byteOffset + offset,
        buf.byteOffset + offset + length,
      ) as ArrayBuffer,
    }),
});

/** The first pixel of a PNG written by `solidPng` (filter 0, RGBA). */
function firstPixel(png: Buffer): number[] {
  const idat = png.indexOf('IDAT');
  const len = png.readUInt32BE(idat - 4);
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + len));
  return [...raw.subarray(1, 5)];
}

describe('synthetic raster packs (test fixtures)', () => {
  const bbox = [49.99, 29.29, 50.01, 29.31] as const;

  it('writes a PMTiles archive the pmtiles reader serves tile by tile', async () => {
    const tile = solidPng(256, [255, 0, 200, 255]);
    const archive = new PMTiles(
      memory(pmtilesOf({ bbox, minZoom: 0, maxZoom: 14, tile, tileType: 'png' })),
    );
    const header = await archive.getHeader();
    expect(header.tileType).toBe(TileType.Png);
    expect([header.minZoom, header.maxZoom]).toEqual([0, 14]);
    const [x, y] = lonLatToTileXY(50, 29.3, 14).map(Math.floor) as [number, number];
    const got = await archive.getZxy(14, x, y);
    expect(got && firstPixel(Buffer.from(got.data))).toEqual([255, 0, 200, 255]);
    expect(await archive.getZxy(14, x + 50, y)).toBeUndefined();
  });

  it('encodes a terrain pack height to 1/256 m, with valid pack metadata', () => {
    const [r = 0, g = 0, b = 0] = firstPixel(terrariumPng(4, 123.45));
    expect(Math.abs(terrariumHeight(r, g, b) - 123.45)).toBeLessThanOrEqual(1 / 512);
    expect(RasterPackMeta.safeParse(syntheticPackMeta('t', 'terrain', bbox, 0, 12)).success).toBe(
      true,
    );
    expect(RasterPackMeta.safeParse(syntheticPackMeta('i', 'imagery', bbox, 0, 14)).success).toBe(
      true,
    );
  });

  it('writes a street pack of one-polygon vector tiles', async () => {
    const tile = squareMvt('water');
    // one layer (field 3), version 2, its name, one polygon feature, extent 4096
    expect(tile[0]).toBe(0x1a);
    expect(tile[1]).toBe(tile.length - 2);
    expect([...tile.subarray(2, 4)]).toEqual([0x78, 2]);
    expect(tile.subarray(4, 11).toString('latin1')).toBe('\x0a\x05water');
    expect([...tile.subarray(-3)]).toEqual([0x28, 0x80, 0x20]);
    // the ring: MoveTo 0,0; LineTo +4096,0; 0,+4096; -4096,0; ClosePath
    const ring = [9, 0, 0, 26, 0x80, 0x40, 0, 0, 0x80, 0x40, 0xff, 0x3f, 0, 15];
    expect(tile.includes(Buffer.from(ring))).toBe(true);
    const archive = new PMTiles(
      memory(pmtilesOf({ bbox, minZoom: 6, maxZoom: 14, tile, tileType: 'mvt' })),
    );
    expect((await archive.getHeader()).tileType).toBe(TileType.Mvt);
    const [x, y] = lonLatToTileXY(50, 29.3, 10).map(Math.floor) as [number, number];
    expect(Buffer.from((await archive.getZxy(10, x, y))?.data ?? new ArrayBuffer(0))).toEqual(tile);
    expect(await archive.getZxy(5, 20, 13)).toBeUndefined();
  });
});
