import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  type ScryptOptions,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import { EXCHANGE_MAX_BYTES, ExchangeError, tooLarge } from './errors';

/**
 * Passphrase encryption of a whole exchange file (decision 9): AES-256-GCM with a key from scrypt,
 * through `node:crypto` only. The archive is cut into chunks, each sealed on its own (the STREAM
 * construction), so a file of any size encrypts and decrypts in constant memory, and a reordered,
 * cut or extended file is refused. Nothing but the size shows from outside: not the sender, the
 * team, the member names or the blob hashes.
 *
 * Layout: one JSON line (`aio.exchange-enc/1`: scrypt parameters, salt, nonce prefix, chunk size),
 * then for each chunk its ciphertext and a 16-byte tag. Chunk nonce: the 7-byte prefix, the chunk
 * number (4 bytes, big endian), then 1 on the last chunk and 0 before. The header line is the
 * additional data of every chunk, so its parameters cannot be swapped.
 */

export const ENVELOPE_SCHEMA = 'aio.exchange-enc/1' as const;
const MAGIC = Buffer.from(`{"schema":"${ENVELOPE_SCHEMA}"`, 'utf8');
const TAG = 16;
const MAX_HEADER = 1024;

export interface ScryptParams {
  /** CPU and memory cost, a power of two. */
  N: number;
  r: number;
  p: number;
}

/** About 128 MB and a third of a second on a laptop: costly to guess, quick for a person. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const DEFAULT_CHUNK = 1024 * 1024;

interface EnvelopeHeader extends ScryptParams {
  schema: typeof ENVELOPE_SCHEMA;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  salt: string;
  nonce: string;
  chunk: number;
}

function deriveKey(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r + 32 * 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scryptCb(passphrase.normalize('NFC'), salt, 32, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function nonceFor(prefix: Buffer, n: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0, 0, 7);
  nonce.writeUInt32BE(n, 7);
  nonce[11] = last ? 1 : 0;
  return nonce;
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

/** Does this file start like an encrypted exchange file? */
export async function isEncryptedExchange(file: string): Promise<boolean> {
  const fh = await open(file, 'r');
  try {
    const head = await readAt(fh, 0, MAGIC.length);
    return head.equals(MAGIC);
  } finally {
    await fh.close();
  }
}

/** Encrypt `src` (a plain exchange ZIP) into `dest` through `<dest>.partial`. */
export async function encryptExchange(
  src: string,
  dest: string,
  passphrase: string,
  opts: { scrypt?: ScryptParams; chunk?: number } = {},
): Promise<{ bytes: number }> {
  const params = opts.scrypt ?? DEFAULT_SCRYPT;
  const chunk = opts.chunk ?? DEFAULT_CHUNK;
  const salt = randomBytes(16);
  const prefix = randomBytes(7);
  const header: EnvelopeHeader = {
    schema: ENVELOPE_SCHEMA,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    N: params.N,
    r: params.r,
    p: params.p,
    salt: salt.toString('base64url'),
    nonce: prefix.toString('base64url'),
    chunk,
  };
  const line = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8');
  const key = await deriveKey(passphrase, salt, params);
  const partial = `${dest}.partial`;
  const fh = await open(partial, 'w');
  let pos = 0;
  const put = async (b: Buffer) => {
    let w = 0;
    while (w < b.length) {
      const { bytesWritten } = await fh.write(b, w, b.length - w, pos + w);
      w += bytesWritten;
    }
    pos += b.length;
  };
  try {
    await put(line);
    const seal = async (plain: Buffer, n: number, last: boolean) => {
      const c = createCipheriv('aes-256-gcm', key, nonceFor(prefix, n, last));
      c.setAAD(line);
      await put(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
    };
    // hold one chunk back: only at the end is it known which one is last
    let pending: Buffer = Buffer.alloc(0);
    let n = 0;
    const stream = createReadStream(src, { highWaterMark: chunk });
    try {
      for await (const data of stream) {
        pending = Buffer.concat([pending, data as Buffer]);
        while (pending.length > chunk) {
          await seal(pending.subarray(0, chunk), n++, false);
          pending = pending.subarray(chunk);
        }
      }
    } finally {
      stream.destroy();
    }
    await seal(pending, n, true);
    if (pos > EXCHANGE_MAX_BYTES) throw tooLarge(pos);
    await fh.sync();
    await fh.close();
    await rename(partial, dest);
    return { bytes: pos };
  } catch (e) {
    await fh.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw e;
  }
}

function parseHeader(line: string): EnvelopeHeader {
  let h: Partial<EnvelopeHeader>;
  try {
    h = JSON.parse(line) as Partial<EnvelopeHeader>;
  } catch {
    throw new ExchangeError('damaged', 'The encrypted exchange file is damaged (bad header).');
  }
  const pow2 = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && (n & (n - 1)) === 0;
  const ok =
    h.schema === ENVELOPE_SCHEMA &&
    h.kdf === 'scrypt' &&
    h.cipher === 'aes-256-gcm' &&
    pow2(h.N) &&
    (h.N ?? 0) >= 2 ** 10 &&
    (h.N ?? 0) <= 2 ** 20 &&
    Number.isInteger(h.r) &&
    (h.r ?? 0) >= 1 &&
    (h.r ?? 0) <= 16 &&
    Number.isInteger(h.p) &&
    (h.p ?? 0) >= 1 &&
    (h.p ?? 0) <= 4 &&
    Number.isInteger(h.chunk) &&
    (h.chunk ?? 0) >= 4096 &&
    (h.chunk ?? 0) <= 16 * 1024 * 1024 &&
    typeof h.salt === 'string' &&
    Buffer.from(h.salt, 'base64url').length === 16 &&
    typeof h.nonce === 'string' &&
    Buffer.from(h.nonce, 'base64url').length === 7;
  if (!ok) {
    throw new ExchangeError(
      'not-exchange',
      'This encrypted exchange file uses settings this version does not know. Update the app or ask for a new file.',
    );
  }
  return h as EnvelopeHeader;
}

/**
 * Decrypt `src` into `dest` (a plain exchange ZIP), checking every chunk. A wrong passphrase is
 * found on the first chunk; a cut, reordered or extended file on the chunk where it happens.
 */
export async function decryptExchange(
  src: string,
  dest: string,
  passphrase: string,
): Promise<void> {
  const fh = await open(src, 'r');
  const out = await open(`${dest}.partial`, 'w');
  try {
    const size = (await fh.stat()).size;
    if (size > EXCHANGE_MAX_BYTES) throw tooLarge(size);
    const head = await readAt(fh, 0, Math.min(MAX_HEADER, size));
    const nl = head.indexOf(0x0a);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC) || nl < 0) {
      throw new ExchangeError('not-exchange', 'This is not an encrypted exchange file.');
    }
    const line = head.subarray(0, nl + 1);
    const h = parseHeader(line.toString('utf8'));
    const key = await deriveKey(passphrase, Buffer.from(h.salt, 'base64url'), h);
    const prefix = Buffer.from(h.nonce, 'base64url');
    let pos = line.length;
    let written = 0;
    for (let n = 0; ; n++) {
      if (pos + TAG > size) throw cut();
      const len = Math.min(h.chunk + TAG, size - pos);
      const sealed = await readAt(fh, pos, len);
      pos += len;
      const last = pos === size;
      const d = createDecipheriv('aes-256-gcm', key, nonceFor(prefix, n, last));
      d.setAAD(line);
      d.setAuthTag(sealed.subarray(sealed.length - TAG));
      let plain: Buffer;
      try {
        plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
      } catch {
        if (n === 0) {
          throw new ExchangeError('passphrase', 'The passphrase does not open this exchange file.');
        }
        throw cut();
      }
      await out.write(plain, 0, plain.length, written);
      written += plain.length;
      if (last) break;
    }
    await out.close();
    await rename(`${dest}.partial`, dest);
  } catch (e) {
    await out.close().catch(() => undefined);
    await rm(`${dest}.partial`, { force: true });
    throw e;
  } finally {
    await fh.close();
  }
}

function cut(): ExchangeError {
  return new ExchangeError(
    'damaged',
    'The encrypted exchange file is damaged or incomplete. Copy it again or ask for a new one.',
  );
}
