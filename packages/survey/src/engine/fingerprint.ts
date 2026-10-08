/**
 * Result fingerprints (data-conventions section 26): SHA-256 of the canonical JSON of every input
 * of a comparison, computed the same way by the Python core (`canonical` in `survey/compare.py`),
 * so a result from either executor is current for the other.
 *
 * Canonical JSON: keys sorted, no spaces, `undefined` members left out, integers (below 2^53) as
 * integers and every other number as `Number.prototype.toExponential()` (shortest digits).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined };

function num(x: number): string {
  if (!Number.isFinite(x)) throw new Error('A fingerprint holds finite numbers only.');
  if (Number.isInteger(x) && Math.abs(x) < 2 ** 53) return String(x === 0 ? 0 : x);
  return x.toExponential();
}

export function canonical(v: Json): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k] ?? null)}`).join(',')}}`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
