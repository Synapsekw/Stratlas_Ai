import { open, stat } from 'node:fs/promises';

/** Fixed size of a PMTiles v3 header. */
export const HEADER_BYTES = 127;

const TILE_TYPES = ['unknown', 'mvt', 'png', 'jpeg', 'webp', 'avif'] as const;
export type TileType = (typeof TILE_TYPES)[number];

export interface PackHeader {
  version: number;
  minZoom: number;
  maxZoom: number;
  /** West, south, east, north from the header bounds. */
  bbox: [number, number, number, number];
  tileType: TileType;
  /** Offset one past the last section the header points at; the file must be at least this long. */
  end: number;
}

/**
 * Parse the 127-byte PMTiles v3 header (https://github.com/protomaps/PMTiles/blob/main/spec/v3).
 * Throws a sentence a person can read when the bytes are not a PMTiles v3 archive.
 */
export function parseHeader(buf: Uint8Array): PackHeader {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < HEADER_BYTES || b.toString('ascii', 0, 7) !== 'PMTiles') {
    throw new Error('This file is not a PMTiles map pack.');
  }
  const version = b.readUInt8(7);
  if (version !== 3) {
    throw new Error(`This map pack uses PMTiles version ${String(version)}; only version 3 works.`);
  }
  const u64 = (at: number) => Number(b.readBigUInt64LE(at));
  const sections: [number, number][] = [
    [u64(8), u64(16)], // root directory
    [u64(24), u64(32)], // metadata
    [u64(40), u64(48)], // leaf directories
    [u64(56), u64(64)], // tile data
  ];
  const end = Math.max(HEADER_BYTES, ...sections.map(([off, len]) => (len > 0 ? off + len : 0)));
  const e7 = (at: number) => b.readInt32LE(at) / 1e7;
  return {
    version,
    minZoom: b.readUInt8(100),
    maxZoom: b.readUInt8(101),
    bbox: [e7(102), e7(106), e7(110), e7(114)],
    tileType: TILE_TYPES[b.readUInt8(99)] ?? 'unknown',
    end,
  };
}

/** Read and parse the header of a pack file. */
export async function readHeader(file: string): Promise<PackHeader> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
    return parseHeader(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

function overlapShare(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const area = (a[2] - a[0]) * (a[3] - a[1]);
  return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
}

/**
 * Verify a pack file before it is installed: a complete PMTiles v3 vector archive and, for a
 * download, the zoom and area that were asked for. Resolves the header; throws on any problem.
 */
export async function checkPack(
  file: string,
  expected?: { maxZoom: number; bbox: readonly [number, number, number, number] },
): Promise<PackHeader> {
  const header = await readHeader(file);
  const { size } = await stat(file);
  if (size < header.end) {
    throw new Error(
      `The map pack is incomplete: ${String(size)} of ${String(header.end)} bytes are present.`,
    );
  }
  if (header.tileType !== 'mvt') {
    throw new Error(
      `The map pack holds ${header.tileType} tiles; the offline basemap needs vector (MVT) tiles.`,
    );
  }
  if (expected) {
    if (header.maxZoom !== expected.maxZoom) {
      throw new Error(
        `The map pack reaches zoom ${String(header.maxZoom)}, not the zoom ${String(expected.maxZoom)} that was asked for.`,
      );
    }
    if (overlapShare(header.bbox, expected.bbox) < 0.5) {
      throw new Error('The map pack does not cover the area that was asked for.');
    }
  }
  return header;
}
