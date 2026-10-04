// PMTiles v3 reading and writing for the extract (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md):
// the full header, varint directories, internal compression and Hilbert tile ids.
import * as zlib from 'node:zlib';

export const HEADER_LEN = 127;
/** Readers fetch this much first; header plus root directory must fit (spec). */
export const ROOT_FETCH = 16_384;

export const Compression = { unknown: 0, none: 1, gzip: 2, brotli: 3, zstd: 4 } as const;

export interface FullHeader {
  rootOffset: number;
  rootLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafOffset: number;
  leafLength: number;
  dataOffset: number;
  dataLength: number;
  addressedTiles: number;
  tileEntries: number;
  tileContents: number;
  clustered: boolean;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  /** West, south, east, north in degrees. */
  bounds: [number, number, number, number];
  centerZoom: number;
  center: [number, number];
}

export interface Entry {
  tileId: number;
  /** Offset in the tile data section (or the leaf section for a leaf pointer). */
  offset: number;
  length: number;
  /** 0 for a leaf directory pointer. */
  runLength: number;
}

export function readFullHeader(buf: Uint8Array): FullHeader {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < HEADER_LEN || b.toString('ascii', 0, 7) !== 'PMTiles') {
    throw new Error('This file is not a PMTiles map pack.');
  }
  if (b.readUInt8(7) !== 3) {
    throw new Error(
      `This map pack uses PMTiles version ${String(b.readUInt8(7))}; only version 3 works.`,
    );
  }
  const u64 = (at: number) => Number(b.readBigUInt64LE(at));
  const e7 = (at: number) => b.readInt32LE(at) / 1e7;
  return {
    rootOffset: u64(8),
    rootLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafOffset: u64(40),
    leafLength: u64(48),
    dataOffset: u64(56),
    dataLength: u64(64),
    addressedTiles: u64(72),
    tileEntries: u64(80),
    tileContents: u64(88),
    clustered: b.readUInt8(96) === 1,
    internalCompression: b.readUInt8(97),
    tileCompression: b.readUInt8(98),
    tileType: b.readUInt8(99),
    minZoom: b.readUInt8(100),
    maxZoom: b.readUInt8(101),
    bounds: [e7(102), e7(106), e7(110), e7(114)],
    centerZoom: b.readUInt8(118),
    center: [e7(119), e7(123)],
  };
}

export function writeFullHeader(h: FullHeader): Buffer {
  const b = Buffer.alloc(HEADER_LEN);
  b.write('PMTiles', 0, 'ascii');
  b.writeUInt8(3, 7);
  const u64 = (v: number, at: number) => {
    b.writeBigUInt64LE(BigInt(v), at);
  };
  const e7 = (v: number, at: number) => {
    b.writeInt32LE(Math.round(v * 1e7), at);
  };
  u64(h.rootOffset, 8);
  u64(h.rootLength, 16);
  u64(h.metadataOffset, 24);
  u64(h.metadataLength, 32);
  u64(h.leafOffset, 40);
  u64(h.leafLength, 48);
  u64(h.dataOffset, 56);
  u64(h.dataLength, 64);
  u64(h.addressedTiles, 72);
  u64(h.tileEntries, 80);
  u64(h.tileContents, 88);
  b.writeUInt8(h.clustered ? 1 : 0, 96);
  b.writeUInt8(h.internalCompression, 97);
  b.writeUInt8(h.tileCompression, 98);
  b.writeUInt8(h.tileType, 99);
  b.writeUInt8(h.minZoom, 100);
  b.writeUInt8(h.maxZoom, 101);
  e7(h.bounds[0], 102);
  e7(h.bounds[1], 106);
  e7(h.bounds[2], 110);
  e7(h.bounds[3], 114);
  b.writeUInt8(h.centerZoom, 118);
  e7(h.center[0], 119);
  e7(h.center[1], 123);
  return b;
}

export function decompress(data: Uint8Array, compression: number): Buffer {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  switch (compression) {
    case Compression.none:
    case Compression.unknown:
      return b;
    case Compression.gzip:
      return zlib.gunzipSync(b);
    case Compression.brotli:
      return zlib.brotliDecompressSync(b);
    case Compression.zstd:
      return zlib.zstdDecompressSync(b);
    default:
      throw new Error(`The map pack uses an unknown compression (${String(compression)}).`);
  }
}

export function compress(data: Uint8Array, compression: number): Buffer {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  switch (compression) {
    case Compression.none:
    case Compression.unknown:
      return b;
    case Compression.gzip:
      return zlib.gzipSync(b);
    case Compression.brotli:
      return zlib.brotliCompressSync(b);
    case Compression.zstd:
      return zlib.zstdCompressSync(b);
    default:
      throw new Error(`The map pack uses an unknown compression (${String(compression)}).`);
  }
}

// Varints hold values up to 2^53 here (tile ids reach 4^26), so they are read with arithmetic.
function readVarint(b: Buffer, pos: { at: number }): number {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (pos.at >= b.length) throw new Error('The map pack directory is cut short.');
    const byte = b[pos.at++] ?? 0;
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
    scale *= 128;
    if (scale > 2 ** 63) throw new Error('The map pack directory holds a bad number.');
  }
}

function writeVarint(out: number[], v: number): void {
  let n = v;
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

/** Parse a decompressed directory. */
export function parseDirectory(raw: Uint8Array): Entry[] {
  const b = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const pos = { at: 0 };
  const n = readVarint(b, pos);
  const entries: Entry[] = [];
  let id = 0;
  for (let i = 0; i < n; i++) {
    id += readVarint(b, pos);
    entries.push({ tileId: id, offset: 0, length: 0, runLength: 1 });
  }
  for (const e of entries) e.runLength = readVarint(b, pos);
  for (const e of entries) e.length = readVarint(b, pos);
  for (let i = 0; i < n; i++) {
    const v = readVarint(b, pos);
    const e = entries[i];
    const prev = entries[i - 1];
    if (!e) continue;
    e.offset = v === 0 && prev ? prev.offset + prev.length : v - 1;
  }
  return entries;
}

/** Serialise entries (sorted by tile id) into an uncompressed directory. */
export function serializeDirectory(entries: readonly Entry[]): Buffer {
  const out: number[] = [];
  writeVarint(out, entries.length);
  let last = 0;
  for (const e of entries) {
    writeVarint(out, e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) writeVarint(out, e.runLength);
  for (const e of entries) writeVarint(out, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    if (prev && e.offset === prev.offset + prev.length) writeVarint(out, 0);
    else writeVarint(out, e.offset + 1);
  });
  return Buffer.from(out);
}

/** First tile id of each zoom: (4^z - 1) / 3. */
export function zoomBase(z: number): number {
  return (4 ** z - 1) / 3;
}

/** Hilbert tile id of z/x/y (PMTiles v3). */
export function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) throw new Error('Zoom above 26 is not supported.');
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n)
    throw new Error(`Tile ${String(z)}/${String(x)}/${String(y)} is outside the world.`);
  let tx = x;
  let ty = y;
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        tx = n - 1 - tx;
        ty = n - 1 - ty;
      }
      const t = tx;
      tx = ty;
      ty = t;
    }
  }
  return zoomBase(z) + d;
}

/** Inverse of `zxyToTileId`. */
export function tileIdToZxy(id: number): [number, number, number] {
  let z = 0;
  while (zoomBase(z + 1) <= id) z++;
  const n = 2 ** z;
  let t = id - zoomBase(z);
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    const q = t % 4;
    const rx = q >> 1;
    const ry = 1 & (q ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [z, x, y];
}
