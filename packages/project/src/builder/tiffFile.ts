import { open } from 'node:fs/promises';
import { readTiffHeader, type TiffHeader } from './tiff';

/** How much of the start of a file is read for its header. */
const HEAD_BYTES = 64 * 1024;
/** The tags a header is made of: width, height, bits, compression, samples. */
const HEADER_TAGS = new Set([256, 257, 258, 259, 277]);
/** Bytes per value of the types those tags come in (SHORT, LONG); anything else counts as 1. */
const VALUE_BYTES: Record<number, number> = { 3: 2, 4: 4 };

/**
 * Size and layout of a TIFF file without decoding it, wherever its directory lies. A file whose
 * directory is in its first 64 KB is read exactly as `readTiffHeader` reads that start. libtiff
 * (most scanner software and image tools) writes the directory after the image data: megabytes
 * into the file, where reading it from the start alone failed with a range error. For such a file
 * the directory and the few values a header needs are read where they are (a few bounded reads,
 * never the image) and handed to the same reader as a small TIFF of their own.
 */
export async function readTiffHeaderFile(file: string): Promise<TiffHeader> {
  const fh = await open(file, 'r');
  try {
    const read = async (at: number, bytes: number): Promise<Uint8Array> => {
      const b = new Uint8Array(bytes);
      const r = await fh.read(b, 0, bytes, at);
      return b.subarray(0, r.bytesRead);
    };
    const head = await read(0, HEAD_BYTES);
    if (head.length < 8) throw new Error('Not a TIFF file.');
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const order = v.getUint16(0);
    const le = order === 0x4949;
    // not a classic TIFF (BigTIFF, or no TIFF at all): the reader says which
    if ((order !== 0x4949 && order !== 0x4d4d) || v.getUint16(2, le) !== 42)
      return readTiffHeader(head);
    const at = v.getUint32(4, le);
    if (at + 2 <= head.length && at + 2 + v.getUint16(at, le) * 12 <= head.length)
      return readTiffHeader(head);

    const cut = 'The TIFF is cut short: its directory is missing.';
    const count = await read(at, 2);
    if (count.length < 2) throw new Error(cut);
    const n = new DataView(count.buffer, count.byteOffset, 2).getUint16(0, le);
    const dir = await read(at + 2, n * 12);
    if (dir.length < n * 12) throw new Error(cut);
    const d = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const kept: { entry: Uint8Array; value: Uint8Array | null }[] = [];
    for (let i = 0; i < n; i++) {
      const e = i * 12;
      if (!HEADER_TAGS.has(d.getUint16(e, le))) continue;
      const size = (VALUE_BYTES[d.getUint16(e + 2, le)] ?? 1) * d.getUint32(e + 4, le);
      // a value over four bytes lies elsewhere in the file (bits per sample of a colour image)
      const value = size > 4 && size <= 64 ? await read(d.getUint32(e + 8, le), size) : null;
      kept.push({ entry: dir.slice(e, e + 12), value });
    }
    // a small TIFF of its own: the file header, the kept entries, then their values
    const valuesAt = 8 + 2 + kept.length * 12 + 4;
    const out = new Uint8Array(valuesAt + kept.reduce((sum, k) => sum + (k.value?.length ?? 0), 0));
    const o = new DataView(out.buffer);
    out.set(head.subarray(0, 4));
    o.setUint32(4, 8, le);
    o.setUint16(8, kept.length, le);
    let next = valuesAt;
    kept.forEach((k, i) => {
      const e = 10 + i * 12;
      out.set(k.entry, e);
      if (!k.value) return;
      o.setUint32(e + 8, next, le);
      out.set(k.value, next);
      next += k.value.length;
    });
    return readTiffHeader(out);
  } finally {
    await fh.close();
  }
}
