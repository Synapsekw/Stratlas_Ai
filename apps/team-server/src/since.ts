/**
 * `since` tokens of `GET /v1/projects/:id/ops` (the server's copy of the format in
 * `@aio/sync/http`): `v1~<chain12>.<seq>~...`, a chain named by the first 12 base32 letters of the
 * SHA-256 of its id. Page cursors use the same form, so a cursor is a `since` for the next page.
 */
import { createHash } from 'node:crypto';
import { BASE32_ALPHABET } from '@aio/schema';
import type { SeqByChain } from './store/store';

const MAX = 4096;

export function chainKey(chain: string): string {
  const digest = createHash('sha256').update(chain, 'utf8').digest();
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of digest) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < 12) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    if (out.length >= 12) break;
  }
  return out;
}

export function decodeSince(token: string): Map<string, number> | null {
  if (token.length > MAX || !token.startsWith('v1')) return null;
  const rest = token.slice(2);
  const out = new Map<string, number>();
  if (rest === '') return out;
  if (!rest.startsWith('~')) return null;
  for (const part of rest.split('~').slice(1)) {
    const m = /^([a-z2-7]{12})\.([1-9]\d{0,9})$/.exec(part);
    if (!m?.[1] || !m[2]) return null;
    out.set(m[1], Number(m[2]));
  }
  return out;
}

/** Seq per chain of the server's chains, from a token. */
export function sinceFor(token: Map<string, number>, chains: Iterable<string>): SeqByChain {
  const out: Record<string, number> = {};
  for (const chain of chains) {
    const seq = token.get(chainKey(chain));
    if (seq !== undefined) out[chain] = seq;
  }
  return out;
}

/** The cursor after a page: what the reader had plus what this page gave. */
export function encodeCursor(seqs: SeqByChain): string | null {
  const entries = Object.entries(seqs)
    .filter(([, seq]) => seq > 0)
    .map(([chain, seq]) => ({ key: chainKey(chain), seq }))
    .sort((a, b) => b.seq - a.seq || (a.key < b.key ? -1 : 1));
  const parts: string[] = [];
  let length = 2;
  for (const e of entries) {
    const part = `~${e.key}.${e.seq}`;
    if (length + part.length > MAX) break;
    parts.push(part);
    length += part.length;
  }
  return `v1${parts.sort().join('')}`;
}
