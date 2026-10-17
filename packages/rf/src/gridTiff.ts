/**
 * The one TIFF layout a coverage run writes (python `rf/pipeline.py` `write_grid`): a classic TIFF,
 * one band, uncompressed, stripped, with the GeoTIFF tiepoint, pixel scale and GeoKey directory
 * and the GDAL nodata tag. It also reads 8, 16 and 32 bit integers and 64 bit floats, which a
 * composite grid such as best server may use.
 *
 * It takes bytes, not a Node Buffer, so main (exports) and the renderer (the coverage layer) read
 * a run's grids the same way.
 */

export interface GridTiff {
  width: number;
  height: number;
  data: Float32Array;
  /** The projected CRS code from the GeoKey directory, when there is one. */
  epsg: number | null;
  /** Top left corner, when the file has a tiepoint. */
  origin: [number, number] | null;
  pixelSize: [number, number] | null;
  nodata: number | null;
}

const TAG = {
  width: 256,
  height: 257,
  bits: 258,
  compression: 259,
  stripOffsets: 273,
  samples: 277,
  rowsPerStrip: 278,
  stripBytes: 279,
  sampleFormat: 339,
  pixelScale: 33550,
  tiepoint: 33922,
  geoKeys: 34735,
  nodata: 42113,
} as const;
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

const latin1 = (b: Uint8Array, from: number, to: number): string => {
  let s = '';
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
};

/** Read the single band of an uncompressed classic TIFF (see the file comment). */
export function readGridTiff(bytes: Uint8Array): GridTiff {
  if (bytes.length < 16) throw new Error('This is not a TIFF file.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = latin1(bytes, 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') throw new Error('This is not a TIFF file.');
  const u16 = (p: number): number => dv.getUint16(p, le);
  const u32 = (p: number): number => dv.getUint32(p, le);
  if (u16(2) !== 42) throw new Error('This is not a classic TIFF file (BigTIFF is not read).');
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = new Map<number, { type: number; count: number; at: number }>();
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const type = u16(p + 2);
    const count = u32(p + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    tags.set(u16(p), { type, count, at: size <= 4 ? p + 8 : u32(p + 8) });
  }
  const nums = (tag: number): number[] => {
    const t = tags.get(tag);
    if (!t) return [];
    const out: number[] = [];
    for (let i = 0; i < t.count; i++) {
      const size = TYPE_SIZE[t.type] ?? 1;
      const p = t.at + i * size;
      if (t.type === SHORT) out.push(u16(p));
      else if (t.type === LONG) out.push(u32(p));
      else if (t.type === DOUBLE) out.push(dv.getFloat64(p, le));
    }
    return out;
  };
  const one = (tag: number, fallback?: number): number => {
    const v = nums(tag)[0] ?? fallback;
    if (v === undefined) throw new Error(`The TIFF has no tag ${String(tag)}.`);
    return v;
  };
  const width = one(TAG.width);
  const height = one(TAG.height);
  if (one(TAG.compression, 1) !== 1) throw new Error('Only uncompressed TIFF grids are read.');
  if (one(TAG.samples, 1) !== 1) throw new Error('Only single band TIFF grids are read.');
  const bits = one(TAG.bits, 1);
  const format = one(TAG.sampleFormat, 1);
  // tiles (tags 322 to 325) or no strips at all: the pixels would read as zeros, so refuse
  if (
    tags.has(322) ||
    tags.has(323) ||
    tags.has(324) ||
    tags.has(325) ||
    !tags.has(TAG.stripOffsets)
  )
    throw new Error(
      'This TIFF is tiled, which is not read. Save the grid as a stripped, uncompressed TIFF (GDAL: -co TILED=NO -co COMPRESS=NONE).',
    );
  const offsets = nums(TAG.stripOffsets);
  const counts = nums(TAG.stripBytes);
  const rowsPerStrip = one(TAG.rowsPerStrip, height);
  const bytesPer = bits / 8;
  const data = new Float32Array(width * height);
  const sample = (p: number): number => {
    if (format === 3) {
      if (bits === 32) return dv.getFloat32(p, le);
      if (bits === 64) return dv.getFloat64(p, le);
    } else if (format === 2) {
      if (bits === 8) return dv.getInt8(p);
      if (bits === 16) return dv.getInt16(p, le);
      if (bits === 32) return dv.getInt32(p, le);
    } else if (format === 1) {
      if (bits === 8) return dv.getUint8(p);
      if (bits === 16) return u16(p);
      if (bits === 32) return u32(p);
    }
    throw new Error(`A ${String(bits)} bit sample of format ${String(format)} is not read.`);
  };
  offsets.forEach((start, s) => {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    const len = Math.min(counts[s] ?? rows * width * bytesPer, rows * width * bytesPer);
    if (start + len > bytes.length) throw new Error('The TIFF is cut short.');
    const base = s * rowsPerStrip * width;
    for (let i = 0; i < len / bytesPer; i++) data[base + i] = sample(start + i * bytesPer);
  });

  const keys = nums(TAG.geoKeys);
  let epsg: number | null = null;
  for (let i = 4; i + 3 < keys.length; i += 4)
    if (keys[i] === 3072 && keys[i + 1] === 0) epsg = keys[i + 3] ?? null;
  const scale = nums(TAG.pixelScale);
  const tie = nums(TAG.tiepoint);
  const nd = tags.get(TAG.nodata);
  const ndText = nd ? latin1(bytes, nd.at, nd.at + nd.count).replace(/\0+$/, '') : '';
  const ndValue = ndText === '' ? null : Number(ndText);
  return {
    width,
    height,
    data,
    epsg,
    origin: tie.length >= 6 ? [tie[3] ?? 0, tie[4] ?? 0] : null,
    pixelSize: scale.length >= 2 ? [scale[0] ?? 0, scale[1] ?? 0] : null,
    nodata: ndValue !== null && Number.isFinite(ndValue) ? ndValue : null,
  };
}
