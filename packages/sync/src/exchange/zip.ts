import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { EXCHANGE_MAX_BYTES, ExchangeError, tooLarge } from './errors';
import { isSafeMemberName } from './names';

/**
 * A strict store-mode ZIP for exchange files. Exchange files stay under 2 GB, so the classic
 * 32-bit records are enough and ZIP64 is never written; the reader refuses anything else.
 *
 * The reader trusts nothing: every member name must be one an exchange file may carry, names are
 * unique, no member is a link, members do not overlap, and no declared size reaches past the
 * file. Each refusal has its own exact message.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const LOCAL_BYTES = 30;
const CENTRAL_BYTES = 46;
const EOCD_BYTES = 22;
const FLAG_UTF8 = 0x0800;
const MADE_BY_UNIX = 3;
const MAX_MEMBERS = 200_000;
const CHUNK = 1024 * 1024;

export type ZipMember =
  { name: string; data: Uint8Array } | { name: string; file: string; size: number };

export interface ZipWriteProgress {
  done: number;
  total: number;
  current?: string;
}

const sizeOf = (m: ZipMember) => ('data' in m ? m.data.length : m.size);

function dosStamp(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Write members into a store-mode ZIP at `out` (through `<out>.partial`, renamed when complete,
 * so a failed or cancelled run leaves nothing). Each file member is hashed on the way:
 * `onHashed(name, sha256)` lets the caller check a blob still has the hash it was registered with.
 */
export async function writeExchangeZip(
  out: string,
  members: readonly ZipMember[],
  opts: {
    now?: Date;
    signal?: AbortSignal;
    onProgress?: (p: ZipWriteProgress) => void;
    onHashed?: (name: string, sha256: string) => void;
  } = {},
): Promise<{ bytes: number }> {
  const names = new Set<string>();
  for (const m of members) {
    if (!isSafeMemberName(m.name) || names.has(m.name)) {
      throw new ExchangeError('hostile', `Not a member an exchange file may carry: ${m.name}`);
    }
    names.add(m.name);
  }
  const overhead = members.reduce(
    (n, m) => n + LOCAL_BYTES + CENTRAL_BYTES + 2 * Buffer.byteLength(m.name),
    EOCD_BYTES,
  );
  const total = members.reduce((n, m) => n + sizeOf(m), 0);
  if (total + overhead > EXCHANGE_MAX_BYTES) throw tooLarge(total + overhead);

  const { time, date } = dosStamp(opts.now ?? new Date());
  const partial = `${out}.partial`;
  let fh: FileHandle | null = await open(partial, 'w');
  let pos = 0;
  let done = 0;
  const put = async (buf: Uint8Array) => {
    if (!fh) throw new Error('archive closed');
    let w = 0;
    while (w < buf.length) {
      const { bytesWritten } = await fh.write(buf, w, buf.length - w, pos + w);
      w += bytesWritten;
    }
    pos += buf.length;
  };
  const central: Buffer[] = [];
  try {
    for (const m of members) {
      if (opts.signal?.aborted) throw new ExchangeError('damaged', 'Export cancelled.');
      const name = Buffer.from(m.name, 'utf8');
      const size = sizeOf(m);
      const offset = pos;
      const local = Buffer.alloc(LOCAL_BYTES);
      local.writeUInt32LE(SIG_LOCAL, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(FLAG_UTF8, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      await put(Buffer.concat([local, name]));
      let crc = 0;
      let written = 0;
      const hash = createHash('sha256');
      const emit = async (chunk: Uint8Array) => {
        crc = crc32(chunk, crc);
        hash.update(chunk);
        await put(chunk);
        written += chunk.length;
        done += chunk.length;
      };
      if ('data' in m) {
        for (let at = 0; at < m.data.length; at += CHUNK) {
          await emit(m.data.subarray(at, Math.min(at + CHUNK, m.data.length)));
        }
      } else {
        const stream = createReadStream(m.file, { highWaterMark: CHUNK });
        try {
          for await (const chunk of stream) {
            if (opts.signal?.aborted) throw new ExchangeError('damaged', 'Export cancelled.');
            await emit(chunk as Buffer);
            opts.onProgress?.({ done, total, current: m.name });
          }
        } finally {
          stream.destroy();
        }
        opts.onHashed?.(m.name, hash.digest('hex'));
      }
      if (written !== size) {
        throw new ExchangeError(
          'damaged',
          `${m.name} changed while the exchange file was written. Close any program writing to the project and export again.`,
        );
      }
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32LE(crc >>> 0, 0);
      await fh.write(crcBuf, 0, 4, offset + 14);
      const c = Buffer.alloc(CENTRAL_BYTES);
      c.writeUInt32LE(SIG_CENTRAL, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(FLAG_UTF8, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc >>> 0, 16);
      c.writeUInt32LE(size, 20);
      c.writeUInt32LE(size, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([c, name]));
      opts.onProgress?.({ done, total, current: m.name });
    }
    const cdOffset = pos;
    for (const c of central) await put(c);
    const eocd = Buffer.alloc(EOCD_BYTES);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(members.length, 8);
    eocd.writeUInt16LE(members.length, 10);
    eocd.writeUInt32LE(pos - cdOffset, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    await put(eocd);
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(partial, out);
    return { bytes: pos };
  } catch (e) {
    if (fh) await fh.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw e;
  }
}

export interface ExchangeZipEntry {
  name: string;
  size: number;
  crc32: number;
  /** Offset of the member's first data byte. */
  dataOffset: number;
}

export interface ExchangeZip {
  readonly file: string;
  readonly bytes: number;
  readonly entries: ReadonlyMap<string, ExchangeZipEntry>;
  /** A whole member, CRC checked. Refuses members over `max` bytes (default 256 MB). */
  read(name: string, max?: number): Promise<Buffer>;
  /** Stream a member through `sink` chunk by chunk, CRC checked at the end; returns its SHA-256. */
  pipe(name: string, sink: (chunk: Buffer) => Promise<void> | void): Promise<string>;
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

const damaged = (why: string) =>
  new ExchangeError(
    'damaged',
    `The exchange file is damaged or incomplete (${why}). Copy it again or ask for a new one.`,
  );
const hostile = (why: string) =>
  new ExchangeError('hostile', `The exchange file was refused: ${why}.`);

/** Open and check an exchange ZIP. Nothing is unpacked; members are read in place. */
export async function openExchangeZip(file: string): Promise<ExchangeZip> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new ExchangeError('not-exchange', `The exchange file could not be read: ${file}`);
  }
  if (size > EXCHANGE_MAX_BYTES) throw tooLarge(size);
  const fh = await open(file, 'r');
  try {
    if (size < EOCD_BYTES) throw notZip();
    const head = await readAt(fh, 0, 4);
    if (head.readUInt32LE(0) !== SIG_LOCAL) throw notZip();
    const tailLen = Math.min(size, EOCD_BYTES + 0xffff);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - EOCD_BYTES; i >= 0; i--) {
      if (
        tail.readUInt32LE(i) === SIG_EOCD &&
        i + EOCD_BYTES + tail.readUInt16LE(i + 20) === tail.length
      ) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw damaged('no central directory at the end');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const eocdAt = size - tailLen + eocd;
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw hostile('it uses ZIP64 records, which exchange files never need');
    }
    if (tail.readUInt16LE(eocd + 8) !== count) throw hostile('it spans several disks');
    if (cdOffset + cdSize > eocdAt) throw damaged('the central directory is cut short');
    if (count > MAX_MEMBERS) throw hostile(`it lists ${count} members`);
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = new Map<string, ExchangeZipEntry>();
    const spans: { start: number; end: number; name: string }[] = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + CENTRAL_BYTES > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
        throw damaged('the central directory is cut short');
      }
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const offset = cd.readUInt32LE(p + 42);
      if (p + CENTRAL_BYTES + nlen + xlen + clen > cd.length) {
        throw damaged('the central directory is cut short');
      }
      const name = cd.subarray(p + CENTRAL_BYTES, p + CENTRAL_BYTES + nlen).toString('utf8');
      p += CENTRAL_BYTES + nlen + xlen + clen;
      if (name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
        throw hostile(`the member ${JSON.stringify(name)} points outside the file`);
      }
      if (madeBy === MADE_BY_UNIX && ((external >>> 16) & 0o170000) === 0o120000) {
        throw hostile(`the member ${JSON.stringify(name)} is a link`);
      }
      if (!isSafeMemberName(name)) {
        throw hostile(`${JSON.stringify(name)} is not a member an exchange file may carry`);
      }
      if (entries.has(name)) throw hostile(`the member ${name} appears twice`);
      if ((flags & 1) !== 0 || method !== 0 || csize !== usize) {
        throw hostile(`the member ${name} is compressed or encrypted inside the archive`);
      }
      if (offset + LOCAL_BYTES + nlen + csize > cdOffset) {
        throw hostile(`the member ${name} declares more bytes than the file holds`);
      }
      const local = await readAt(fh, offset, LOCAL_BYTES);
      if (local.length < LOCAL_BYTES || local.readUInt32LE(0) !== SIG_LOCAL) {
        throw damaged(`no local header for ${name}`);
      }
      const lnlen = local.readUInt16LE(26);
      const lxlen = local.readUInt16LE(28);
      const lname = (await readAt(fh, offset + LOCAL_BYTES, lnlen)).toString('utf8');
      if (lname !== name) throw hostile(`the member ${name} has a different local name`);
      const dataOffset = offset + LOCAL_BYTES + lnlen + lxlen;
      if (dataOffset + csize > cdOffset) {
        throw hostile(`the member ${name} declares more bytes than the file holds`);
      }
      entries.set(name, { name, size: usize, crc32: crc, dataOffset });
      spans.push({ start: offset, end: dataOffset + csize, name });
    }
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      const a = spans[i - 1];
      const b = spans[i];
      if (a && b && b.start < a.end) throw hostile(`the members ${a.name} and ${b.name} overlap`);
    }
    return new Zip(file, size, entries);
  } finally {
    await fh.close();
  }
}

function notZip(): ExchangeError {
  return new ExchangeError(
    'not-exchange',
    'This is not an exchange file. Choose a .aiosync file exported by Stratlas.',
  );
}

class Zip implements ExchangeZip {
  constructor(
    readonly file: string,
    readonly bytes: number,
    readonly entries: ReadonlyMap<string, ExchangeZipEntry>,
  ) {}

  private entry(name: string): ExchangeZipEntry {
    const e = this.entries.get(name);
    if (!e) throw damaged(`${name} is missing`);
    return e;
  }

  async read(name: string, max = 256 * 1024 * 1024): Promise<Buffer> {
    const e = this.entry(name);
    if (e.size > max) throw hostile(`the member ${name} is too large to read`);
    const fh = await open(this.file, 'r');
    try {
      const buf = await readAt(fh, e.dataOffset, e.size);
      if (buf.length !== e.size) throw damaged(`${name} is cut short`);
      if (crc32(buf) >>> 0 !== e.crc32) throw damaged(`${name} does not match its checksum`);
      return buf;
    } finally {
      await fh.close();
    }
  }

  async pipe(name: string, sink: (chunk: Buffer) => Promise<void> | void): Promise<string> {
    const e = this.entry(name);
    const hash = createHash('sha256');
    let crc = 0;
    let got = 0;
    if (e.size > 0) {
      const stream = createReadStream(this.file, {
        start: e.dataOffset,
        end: e.dataOffset + e.size - 1,
        highWaterMark: CHUNK,
      });
      try {
        for await (const chunk of stream) {
          const b = chunk as Buffer;
          crc = crc32(b, crc);
          hash.update(b);
          got += b.length;
          await sink(b);
        }
      } finally {
        stream.destroy();
      }
    }
    if (got !== e.size) throw damaged(`${name} is cut short`);
    if (crc >>> 0 !== e.crc32) throw damaged(`${name} does not match its checksum`);
    return hash.digest('hex');
  }
}
