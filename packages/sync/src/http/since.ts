/**
 * The `since` query of `GET /v1/projects/:id/ops`: what the client already has, per chain, small
 * enough for a URL (at most 4096 characters, `PullOpsQuery`). Each chain is named by the first 12
 * base32 letters of the SHA-256 of its id (60 bits) and carries its last seq:
 * `v1~<chain12>.<seq>~...`. The server answers each page with a cursor in the same form, so the
 * next page is simply `since=<cursor>`. A chain left out counts as "nothing yet", which only costs
 * a re-download (ops dedupe by id). The server has its own copy of this format (same test vector).
 */
import { createHash } from 'node:crypto';
import { BASE32_ALPHABET, type Heads } from '@aio/schema';

export const SINCE_VERSION = 'v1';
export const SINCE_MAX_LENGTH = 4096;

/** The short name of a chain in a `since` token. */
export function chainKey(chain: string): string {
  const digest = createHash('sha256').update(chain, 'utf8').digest();
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of digest) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 12) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    if (out.length >= 12) break;
  }
  return out;
}

/** Encode heads as a `since` token; the smallest seqs are dropped first if it would be too long. */
export function encodeSince(heads: Heads): string {
  const entries = Object.entries(heads)
    .filter(([, h]) => h.seq > 0)
    .map(([chain, h]) => ({ key: chainKey(chain), seq: h.seq }))
    .sort((a, b) => b.seq - a.seq || (a.key < b.key ? -1 : 1));
  const parts: string[] = [];
  let length = SINCE_VERSION.length;
  for (const e of entries) {
    const part = `~${e.key}.${e.seq}`;
    if (length + part.length > SINCE_MAX_LENGTH) break;
    parts.push(part);
    length += part.length;
  }
  return SINCE_VERSION + parts.sort().join('');
}

/** Decode a `since` token into chain key to seq; null when it is not one. */
export function decodeSince(token: string): Map<string, number> | null {
  if (token.length > SINCE_MAX_LENGTH || !token.startsWith(SINCE_VERSION)) return null;
  const out = new Map<string, number>();
  const rest = token.slice(SINCE_VERSION.length);
  if (rest === '') return out;
  if (!rest.startsWith('~')) return null;
  for (const part of rest.split('~').slice(1)) {
    const m = /^([a-z2-7]{12})\.([1-9]\d{0,9})$/.exec(part);
    if (!m?.[1] || !m[2]) return null;
    out.set(m[1], Number(m[2]));
  }
  return out;
}
