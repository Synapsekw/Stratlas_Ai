/**
 * RFC 8785 JSON Canonicalization Scheme (JCS): object keys sorted by UTF-16 code units, no
 * whitespace, numbers and strings in their ECMAScript `JSON.stringify` form. Every hash in the
 * journal is SHA-256 over this text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON has no NaN or Infinity.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Array.prototype.sort compares UTF-16 code units, as RFC 8785 section 3.2.3 requires.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`Canonical JSON cannot encode a ${typeof value}.`);
}
