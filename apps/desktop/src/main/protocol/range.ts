/** Inclusive byte range, as in `Content-Range: bytes start-end/size`. */
export interface ByteRange {
  start: number;
  end: number;
}

const SINGLE = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i;

/**
 * Parse an HTTP Range header for a file of `size` bytes (RFC 9110 section 14).
 *
 * - `null`: no usable range, serve the whole file with 200. Malformed and multi-range headers
 *   land here, which the RFC allows (a server may ignore Range).
 * - `'unsatisfiable'`: answer 416 with `Content-Range: bytes * /size`.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (header === null) return null;
  const m = SINGLE.exec(header.trim());
  if (!m) return null;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;

  if (a === '') {
    // Suffix range: the last N bytes.
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(a);
  const end = b === '' ? size - 1 : Number(b);
  if (b !== '' && end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}
