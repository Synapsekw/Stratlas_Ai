// The survey day a Bentley `.zpc` cloud carries: the LAS header creation date of its tiles.
// A `.zpc` is a ZIP of LAS/LAZ tiles; only the central directory and the first bytes of a few
// tiles are read, never the whole (gigabyte) file. The header date is the export day, not the
// flight day, so it is only a default the person confirms in Add data.
import { open } from 'node:fs/promises';
import { constants, inflateRawSync } from 'node:zlib';
import { importDay } from './raw';

/** At most this many tiles are looked at. */
const MAX_TILES = 16;
/** The LAS public header fields read: creation day (u16 at 90) and year (u16 at 92). */
const HEADER_BYTES = 94;
/** Compressed bytes read of a deflated tile: far more than 94 bytes of header need. */
const DEFLATE_BYTES = 64 * 1024;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * The creation day of a LAS or LAZ file from its header (LASzip leaves the header uncompressed):
 * `YYYY-MM-DD`, or null when it is not a LAS header or carries no valid date (year 0, day 0, a
 * year outside 1990 to next year, a day past the end of its year).
 */
export function lasHeaderDay(header: Uint8Array): string | null {
  if (header.length < HEADER_BYTES) return null;
  if (
    String.fromCharCode(header[0] ?? 0, header[1] ?? 0, header[2] ?? 0, header[3] ?? 0) !== 'LASF'
  )
    return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const day = view.getUint16(90, true);
  const year = view.getUint16(92, true);
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return null;
  if (day < 1 || day > (isLeap(year) ? 366 : 365)) return null;
  return new Date(Date.UTC(year, 0, day)).toISOString().slice(0, 10);
}

interface Entry {
  name: string;
  method: number;
  compressed: number;
  offset: number;
}

async function readAt(
  fh: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** The first tiles of the central directory, in directory order; encrypted members are left out. */
async function tiles(fh: Awaited<ReturnType<typeof open>>, size: number): Promise<Entry[]> {
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = await readAt(fh, size - tailLength, tailLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  const count = tail.readUInt16LE(end + 10);
  const dirSize = tail.readUInt32LE(end + 12);
  const dirOffset = tail.readUInt32LE(end + 16);
  // ZIP64 archives (a 0xFFFFFFFF marker) are not read
  if (dirOffset === 0xffffffff || dirSize === 0xffffffff || dirOffset + dirSize > size) return [];
  const dir = await readAt(fh, dirOffset, dirSize);
  const found: Entry[] = [];
  let at = 0;
  for (let n = 0; n < count && found.length < MAX_TILES; n++) {
    if (at + 46 > dir.length || dir.readUInt32LE(at) !== 0x02014b50) break;
    const flags = dir.readUInt16LE(at + 8);
    const method = dir.readUInt16LE(at + 10);
    const compressed = dir.readUInt32LE(at + 20);
    const nameLength = dir.readUInt16LE(at + 28);
    const extraLength = dir.readUInt16LE(at + 30);
    const commentLength = dir.readUInt16LE(at + 32);
    const offset = dir.readUInt32LE(at + 42);
    const name = dir.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || offset === 0xffffffff) continue;
    if (/\.la[sz]$/i.test(name)) found.push({ name, method, compressed, offset });
  }
  return found;
}

/** The first bytes of a tile's content, or null when the method is not stored or deflated. */
async function tileHead(fh: Awaited<ReturnType<typeof open>>, e: Entry): Promise<Buffer | null> {
  if (e.method !== 0 && e.method !== 8) return null;
  const local = await readAt(fh, e.offset, 30);
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) return null;
  const data = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (e.method === 0) return readAt(fh, data, HEADER_BYTES);
  const raw = await readAt(fh, data, Math.min(e.compressed, DEFLATE_BYTES));
  try {
    return inflateRawSync(raw, { finishFlush: constants.Z_SYNC_FLUSH });
  } catch {
    return null;
  }
}

/**
 * The LAS header creation day of a `.zpc`'s tiles (the most frequent day, a tie to the earlier),
 * or null when the file is not a ZIP, has no tiles, or no tile carries a valid date. Never throws.
 */
export async function zpcHeaderDay(path: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, 'r');
    const { size } = await fh.stat();
    if (size < 22) return null;
    const days: string[] = [];
    for (const e of await tiles(fh, size)) {
      const head = await tileHead(fh, e);
      const day = head ? lasHeaderDay(head) : null;
      if (day) days.push(day);
    }
    return importDay(days);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
