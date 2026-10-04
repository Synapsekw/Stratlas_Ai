/**
 * ZIP records (APPNOTE 6.3.10) for store-mode archives with ZIP64 and WinZip AES extras.
 * Pure byte builders and parsers; the writer and reader do the I/O.
 */

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_EOCD64 = 0x06064b50;
export const SIG_LOCATOR64 = 0x07064b50;

export const METHOD_STORE = 0;
export const METHOD_AES = 99;
export const FLAG_ENCRYPTED = 0x0001;
export const FLAG_UTF8 = 0x0800;
export const EXTRA_ZIP64 = 0x0001;
export const EXTRA_AES = 0x9901;

export const LOCAL_HEADER_BYTES = 30;
export const CENTRAL_HEADER_BYTES = 46;
export const EOCD_BYTES = 22;
export const EOCD64_BYTES = 56;
export const LOCATOR64_BYTES = 20;

const MAX16 = 0xffff;
export const MAX32 = 0xffffffff;
/** Version 4.5 (ZIP64); 5.1 for AES. */
const VERSION_ZIP64 = 45;
const VERSION_AES = 51;

export interface MemberRecord {
  name: Buffer;
  size: number;
  /** Stored bytes, including the AES salt, check and auth code. */
  compressedSize: number;
  crc32: number;
  encrypted: boolean;
  dosTime: number;
  dosDate: number;
  /** Offset of the local header in the archive. */
  offset: number;
}

/** MS-DOS date and time fields (local time, 2 s resolution). */
export function dosDateTime(ms: number): { dosDate: number; dosTime: number } {
  const d = new Date(ms);
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    dosDate: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

function aesExtra(): Buffer {
  const b = Buffer.alloc(11);
  b.writeUInt16LE(EXTRA_AES, 0);
  b.writeUInt16LE(7, 2);
  b.writeUInt16LE(2, 4); // AE-2: no CRC
  b.write('AE', 6, 'ascii');
  b.writeUInt8(3, 8); // AES-256
  b.writeUInt16LE(METHOD_STORE, 9);
  return b;
}

function zip64Extra(values: number[]): Buffer {
  const b = Buffer.alloc(4 + values.length * 8);
  b.writeUInt16LE(EXTRA_ZIP64, 0);
  b.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => {
    b.writeBigUInt64LE(BigInt(v), 4 + i * 8);
  });
  return b;
}

export function needsZip64(m: Pick<MemberRecord, 'size' | 'compressedSize'>): boolean {
  return m.size >= MAX32 || m.compressedSize >= MAX32;
}

/** Local file header. Sizes are known up front (store mode); the CRC is patched afterwards. */
export function localHeader(m: MemberRecord, forceZip64 = false): Buffer {
  const big = forceZip64 || needsZip64(m);
  const extra = Buffer.concat([
    big ? zip64Extra([m.size, m.compressedSize]) : Buffer.alloc(0),
    m.encrypted ? aesExtra() : Buffer.alloc(0),
  ]);
  const h = Buffer.alloc(LOCAL_HEADER_BYTES);
  h.writeUInt32LE(SIG_LOCAL, 0);
  h.writeUInt16LE(m.encrypted ? VERSION_AES : VERSION_ZIP64, 4);
  h.writeUInt16LE(FLAG_UTF8 | (m.encrypted ? FLAG_ENCRYPTED : 0), 6);
  h.writeUInt16LE(m.encrypted ? METHOD_AES : METHOD_STORE, 8);
  h.writeUInt16LE(m.dosTime, 10);
  h.writeUInt16LE(m.dosDate, 12);
  h.writeUInt32LE(m.crc32 >>> 0, 14);
  h.writeUInt32LE(big ? MAX32 : m.compressedSize, 18);
  h.writeUInt32LE(big ? MAX32 : m.size, 22);
  h.writeUInt16LE(m.name.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, m.name, extra]);
}

/** Offset of the CRC field inside a local header. */
export const LOCAL_CRC_OFFSET = 14;

export function centralHeader(m: MemberRecord, forceZip64 = false): Buffer {
  const bigSize = forceZip64 || m.size >= MAX32;
  const bigCsize = forceZip64 || m.compressedSize >= MAX32;
  const bigOffset = forceZip64 || m.offset >= MAX32;
  const values = [
    ...(bigSize ? [m.size] : []),
    ...(bigCsize ? [m.compressedSize] : []),
    ...(bigOffset ? [m.offset] : []),
  ];
  const extra = Buffer.concat([
    values.length ? zip64Extra(values) : Buffer.alloc(0),
    m.encrypted ? aesExtra() : Buffer.alloc(0),
  ]);
  const h = Buffer.alloc(CENTRAL_HEADER_BYTES);
  h.writeUInt32LE(SIG_CENTRAL, 0);
  h.writeUInt16LE(VERSION_ZIP64, 4); // made by: MS-DOS host, 4.5
  h.writeUInt16LE(m.encrypted ? VERSION_AES : VERSION_ZIP64, 6);
  h.writeUInt16LE(FLAG_UTF8 | (m.encrypted ? FLAG_ENCRYPTED : 0), 8);
  h.writeUInt16LE(m.encrypted ? METHOD_AES : METHOD_STORE, 10);
  h.writeUInt16LE(m.dosTime, 12);
  h.writeUInt16LE(m.dosDate, 14);
  h.writeUInt32LE(m.crc32 >>> 0, 16);
  h.writeUInt32LE(bigCsize ? MAX32 : m.compressedSize, 20);
  h.writeUInt32LE(bigSize ? MAX32 : m.size, 24);
  h.writeUInt16LE(m.name.length, 28);
  h.writeUInt16LE(extra.length, 30);
  // comment length, disk start, internal and external attributes stay 0
  h.writeUInt32LE(bigOffset ? MAX32 : m.offset, 42);
  return Buffer.concat([h, m.name, extra]);
}

/** ZIP64 end record and locator (when needed) followed by the classic end record. */
export function endRecords(o: {
  entries: number;
  cdOffset: number;
  cdSize: number;
  forceZip64?: boolean;
}): Buffer {
  const big =
    (o.forceZip64 ?? false) || o.entries >= MAX16 || o.cdOffset >= MAX32 || o.cdSize >= MAX32;
  const parts: Buffer[] = [];
  if (big) {
    const e = Buffer.alloc(EOCD64_BYTES);
    e.writeUInt32LE(SIG_EOCD64, 0);
    e.writeBigUInt64LE(BigInt(EOCD64_BYTES - 12), 4);
    e.writeUInt16LE(VERSION_ZIP64, 12);
    e.writeUInt16LE(VERSION_ZIP64, 14);
    e.writeBigUInt64LE(BigInt(o.entries), 24);
    e.writeBigUInt64LE(BigInt(o.entries), 32);
    e.writeBigUInt64LE(BigInt(o.cdSize), 40);
    e.writeBigUInt64LE(BigInt(o.cdOffset), 48);
    const l = Buffer.alloc(LOCATOR64_BYTES);
    l.writeUInt32LE(SIG_LOCATOR64, 0);
    l.writeBigUInt64LE(BigInt(o.cdOffset + o.cdSize), 8);
    l.writeUInt32LE(1, 16);
    parts.push(e, l);
  }
  const r = Buffer.alloc(EOCD_BYTES);
  r.writeUInt32LE(SIG_EOCD, 0);
  r.writeUInt16LE(big ? MAX16 : o.entries, 8);
  r.writeUInt16LE(big ? MAX16 : o.entries, 10);
  r.writeUInt32LE(big ? MAX32 : o.cdSize, 12);
  r.writeUInt32LE(big ? MAX32 : o.cdOffset, 16);
  parts.push(r);
  return Buffer.concat(parts);
}
