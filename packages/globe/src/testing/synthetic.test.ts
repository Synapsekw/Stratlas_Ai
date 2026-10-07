import { RasterPackMeta } from '@aio/schema';
import { PMTiles, TileType, type Source } from 'pmtiles';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { terrariumHeight } from '../terrarium';
import { lonLatToTileXY } from '../tiles';
import { pmtilesOf, solidPng, syntheticPackMeta, terrariumPng } from './synthetic';

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
});
