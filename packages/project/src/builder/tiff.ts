import { inflateSync } from 'node:zlib';

/**
 * Small GeoTIFF reader for orthophotos and DSMs that fit in memory: classic TIFF (not BigTIFF),
 * strips or tiles, chunky pixels, no compression, LZW, Deflate or PackBits, horizontal predictor;
 * 8 / 16 bit integers and 32 bit floats. Larger or exotic files go to the pipeline pack.
 */
export interface TiffImage {
  width: number;
  height: number;
  samples: number;
  bits: number;
  format: 'uint' | 'int' | 'float';
  /** Interleaved samples, row by row. */
  data: Uint8Array | Uint16Array | Int16Array | Float32Array;
  nodata?: number;
  geo: TiffGeo;
}

export interface TiffGeo {
  epsg?: number;
  /** ModelPixelScale (sx, sy). */
  pixelScale?: [number, number];
  /** ModelTiepoint: raster (i, j) to model (x, y). */
  tiepoint?: [number, number, number, number];
  /** Row-major 4x4 ModelTransformation. */
  transform?: number[];
  /** RasterPixelIsPoint: the tiepoint names a pixel centre, not its corner. */
  pixelIsPoint: boolean;
}

export interface TiffHeader {
  width: number;
  height: number;
  samples: number;
  bits: number;
  compression: number;
  bigTiff: boolean;
}

type Tags = Map<number, number[] | string>;

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
  16: 8,
};

function readTags(b: Uint8Array): { tags: Tags; le: boolean; bigTiff: boolean } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const order = v.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('Not a TIFF file.');
  const le = order === 0x4949;
  const magic = v.getUint16(2, le);
  if (magic === 43) return { tags: new Map(), le, bigTiff: true };
  if (magic !== 42) throw new Error('Not a TIFF file.');
  const at = v.getUint32(4, le);
  const n = v.getUint16(at, le);
  const tags: Tags = new Map();
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12;
    const tag = v.getUint16(e, le);
    const type = v.getUint16(e + 2, le);
    const count = v.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const p = size <= 4 ? e + 8 : v.getUint32(e + 8, le);
    if (p + size > b.length) continue;
    if (type === 2) {
      tags.set(tag, new TextDecoder().decode(b.subarray(p, p + count)).replace(/\0+$/, ''));
      continue;
    }
    const vals: number[] = [];
    for (let k = 0; k < count; k++) {
      const q = p + k * (TYPE_SIZE[type] ?? 1);
      switch (type) {
        case 1:
        case 7:
          vals.push(v.getUint8(q));
          break;
        case 6:
          vals.push(v.getInt8(q));
          break;
        case 3:
          vals.push(v.getUint16(q, le));
          break;
        case 8:
          vals.push(v.getInt16(q, le));
          break;
        case 4:
          vals.push(v.getUint32(q, le));
          break;
        case 9:
          vals.push(v.getInt32(q, le));
          break;
        case 5:
          vals.push(v.getUint32(q, le) / (v.getUint32(q + 4, le) || 1));
          break;
        case 10:
          vals.push(v.getInt32(q, le) / (v.getInt32(q + 4, le) || 1));
          break;
        case 11:
          vals.push(v.getFloat32(q, le));
          break;
        case 12:
          vals.push(v.getFloat64(q, le));
          break;
        default:
          vals.push(0);
      }
    }
    tags.set(tag, vals);
  }
  return { tags, le, bigTiff: false };
}

const first = (t: Tags, tag: number, d?: number): number | undefined => {
  const v = t.get(tag);
  return Array.isArray(v) ? (v[0] ?? d) : d;
};
const list = (t: Tags, tag: number): number[] => {
  const v = t.get(tag);
  return Array.isArray(v) ? v : [];
};

/** Size and layout from the first IFD, without decoding pixels. */
export function readTiffHeader(b: Uint8Array): TiffHeader {
  const { tags, bigTiff } = readTags(b);
  return {
    width: first(tags, 256, 0) ?? 0,
    height: first(tags, 257, 0) ?? 0,
    samples: first(tags, 277, 1) ?? 1,
    bits: first(tags, 258, 1) ?? 1,
    compression: first(tags, 259, 1) ?? 1,
    bigTiff,
  };
}

/** TIFF LZW (MSB first, early change). */
export function lzwDecode(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let o = 0;
  const dict: Uint8Array[] = [];
  const reset = () => {
    dict.length = 0;
    for (let i = 0; i < 256; i++) dict.push(Uint8Array.of(i));
    dict.push(new Uint8Array(0), new Uint8Array(0));
  };
  reset();
  let bitPos = 0;
  let width = 9;
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = input[(bitPos + i) >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
    }
    bitPos += width;
    return v;
  };
  let prev: Uint8Array | null = null;
  while (bitPos + width <= input.length * 8 && o < expected) {
    const code = read();
    if (code === 257) break;
    if (code === 256) {
      reset();
      width = 9;
      prev = null;
      continue;
    }
    let entry: Uint8Array;
    const known = dict[code];
    if (code < dict.length && known) entry = known;
    else if (prev) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev);
      entry[prev.length] = prev[0] ?? 0;
    } else throw new Error('Corrupt LZW data.');
    out.set(entry.subarray(0, Math.min(entry.length, expected - o)), o);
    o += entry.length;
    if (prev) {
      const next = new Uint8Array(prev.length + 1);
      next.set(prev);
      next[prev.length] = entry[0] ?? 0;
      dict.push(next);
    }
    prev = entry;
    if (dict.length + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}

function packBits(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < input.length && o < expected) {
    const n = ((input[i++] ?? 0) << 24) >> 24;
    if (n >= 0) {
      out.set(input.subarray(i, i + n + 1), o);
      i += n + 1;
      o += n + 1;
    } else if (n !== -128) {
      out.fill(input[i++] ?? 0, o, o - n + 1);
      o += -n + 1;
    }
  }
  return out;
}

function decompress(c: number, data: Uint8Array, expected: number): Uint8Array {
  switch (c) {
    case 1:
      return data;
    case 5:
      return lzwDecode(data, expected);
    case 8:
    case 32946:
      return new Uint8Array(inflateSync(data));
    case 32773:
      return packBits(data, expected);
    default:
      throw new Error(
        `TIFF compression ${String(c)} is not supported here; use the pipeline pack.`,
      );
  }
}

/** Decode a whole (Geo)TIFF into memory. */
export function decodeTiff(b: Uint8Array): TiffImage {
  const { tags, le, bigTiff } = readTags(b);
  if (bigTiff) throw new Error('BigTIFF files are converted by the pipeline pack.');
  const width = first(tags, 256, 0) ?? 0;
  const height = first(tags, 257, 0) ?? 0;
  const samples = first(tags, 277, 1) ?? 1;
  const bits = first(tags, 258, 8) ?? 8;
  const compression = first(tags, 259, 1) ?? 1;
  const planar = first(tags, 284, 1) ?? 1;
  const predictor = first(tags, 317, 1) ?? 1;
  const sf = first(tags, 339, 1) ?? 1;
  if (!width || !height) throw new Error('TIFF has no image size.');
  if (planar !== 1) throw new Error('Planar TIFF layout is converted by the pipeline pack.');
  if (first(tags, 262) === 6) throw new Error('YCbCr TIFF is converted by the pipeline pack.');
  if (![8, 16, 32].includes(bits)) throw new Error(`${String(bits)}-bit TIFF is not supported.`);
  const format: TiffImage['format'] = sf === 3 ? 'float' : sf === 2 ? 'int' : 'uint';
  if (format === 'float' && bits !== 32) throw new Error('Only 32-bit float TIFF is supported.');
  if (predictor === 3) throw new Error('Floating point predictor: use the pipeline pack.');
  const bps = bits / 8;
  const pixel = samples * bps;
  const raw = new Uint8Array(width * height * pixel);

  const tiled = tags.has(322);
  const tw = tiled ? (first(tags, 322) ?? width) : width;
  const rowsPer = tiled ? (first(tags, 323) ?? height) : (first(tags, 278, height) ?? height);
  const offsets = list(tags, tiled ? 324 : 273);
  const counts = list(tags, tiled ? 325 : 279);
  const across = tiled ? Math.ceil(width / tw) : 1;
  offsets.forEach((off, k) => {
    const chunkRows = rowsPer;
    const chunkW = tiled ? tw : width;
    const expected = chunkW * chunkRows * pixel;
    const block = decompress(compression, b.subarray(off, off + (counts[k] ?? 0)), expected);
    const x0 = tiled ? (k % across) * tw : 0;
    const y0 = tiled ? Math.floor(k / across) * rowsPer : k * rowsPer;
    const stride = chunkW * pixel;
    for (let r = 0; r < chunkRows && y0 + r < height; r++) {
      const row = block.subarray(r * stride, (r + 1) * stride);
      if (predictor === 2) {
        const dv = new DataView(row.buffer, row.byteOffset, row.byteLength);
        for (let x = 1; x < chunkW; x++) {
          for (let s = 0; s < samples; s++) {
            const i = (x * samples + s) * bps;
            const j = ((x - 1) * samples + s) * bps;
            if (bps === 1) row[i] = ((row[i] ?? 0) + (row[j] ?? 0)) & 0xff;
            else if (bps === 2)
              dv.setUint16(i, (dv.getUint16(i, le) + dv.getUint16(j, le)) & 0xffff, le);
            else dv.setUint32(i, (dv.getUint32(i, le) + dv.getUint32(j, le)) >>> 0, le);
          }
        }
      }
      const w = Math.min(chunkW, width - x0);
      raw.set(row.subarray(0, w * pixel), ((y0 + r) * width + x0) * pixel);
    }
  });

  const n = width * height * samples;
  const dv = new DataView(raw.buffer);
  let data: TiffImage['data'];
  if (bits === 8) data = raw;
  else if (bits === 16) {
    data = format === 'int' ? new Int16Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++)
      data[i] = format === 'int' ? dv.getInt16(i * 2, le) : dv.getUint16(i * 2, le);
  } else {
    if (format !== 'float') throw new Error('32-bit integer TIFF is not supported.');
    data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = dv.getFloat32(i * 4, le);
  }

  const geo: TiffGeo = { pixelIsPoint: false };
  const scale = list(tags, 33550);
  if (scale.length >= 2) geo.pixelScale = [scale[0] ?? 1, scale[1] ?? 1];
  const tie = list(tags, 33922);
  if (tie.length >= 6) geo.tiepoint = [tie[0] ?? 0, tie[1] ?? 0, tie[3] ?? 0, tie[4] ?? 0];
  const tr = list(tags, 34264);
  if (tr.length === 16) geo.transform = tr;
  const keys = list(tags, 34735);
  for (let i = 4; i + 3 < keys.length; i += 4) {
    const id = keys[i];
    const value = keys[i + 3];
    if (keys[i + 1] !== 0) continue;
    if (value !== undefined && (id === 3072 || (id === 2048 && geo.epsg === undefined)))
      geo.epsg = value;
    if (id === 1025) geo.pixelIsPoint = value === 2;
  }
  const nd = tags.get(42113);
  const img: TiffImage = { width, height, samples, bits, format, data, geo };
  if (typeof nd === 'string' && nd.trim() !== '' && Number.isFinite(Number(nd)))
    img.nodata = Number(nd);
  return img;
}

/** A six-line world file (.tfw): pixel size x, rotations, pixel size y, centre of the top-left pixel. */
export function parseWorldFile(text: string): number[] {
  const v = text.split(/\s+/).filter(Boolean).map(Number);
  if (v.length < 6 || v.some((x) => !Number.isFinite(x))) throw new Error('Unreadable world file.');
  return v.slice(0, 6);
}

/** EPSG code from a .prj (WKT): the last AUTHORITY["EPSG", n], or a UTM zone name. */
export function epsgFromPrj(wkt: string): number | undefined {
  const all = [...wkt.matchAll(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)];
  const last = all.at(-1)?.[1];
  if (last) return Number(last);
  const utm = /UTM[_ ]zone[_ ](\d{1,2})([NS])/i.exec(wkt);
  if (utm) return (utm[2]?.toUpperCase() === 'S' ? 32700 : 32600) + Number(utm[1]);
  return undefined;
}

/**
 * Model coordinates of the image corners (outer pixel edges): top-left, top-right, bottom-left.
 * From the GeoTIFF tags, or a world file when given (it names the centre of the first pixel).
 */
export function tiffCorners(
  t: Pick<TiffImage, 'width' | 'height' | 'geo'>,
  world?: readonly number[],
): { tl: [number, number]; tr: [number, number]; bl: [number, number] } {
  let affine: (i: number, j: number) => [number, number];
  if (world) {
    const [a = 1, d = 0, b = 0, e = -1, c = 0, f = 0] = world;
    affine = (i, j) => [a * (i - 0.5) + b * (j - 0.5) + c, d * (i - 0.5) + e * (j - 0.5) + f];
  } else if (t.geo.transform) {
    const m = t.geo.transform;
    affine = (i, j) => [
      (m[0] ?? 1) * i + (m[1] ?? 0) * j + (m[3] ?? 0),
      (m[4] ?? 0) * i + (m[5] ?? -1) * j + (m[7] ?? 0),
    ];
  } else if (t.geo.pixelScale && t.geo.tiepoint) {
    const [sx, sy] = t.geo.pixelScale;
    const [ti, tj, x, y] = t.geo.tiepoint;
    const shift = t.geo.pixelIsPoint ? 0.5 : 0;
    affine = (i, j) => [x + (i - ti + shift) * sx, y - (j - tj + shift) * sy];
  } else throw new Error('The TIFF has no georeference (no GeoTIFF tags and no world file).');
  return { tl: affine(0, 0), tr: affine(t.width, 0), bl: affine(0, t.height) };
}

/**
 * Draw a raster as RGBA no larger than `maxPx` on its long side (box filter): orthos as colour,
 * DSMs as a shaded elevation ramp. No-data and fully transparent pixels stay transparent.
 */
export function rasterToRgba(
  t: TiffImage,
  role: 'ortho' | 'dsm',
  maxPx = 4096,
): { width: number; height: number; data: Uint8Array; range?: [number, number] } {
  const step = Math.max(1, Math.ceil(Math.max(t.width, t.height) / maxPx));
  const w = Math.floor(t.width / step) || 1;
  const h = Math.floor(t.height / step) || 1;
  const out = new Uint8Array(w * h * 4);
  const s = t.samples;
  const at = (x: number, y: number, c: number) => t.data[(y * t.width + x) * s + c] ?? 0;
  const isNo = (v: number) => (t.nodata !== undefined && v === t.nodata) || !Number.isFinite(v);
  if (role === 'ortho') {
    const scale = t.bits === 16 ? 1 / 257 : t.format === 'float' ? 255 : 1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let dy = 0; dy < step; dy++)
          for (let dx = 0; dx < step; dx++) {
            const sx = x * step + dx;
            const sy = y * step + dy;
            const r = at(sx, sy, 0);
            const g = s >= 3 ? at(sx, sy, 1) : r;
            const bl = s >= 3 ? at(sx, sy, 2) : r;
            const a = s === 4 ? at(sx, sy, 3) * scale : s === 2 ? at(sx, sy, 1) * scale : 255;
            if (isNo(r) || a === 0) continue;
            acc[0] = (acc[0] ?? 0) + r * scale;
            acc[1] = (acc[1] ?? 0) + g * scale;
            acc[2] = (acc[2] ?? 0) + bl * scale;
            acc[3] = (acc[3] ?? 0) + a;
            n++;
          }
        const o = (y * w + x) * 4;
        if (!n) continue;
        for (let c = 0; c < 4; c++) out[o + c] = Math.round((acc[c] ?? 0) / n);
      }
    return { width: w, height: h, data: out };
  }
  // DSM: average heights per output pixel, then hillshade x elevation ramp.
  const z = new Float32Array(w * h).fill(Number.NaN);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < step; dy++)
        for (let dx = 0; dx < step; dx++) {
          const v = at(x * step + dx, y * step + dy, 0);
          if (isNo(v) || v < -1e4) continue;
          sum += v;
          n++;
        }
      if (!n) continue;
      const v = sum / n;
      z[y * w + x] = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  const cell = Math.abs(t.geo.pixelScale?.[0] ?? 1) * step;
  const ramp: [number, number, number][] = [
    [40, 70, 140],
    [60, 150, 140],
    [150, 190, 90],
    [235, 200, 90],
    [230, 120, 70],
    [245, 245, 245],
  ];
  const span = hi > lo ? hi - lo : 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = z[y * w + x] ?? Number.NaN;
      if (Number.isNaN(v)) continue;
      const zx =
        (z[y * w + Math.min(w - 1, x + 1)] ?? v) - (z[y * w + Math.max(0, x - 1)] ?? v) || 0;
      const zy =
        (z[Math.min(h - 1, y + 1) * w + x] ?? v) - (z[Math.max(0, y - 1) * w + x] ?? v) || 0;
      const nx = -zx / (2 * cell);
      const ny = zy / (2 * cell);
      const shade = Math.max(0.35, (nx * -0.5 + ny * 0.5 + 0.7) / Math.hypot(nx, ny, 1));
      const u = ((v - lo) / span) * (ramp.length - 1);
      const k = Math.min(ramp.length - 2, Math.floor(u));
      const f = u - k;
      const a = ramp[k] ?? [0, 0, 0];
      const b2 = ramp[k + 1] ?? a;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++)
        out[o + c] = Math.min(255, Math.round(((a[c] ?? 0) * (1 - f) + (b2[c] ?? 0) * f) * shade));
      out[o + 3] = 255;
    }
  return {
    width: w,
    height: h,
    data: out,
    ...(hi >= lo ? { range: [lo, hi] as [number, number] } : {}),
  };
}
