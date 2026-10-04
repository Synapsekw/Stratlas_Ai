import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';

/**
 * WinZip AES (AE-2) for ZIP members, AES-256:
 * - keys: PBKDF2-HMAC-SHA1(passphrase, 16-byte salt, 1000 rounds) gives 32 bytes AES key,
 *   32 bytes HMAC key and a 2-byte passphrase check;
 * - data: AES in counter mode with a little-endian counter starting at 1, so any byte range
 *   decrypts on its own (members stay range-readable);
 * - authentication: the first 10 bytes of HMAC-SHA1 over the ciphertext.
 * Member layout: salt (16) | check (2) | ciphertext | auth (10).
 */
export const AES_SALT_BYTES = 16;
export const AES_CHECK_BYTES = 2;
export const AES_AUTH_BYTES = 10;
/** Bytes an encrypted member adds to its stored size. */
export const AES_OVERHEAD = AES_SALT_BYTES + AES_CHECK_BYTES + AES_AUTH_BYTES;
const ROUNDS = 1000;
const BLOCK = 16;

export interface AesKeys {
  aesKey: Buffer;
  hmacKey: Buffer;
  check: Buffer;
}

export function deriveAesKeys(passphrase: string, salt: Uint8Array): AesKeys {
  const bytes = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, ROUNDS, 66, 'sha1');
  return {
    aesKey: bytes.subarray(0, 32),
    hmacKey: bytes.subarray(32, 64),
    check: bytes.subarray(64, 66),
  };
}

/**
 * XOR `data` with the AES-CTR keystream that starts at byte `offset` of the member. The same
 * call encrypts and decrypts.
 */
export function aesCtrXor(key: Uint8Array, data: Uint8Array, offset: number): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  if (data.length === 0) return out;
  const first = Math.floor(offset / BLOCK);
  const last = Math.floor((offset + data.length - 1) / BLOCK);
  const blocks = last - first + 1;
  const counters = Buffer.alloc(blocks * BLOCK);
  for (let i = 0; i < blocks; i++) {
    const n = first + i + 1;
    counters.writeUInt32LE(n % 0x1_0000_0000, i * BLOCK);
    counters.writeUInt32LE(Math.floor(n / 0x1_0000_0000), i * BLOCK + 4);
  }
  const ecb = createCipheriv('aes-256-ecb', key, null);
  ecb.setAutoPadding(false);
  const stream = ecb.update(counters);
  const skip = offset - first * BLOCK;
  for (let i = 0; i < data.length; i++) out[i] = (data[i] ?? 0) ^ (stream[i + skip] ?? 0);
  return out;
}

/** Streaming encryptor for one member: feed plaintext in order, then take the auth code. */
export class AesMemberEncryptor {
  private offset = 0;
  private readonly mac: ReturnType<typeof createHmac>;
  constructor(private readonly keys: AesKeys) {
    this.mac = createHmac('sha1', keys.hmacKey);
  }

  update(plain: Uint8Array): Buffer {
    const c = aesCtrXor(this.keys.aesKey, plain, this.offset);
    this.offset += plain.length;
    this.mac.update(c);
    return c;
  }

  auth(): Buffer {
    return this.mac.digest().subarray(0, AES_AUTH_BYTES);
  }
}

/** HMAC-SHA1 auth code of a whole ciphertext, as stored after the member. */
export function aesAuth(hmacKey: Uint8Array, cipher: Uint8Array): Buffer {
  return createHmac('sha1', hmacKey).update(cipher).digest().subarray(0, AES_AUTH_BYTES);
}
