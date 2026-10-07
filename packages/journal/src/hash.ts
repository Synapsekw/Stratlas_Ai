import { createHash, randomBytes } from 'node:crypto';
import { BASE32_ALPHABET, OP_ID_EXCLUDES } from '@aio/schema';
import { canonicalJson } from './canonical';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 4648 base32, lower case, no padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

/** SHA-256 of the canonical JSON of a value. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** `d_` plus base32 SHA-256 of the raw 32-byte public key. */
export function deviceIdFromKey(rawPublicKey: Uint8Array): string {
  return `d_${base32(createHash('sha256').update(rawPublicKey).digest())}`;
}

/** A random id with a prefix: `a_` (26 letters), `r_`, `cm_`, `ap_`, `x_` (16 letters). */
export function randomId(prefix: string, letters: 16 | 26): string {
  return `${prefix}${base32(randomBytes(Math.ceil((letters * 5) / 8))).slice(0, letters)}`;
}

/** The op id: SHA-256 of the canonical op without `id`, `payload` and `sig`. */
export function opId(op: Record<string, unknown>): string {
  const rest = Object.fromEntries(
    Object.entries(op).filter(([k]) => !(OP_ID_EXCLUDES as readonly string[]).includes(k)),
  );
  return contentHash(rest);
}

/** `ph`: SHA-256 of the canonical payload. */
export function payloadHash(payload: unknown): string {
  return contentHash(payload);
}
