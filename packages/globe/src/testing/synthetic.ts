/**
 * Synthetic packs for tests (Node only): tiny PNG tiles, a one-polygon vector tile and a PMTiles
 * v3 writer, so a test builds an imagery pack (one flat colour), a terrain pack (one Terrarium
 * height) or a street pack (one layer filled edge to edge) over a box without any real data.
 * Never shipped in the app.
 */
import type { RasterPackMeta } from '@aio/schema';
import { zxyToTileId } from 'pmtiles';
// eslint-disable-next-line no-restricted-imports -- Node-only test fixtures, never in the app
import { crc32, deflateSync } from 'node:zlib';
import { encodeTerrarium } from '../terrarium';
import { lonLatToTileXY, type BBox } from '../tiles';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A PNG of one RGBA colour. */
export function solidPng(size: number, rgba: readonly [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.alloc(1 + size * 4);
  for (let i = 0; i < size; i++) row.set(rgba, 1 + i * 4);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A Terrarium PNG tile of one height (exact to 1/256 m). */
export function terrariumPng(size: number, height: number): Buffer {
  const [r, g, b] = encodeTerrarium(height);
  return solidPng(size, [r, g, b, 255]);
}

function varint(n: number, out: number[]): void {
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

/**
 * A Mapbox Vector Tile with one layer holding one polygon that fills the tile: a street pack
 * of these draws every tile in the colour the street style gives `layer` (`water`, `earth`).
 */
export function squareMvt(layer: string, extent = 4096): Buffer {
  const zigzag = (n: number) => (n << 1) ^ (n >> 31);
  const packed = (values: number[]): number[] => {
    const out: number[] = [];
    for (const v of values) varint(v, out);
    return out;
  };
  const field = (tag: number, bytes: number[]): number[] => {
    const out = [tag];
    varint(bytes.length, out);
    return [...out, ...bytes];
  };
  // MoveTo the corner, three LineTo around the square (clockwise, y down), ClosePath
  const geometry = packed([
    9,
    0,
    0,
    26,
    zigzag(extent),
    0,
    0,
    zigzag(extent),
    zigzag(-extent),
    0,
    15,
  ]);
  const feature = [0x18, 3, ...field(0x22, geometry)];
  const body = [
    0x78,
    2,
    ...field(0x0a, [...Buffer.from(layer, 'utf8')]),
    ...field(0x12, feature),
    0x28,
    ...packed([extent]),
  ];
  return Buffer.from(field(0x1a, body));
}

/**
 * A PMTiles v3 archive holding `tile` at every tile of `bbox` from `minZoom` to `maxZoom` (one
 * copy of the bytes, every entry pointing at it). Internal compression none, root directory only.
 */
export function pmtilesOf(o: {
  bbox: BBox;
  minZoom: number;
  maxZoom: number;
  tile: Buffer;
  tileType: 'png' | 'webp' | 'jpeg' | 'mvt';
  metadata?: unknown;
}): Buffer {
  const ids: number[] = [];
  for (let z = o.minZoom; z <= o.maxZoom; z++) {
    const [x0, y0] = lonLatToTileXY(o.bbox[0], o.bbox[3], z);
    const [x1, y1] = lonLatToTileXY(o.bbox[2], o.bbox[1], z);
    for (let y = Math.floor(y0); y <= Math.floor(y1); y++)
      for (let x = Math.floor(x0); x <= Math.floor(x1); x++) ids.push(zxyToTileId(z, x, y));
  }
  ids.sort((a, b) => a - b);
  // every entry points at the one tile at offset 0 (stored as offset + 1)
  const directory: number[] = [];
  varint(ids.length, directory);
  let last = 0;
  for (const id of ids) {
    varint(id - last, directory);
    last = id;
  }
  for (const value of [1, o.tile.length, 1]) {
    // run lengths, lengths, offsets + 1: the same for every entry
    ids.forEach(() => {
      varint(value, directory);
    });
  }
  const root = Buffer.from(directory);
  const meta = Buffer.from(JSON.stringify(o.metadata ?? {}), 'utf8');
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header[7] = 3;
  const u64 = (v: number, at: number) => {
    header.writeBigUInt64LE(BigInt(v), at);
  };
  const rootOff = 127;
  const metaOff = rootOff + root.length;
  const dataOff = metaOff + meta.length;
  u64(rootOff, 8);
  u64(root.length, 16);
  u64(metaOff, 24);
  u64(meta.length, 32);
  u64(dataOff, 40); // no leaf directories
  u64(0, 48);
  u64(dataOff, 56);
  u64(o.tile.length, 64);
  u64(ids.length, 72); // addressed tiles
  u64(ids.length, 80); // tile entries
  u64(1, 88); // tile contents
  header[96] = 0; // not clustered (entries share one tile)
  header[97] = 1; // internal compression: none
  header[98] = 1; // tile compression: none
  header[99] = { mvt: 1, png: 2, jpeg: 3, webp: 4 }[o.tileType];
  header[100] = o.minZoom;
  header[101] = o.maxZoom;
  const e7 = (v: number) => Math.round(v * 1e7);
  header.writeInt32LE(e7(o.bbox[0]), 102);
  header.writeInt32LE(e7(o.bbox[1]), 106);
  header.writeInt32LE(e7(o.bbox[2]), 110);
  header.writeInt32LE(e7(o.bbox[3]), 114);
  header[118] = o.minZoom;
  header.writeInt32LE(e7((o.bbox[0] + o.bbox[2]) / 2), 119);
  header.writeInt32LE(e7((o.bbox[1] + o.bbox[3]) / 2), 123);
  return Buffer.concat([header, root, meta, o.tile]);
}

/** `aio.raster-pack/1` metadata of a synthetic pack (licence "CC0 test fixture"). */
export function syntheticPackMeta(
  id: string,
  kind: 'imagery' | 'terrain',
  bbox: BBox,
  minZoom: number,
  maxZoom: number,
): RasterPackMeta {
  return {
    schema: 'aio.raster-pack/1',
    id,
    kind,
    label: `Synthetic ${kind} (${id})`,
    bbox: [...bbox],
    minZoom,
    maxZoom,
    tileSize: 256,
    format: 'png',
    ...(kind === 'terrain'
      ? { encoding: 'terrarium' as const, verticalDatum: 'ellipsoid' as const }
      : {}),
    licence: 'CC0 test fixture',
    attribution: `Synthetic ${kind} test pack`,
    provenance: 'Generated by the Stratlas test suite',
    customerLicence: false,
    builtAt: '2026-10-07T00:00:00.000Z',
  };
}
