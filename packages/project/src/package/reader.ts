import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { crc32 } from 'node:zlib';
import {
  AES_AUTH_BYTES,
  AES_CHECK_BYTES,
  AES_SALT_BYTES,
  aesAuth,
  aesCtrXor,
  deriveAesKeys,
  type AesKeys,
} from './aes';
import {
  CENTRAL_HEADER_BYTES,
  EOCD_BYTES,
  EOCD64_BYTES,
  EXTRA_AES,
  EXTRA_ZIP64,
  FLAG_ENCRYPTED,
  LOCAL_HEADER_BYTES,
  LOCATOR64_BYTES,
  MAX32,
  METHOD_AES,
  METHOD_STORE,
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_EOCD64,
  SIG_LOCAL,
  SIG_LOCATOR64,
} from './format';

/** A package problem a person can act on (damaged file, wrong passphrase, unsupported member). */
export class ZipError extends Error {
  override name = 'ZipError';
}

export interface ZipEntry {
  name: string;
  /** Plain size of the member. */
  size: number;
  /** Bytes stored in the archive (AES adds 28). */
  compressedSize: number;
  crc32: number;
  encrypted: boolean;
  /** Offset of the local header. */
  localOffset: number;
}

export interface ZipArchive {
  readonly file: string;
  readonly sizeBytes: number;
  /** Members are WinZip AES encrypted: call `unlock` before reading. */
  readonly encrypted: boolean;
  readonly unlocked: boolean;
  readonly entries: ReadonlyMap<string, ZipEntry>;
  /** Check the passphrase; true when it opens the archive. */
  unlock(passphrase: string): Promise<boolean>;
  /** Archive offset of the member's first stored content byte (after any AES salt). */
  dataOffset(name: string): Promise<number>;
  /** Whole member, verified (CRC-32, or the AES auth code). */
  read(name: string): Promise<Buffer>;
  /** Bytes `start` to `end` (inclusive) of a member, streamed from the archive in place. */
  stream(name: string, start?: number, end?: number): Promise<Readable>;
  /**
   * Copy a whole member to a new file `dest` (never overwrites), verified on the way: CRC-32
   * for plain members, the AES auth code for encrypted ones. A bad member leaves no file.
   */
  copyTo(name: string, dest: string, o?: CopyOptions): Promise<void>;
}

export interface CopyOptions {
  signal?: AbortSignal;
  /** Bytes of this member copied so far. */
  onBytes?: (done: number) => void;
}

const damaged = (file: string, why: string) =>
  new ZipError(
    `${file} is damaged or incomplete (${why}). Copy the package again or ask for a new one.`,
  );

async function readAt(file: string, position: number, length: number): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await fh.read(buf, done, length - done, position + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return buf.subarray(0, done);
  } finally {
    await fh.close();
  }
}

interface Extras {
  zip64?: Buffer;
  aes?: { strength: number; method: number };
}

function parseExtras(extra: Buffer): Extras {
  const out: Extras = {};
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    const body = extra.subarray(p + 4, p + 4 + len);
    if (id === EXTRA_ZIP64) out.zip64 = body;
    if (id === EXTRA_AES && body.length >= 7) {
      out.aes = { strength: body.readUInt8(4), method: body.readUInt16LE(5) };
    }
    p += 4 + len;
  }
  return out;
}

/** Member names that cannot escape the package or confuse the protocol. */
function safeName(name: string): boolean {
  if (name === '' || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) return false;
  return !name.split('/').some((s) => s === '..' || s === '.');
}

/**
 * Open a store-mode ZIP (ZIP64 aware) and index its central directory. Nothing is unpacked:
 * members are read in place by offset.
 */
export async function openZip(file: string): Promise<ZipArchive> {
  let size: number;
  try {
    const fh = await open(file, 'r');
    try {
      size = (await fh.stat()).size;
    } finally {
      await fh.close();
    }
  } catch (e) {
    throw new ZipError(`Package not found or unreadable: ${file} (${String(e)}).`);
  }
  if (size < EOCD_BYTES) throw new ZipError(`${file} is not a package (too small to be a ZIP).`);

  const tailLen = Math.min(size, EOCD_BYTES + 0xffff);
  const tail = await readAt(file, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - EOCD_BYTES; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    const head = await readAt(file, 0, 4);
    if (head.length === 4 && head.readUInt32LE(0) === SIG_LOCAL) {
      throw damaged(file, 'no end of central directory');
    }
    throw new ZipError(`${file} is not a package (no ZIP directory found).`);
  }
  let entriesCount = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  const eocdAbs = size - tailLen + eocd;

  if (entriesCount === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
    const locPos = eocdAbs - LOCATOR64_BYTES;
    const loc = locPos >= 0 ? await readAt(file, locPos, LOCATOR64_BYTES) : Buffer.alloc(0);
    if (loc.length < LOCATOR64_BYTES || loc.readUInt32LE(0) !== SIG_LOCATOR64) {
      throw damaged(file, 'missing ZIP64 locator');
    }
    const e64Pos = Number(loc.readBigUInt64LE(8));
    const e64 = await readAt(file, e64Pos, EOCD64_BYTES);
    if (e64.length < EOCD64_BYTES || e64.readUInt32LE(0) !== SIG_EOCD64) {
      throw damaged(file, 'missing ZIP64 end record');
    }
    entriesCount = Number(e64.readBigUInt64LE(32));
    cdSize = Number(e64.readBigUInt64LE(40));
    cdOffset = Number(e64.readBigUInt64LE(48));
  }
  if (cdOffset + cdSize > size) throw damaged(file, 'directory past the end of the file');

  const cd = await readAt(file, cdOffset, cdSize);
  const entries = new Map<string, ZipEntry>();
  let p = 0;
  for (let n = 0; n < entriesCount; n++) {
    if (p + CENTRAL_HEADER_BYTES > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
      throw damaged(file, 'broken central directory');
    }
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const extras = parseExtras(cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen));
    if (extras.zip64) {
      let q = 0;
      const next = () => {
        const v = Number(extras.zip64?.readBigUInt64LE(q) ?? 0);
        q += 8;
        return v;
      };
      if (usize === MAX32) usize = next();
      if (csize === MAX32) csize = next();
      if (offset === MAX32) offset = next();
    }
    p += CENTRAL_HEADER_BYTES + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (!safeName(name)) continue;
    const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
    const stored = method === METHOD_STORE && !encrypted;
    const aesStored =
      method === METHOD_AES &&
      encrypted &&
      extras.aes?.method === METHOD_STORE &&
      extras.aes.strength === 3;
    if (!stored && !aesStored) {
      throw new ZipError(
        `${file}: member ${name} is compressed or uses an unsupported encryption. Packages must be written by Quadrion AI (store mode, AES-256).`,
      );
    }
    entries.set(name, {
      name,
      size: usize,
      compressedSize: csize,
      crc32: crc,
      encrypted,
      localOffset: offset,
    });
  }

  const encrypted = [...entries.values()].some((e) => e.encrypted);
  return new Archive(file, size, entries, encrypted);
}

class Archive implements ZipArchive {
  private passphrase: string | null = null;
  private readonly starts = new Map<string, number>();
  private readonly keys = new Map<string, Promise<AesKeys>>();

  constructor(
    readonly file: string,
    readonly sizeBytes: number,
    readonly entries: ReadonlyMap<string, ZipEntry>,
    readonly encrypted: boolean,
  ) {}

  get unlocked(): boolean {
    return !this.encrypted || this.passphrase !== null;
  }

  private entry(name: string): ZipEntry {
    const e = this.entries.get(name);
    if (!e) throw new ZipError(`${name} is not in the package ${this.file}.`);
    return e;
  }

  /** Offset of the member's stored bytes (salt first for AES). */
  private async memberStart(e: ZipEntry): Promise<number> {
    const known = this.starts.get(e.name);
    if (known !== undefined) return known;
    const h = await readAt(this.file, e.localOffset, LOCAL_HEADER_BYTES);
    if (h.length < LOCAL_HEADER_BYTES || h.readUInt32LE(0) !== SIG_LOCAL) {
      throw damaged(this.file, `bad local header for ${e.name}`);
    }
    const start = e.localOffset + LOCAL_HEADER_BYTES + h.readUInt16LE(26) + h.readUInt16LE(28);
    if (start + e.compressedSize > this.sizeBytes) {
      throw damaged(this.file, `${e.name} runs past the end of the file`);
    }
    this.starts.set(e.name, start);
    return start;
  }

  private keysFor(e: ZipEntry, passphrase: string): Promise<AesKeys> {
    const cached = this.keys.get(e.name);
    if (cached) return cached;
    const p = (async () => {
      const start = await this.memberStart(e);
      const head = await readAt(this.file, start, AES_SALT_BYTES + AES_CHECK_BYTES);
      const keys = deriveAesKeys(passphrase, head.subarray(0, AES_SALT_BYTES));
      if (!keys.check.equals(head.subarray(AES_SALT_BYTES))) {
        throw new ZipError('The passphrase does not open this package.');
      }
      return keys;
    })();
    this.keys.set(e.name, p);
    p.catch(() => this.keys.delete(e.name));
    return p;
  }

  private requireKeys(e: ZipEntry): Promise<AesKeys> {
    if (this.passphrase === null) {
      throw new ZipError('This package is encrypted. Enter its passphrase to open it.');
    }
    return this.keysFor(e, this.passphrase);
  }

  async unlock(passphrase: string): Promise<boolean> {
    if (!this.encrypted) return true;
    // Verify on the smallest encrypted member: check value and full auth code.
    const probe = [...this.entries.values()]
      .filter((e) => e.encrypted)
      .sort((a, b) => a.size - b.size)[0];
    if (!probe) return true;
    this.keys.delete(probe.name);
    try {
      const keys = await this.keysFor(probe, passphrase);
      const start = await this.memberStart(probe);
      const body = await readAt(
        this.file,
        start + AES_SALT_BYTES + AES_CHECK_BYTES,
        probe.size + AES_AUTH_BYTES,
      );
      if (!aesAuth(keys.hmacKey, body.subarray(0, probe.size)).equals(body.subarray(probe.size))) {
        this.keys.delete(probe.name);
        return false;
      }
    } catch (e) {
      this.keys.delete(probe.name);
      if (e instanceof ZipError) return false;
      throw e;
    }
    this.passphrase = passphrase;
    return true;
  }

  async dataOffset(name: string): Promise<number> {
    const e = this.entry(name);
    const start = await this.memberStart(e);
    return e.encrypted ? start + AES_SALT_BYTES + AES_CHECK_BYTES : start;
  }

  async read(name: string): Promise<Buffer> {
    const e = this.entry(name);
    const at = await this.dataOffset(name);
    if (!e.encrypted) {
      const data = await readAt(this.file, at, e.size);
      if (data.length !== e.size || (e.size > 0 && crc32(data) >>> 0 !== e.crc32 >>> 0)) {
        throw damaged(this.file, `${name} failed its checksum`);
      }
      return data;
    }
    const keys = await this.requireKeys(e);
    const body = await readAt(this.file, at, e.size + AES_AUTH_BYTES);
    const cipher = body.subarray(0, e.size);
    if (!aesAuth(keys.hmacKey, cipher).equals(body.subarray(e.size))) {
      throw new ZipError(
        `${name} in ${this.file} is damaged or was altered (authentication failed).`,
      );
    }
    return aesCtrXor(keys.aesKey, cipher, 0);
  }

  async copyTo(name: string, dest: string, o: CopyOptions = {}): Promise<void> {
    const e = this.entry(name);
    const at = await this.dataOffset(name);
    const keys = e.encrypted ? await this.requireKeys(e) : null;
    const mac = keys ? createHmac('sha1', keys.hmacKey) : null;
    const out = await open(dest, 'wx');
    let ok = false;
    try {
      let crc = 0;
      let done = 0;
      if (e.size > 0) {
        const raw = createReadStream(this.file, {
          start: at,
          end: at + e.size - 1,
          highWaterMark: 4 * 1024 * 1024,
        });
        try {
          for await (const chunk of raw) {
            if (o.signal?.aborted) {
              const err = new Error('Cancelled');
              err.name = 'AbortError';
              throw err;
            }
            const c = chunk as Buffer;
            let plain = c;
            if (keys && mac) {
              mac.update(c);
              plain = aesCtrXor(keys.aesKey, c, done);
            } else crc = crc32(c, crc);
            let w = 0;
            while (w < plain.length) {
              const { bytesWritten } = await out.write(plain, w, plain.length - w, done + w);
              w += bytesWritten;
            }
            done += c.length;
            o.onBytes?.(done);
          }
        } finally {
          raw.destroy();
        }
      }
      if (done !== e.size) throw damaged(this.file, `${name} is cut short`);
      if (keys && mac) {
        const stored = await readAt(this.file, at + e.size, AES_AUTH_BYTES);
        if (!mac.digest().subarray(0, AES_AUTH_BYTES).equals(stored)) {
          throw new ZipError(
            `${name} in ${this.file} is damaged or was altered (authentication failed).`,
          );
        }
      } else if (e.size > 0 && crc >>> 0 !== e.crc32 >>> 0) {
        throw damaged(this.file, `${name} failed its checksum`);
      }
      ok = true;
    } finally {
      await out.close();
      if (!ok) await rm(dest, { force: true });
    }
  }

  async stream(name: string, start = 0, end?: number): Promise<Readable> {
    const e = this.entry(name);
    const last = Math.min(end ?? e.size - 1, e.size - 1);
    if (e.size === 0 || last < start) return Readable.from([]);
    const at = await this.dataOffset(name);
    const raw = createReadStream(this.file, {
      start: at + start,
      end: at + last,
      highWaterMark: 1024 * 1024,
    });
    if (!e.encrypted) return raw;
    const keys = await this.requireKeys(e);
    let offset = start;
    const decrypt = new Transform({
      transform(chunk: Buffer, _enc, done) {
        const plain = aesCtrXor(keys.aesKey, chunk, offset);
        offset += chunk.length;
        done(null, plain);
      },
    });
    raw.on('error', (err) => decrypt.destroy(err));
    decrypt.on('close', () => raw.destroy());
    return raw.pipe(decrypt);
  }
}
