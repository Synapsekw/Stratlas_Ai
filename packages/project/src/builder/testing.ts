/**
 * Test helpers: build JPEG headers with EXIF GPS and DJI XMP, so photo import can be tested
 * without client data. Not used by the app.
 */

export interface FixtureExif {
  make?: string;
  model?: string;
  /** "YYYY:MM:DD HH:MM:SS" */
  dateTimeOriginal?: string;
  offsetTimeOriginal?: string;
  focalMm?: number;
  focal35?: number;
  lat?: number;
  lon?: number;
  alt?: number;
  width?: number;
  height?: number;
  /** DJI XMP attributes without the prefix, e.g. { GimbalYawDegree: '+63.10' }. */
  dji?: Record<string, string>;
  /** Big-endian TIFF ("MM") instead of little-endian ("II"). */
  bigEndian?: boolean;
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  data: Uint8Array;
}

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const BYTE = 1;

/** Build an EXIF APP1 payload ("Exif\0\0" + TIFF). */
export function exifSegment(o: FixtureExif): Uint8Array {
  const le = !o.bigEndian;
  const enc = new TextEncoder();
  const u16 = (n: number) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, le);
    return b;
  };
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, le);
    return b;
  };
  const rational = (vals: number[]) => {
    const b = new Uint8Array(vals.length * 8);
    const v = new DataView(b.buffer);
    vals.forEach((x, i) => {
      v.setUint32(i * 8, Math.round(x * 10000), le);
      v.setUint32(i * 8 + 4, 10000, le);
    });
    return b;
  };
  const ascii = (s: string) => enc.encode(`${s}\0`);
  const dms = (deg: number) => {
    const a = Math.abs(deg);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = (a - d - m / 60) * 3600;
    return rational([d, m, s]);
  };

  const ifd0: Entry[] = [];
  const exif: Entry[] = [];
  const gps: Entry[] = [];
  const add = (list: Entry[], tag: number, type: number, data: Uint8Array, count?: number) => {
    const size = type === RATIONAL ? 8 : type === SHORT ? 2 : type === LONG ? 4 : 1;
    list.push({ tag, type, count: count ?? data.length / size, data });
  };
  if (o.make) add(ifd0, 0x010f, ASCII, ascii(o.make));
  if (o.model) add(ifd0, 0x0110, ASCII, ascii(o.model));
  if (o.dateTimeOriginal) add(exif, 0x9003, ASCII, ascii(o.dateTimeOriginal));
  if (o.offsetTimeOriginal) add(exif, 0x9011, ASCII, ascii(o.offsetTimeOriginal));
  if (o.focalMm !== undefined) add(exif, 0x920a, RATIONAL, rational([o.focalMm]));
  if (o.focal35 !== undefined) add(exif, 0xa405, SHORT, u16(o.focal35));
  if (o.width !== undefined) add(exif, 0xa002, LONG, u32(o.width));
  if (o.height !== undefined) add(exif, 0xa003, LONG, u32(o.height));
  if (o.lat !== undefined && o.lon !== undefined) {
    add(gps, 1, ASCII, ascii(o.lat >= 0 ? 'N' : 'S'));
    add(gps, 2, RATIONAL, dms(o.lat));
    add(gps, 3, ASCII, ascii(o.lon >= 0 ? 'E' : 'W'));
    add(gps, 4, RATIONAL, dms(o.lon));
    if (o.alt !== undefined) {
      add(gps, 5, BYTE, new Uint8Array([o.alt < 0 ? 1 : 0]));
      add(gps, 6, RATIONAL, rational([Math.abs(o.alt)]));
    }
  }
  // Layout: header(8) | IFD0 | data0 | EXIF IFD | dataE | GPS IFD | dataG
  const parts: Uint8Array[] = [];
  let offset = 8;
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const extra = (list: Entry[]) =>
    list.reduce((m, e) => m + (e.data.length > 4 ? e.data.length + (e.data.length % 2) : 0), 0);
  const n0 = ifd0.length + (exif.length ? 1 : 0) + (gps.length ? 1 : 0);
  const exifAt = offset + ifdSize(n0) + extra(ifd0);
  const gpsAt = exifAt + (exif.length ? ifdSize(exif.length) + extra(exif) : 0);
  if (exif.length) add(ifd0, 0x8769, LONG, u32(exifAt));
  if (gps.length) add(ifd0, 0x8825, LONG, u32(gpsAt));
  const write = (list: Entry[], at: number) => {
    list.sort((a, b) => a.tag - b.tag);
    const head = new Uint8Array(ifdSize(list.length));
    const hv = new DataView(head.buffer);
    hv.setUint16(0, list.length, le);
    let dataAt = at + head.length;
    const blobs: Uint8Array[] = [];
    list.forEach((e, i) => {
      const p = 2 + i * 12;
      hv.setUint16(p, e.tag, le);
      hv.setUint16(p + 2, e.type, le);
      hv.setUint32(p + 4, e.count, le);
      if (e.data.length <= 4) head.set(e.data, p + 8);
      else {
        hv.setUint32(p + 8, dataAt, le);
        const padded = new Uint8Array(e.data.length + (e.data.length % 2));
        padded.set(e.data);
        blobs.push(padded);
        dataAt += padded.length;
      }
    });
    parts.push(head, ...blobs);
    return dataAt;
  };
  offset = write(ifd0, offset);
  if (exif.length) offset = write(exif, offset);
  if (gps.length) write(gps, offset);
  const header = new Uint8Array(8);
  header.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
  new DataView(header.buffer).setUint16(2, 42, le);
  new DataView(header.buffer).setUint32(4, 8, le);
  const tiff = concat([header, ...parts]);
  return concat([enc.encode('Exif\0\0'), tiff]);
}

/** A DJI style XMP APP1 payload. */
export function xmpSegment(dji: Record<string, string>): Uint8Array {
  const attrs = Object.entries(dji)
    .map(([k, v]) => `   drone-dji:${k}="${v}"`)
    .join('\n');
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="DJI Meta Data" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"\n${attrs}>\n</rdf:Description></rdf:RDF></x:xmpmeta>`;
  return concat([
    new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0'),
    new TextEncoder().encode(xml),
  ]);
}

/** TIFF LZW encoder (MSB first, early change), for reader tests. */
export function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let nbits = 0;
  let width = 9;
  const emit = (code: number) => {
    acc = (acc << width) | code;
    nbits += width;
    while (nbits >= 8) {
      out.push((acc >> (nbits - 8)) & 0xff);
      nbits -= 8;
    }
    acc &= (1 << nbits) - 1;
  };
  let dict = new Map<string, number>();
  let next = 258;
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    next = 258;
    width = 9;
  };
  reset();
  emit(256);
  let w = '';
  for (const byte of data) {
    const c = String.fromCharCode(byte);
    const wc = w + c;
    if (dict.has(wc)) {
      w = wc;
      continue;
    }
    emit(dict.get(w) ?? 0);
    dict.set(wc, next++);
    if (next + 1 >= 1 << width && width < 12) width++;
    if (next >= 4093) {
      emit(256);
      reset();
    }
    w = c;
  }
  if (w) emit(dict.get(w) ?? 0);
  emit(257);
  if (nbits > 0) out.push((acc << (8 - nbits)) & 0xff);
  return Uint8Array.from(out);
}

export interface FixtureTiff {
  width: number;
  height: number;
  samples: number;
  bits: 8 | 16 | 32;
  format?: 'uint' | 'int' | 'float';
  /** Interleaved sample values. */
  values: readonly number[];
  compression?: 1 | 5 | 8;
  predictor?: 1 | 2;
  rowsPerStrip?: number;
  epsg?: number;
  pixelScale?: [number, number];
  tiepoint?: [number, number];
  nodata?: string;
}

/** A little-endian strip TIFF with optional GeoTIFF tags. */
export function makeTiff(o: FixtureTiff, compress: (b: Uint8Array) => Uint8Array): Uint8Array {
  const bps = o.bits / 8;
  const raw = new Uint8Array(o.width * o.height * o.samples * bps);
  const dv = new DataView(raw.buffer);
  o.values.forEach((v, i) => {
    if (o.bits === 8) raw[i] = v;
    else if (o.bits === 16) {
      if (o.format === 'int') dv.setInt16(i * 2, v, true);
      else dv.setUint16(i * 2, v, true);
    } else dv.setFloat32(i * 4, v, true);
  });
  const rows = o.rowsPerStrip ?? o.height;
  const stride = o.width * o.samples * bps;
  const strips: Uint8Array[] = [];
  for (let y = 0; y < o.height; y += rows) {
    const s = raw.slice(y * stride, Math.min(o.height, y + rows) * stride);
    if (o.predictor === 2 && o.bits === 8) {
      for (let r = 0; r < s.length / stride; r++)
        for (let x = o.width - 1; x >= 1; x--)
          for (let c = 0; c < o.samples; c++) {
            const i = r * stride + x * o.samples + c;
            s[i] = ((s[i] ?? 0) - (s[i - o.samples] ?? 0)) & 0xff;
          }
    }
    const c = o.compression ?? 1;
    strips.push(c === 1 ? s : c === 5 ? lzwEncode(s) : compress(s));
  }
  interface T {
    tag: number;
    type: number;
    values: number[] | string;
  }
  const tags: T[] = [
    { tag: 256, type: 4, values: [o.width] },
    { tag: 257, type: 4, values: [o.height] },
    { tag: 258, type: 3, values: Array<number>(o.samples).fill(o.bits) },
    { tag: 259, type: 3, values: [o.compression ?? 1] },
    { tag: 262, type: 3, values: [o.samples >= 3 ? 2 : 1] },
    { tag: 273, type: 4, values: strips.map(() => 0) },
    { tag: 277, type: 3, values: [o.samples] },
    { tag: 278, type: 4, values: [rows] },
    { tag: 279, type: 4, values: strips.map((s) => s.length) },
    { tag: 284, type: 3, values: [1] },
  ];
  if (o.predictor) tags.push({ tag: 317, type: 3, values: [o.predictor] });
  const fmt = o.format === 'float' ? 3 : o.format === 'int' ? 2 : 1;
  tags.push({ tag: 339, type: 3, values: Array<number>(o.samples).fill(fmt) });
  if (o.pixelScale) tags.push({ tag: 33550, type: 12, values: [...o.pixelScale, 0] });
  if (o.tiepoint) tags.push({ tag: 33922, type: 12, values: [0, 0, 0, ...o.tiepoint, 0] });
  if (o.epsg)
    tags.push({ tag: 34735, type: 3, values: [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, o.epsg] });
  if (o.nodata) tags.push({ tag: 42113, type: 2, values: o.nodata });
  tags.sort((a, b) => a.tag - b.tag);
  const size = (t: T) =>
    typeof t.values === 'string'
      ? t.values.length + 1
      : t.values.length * (t.type === 3 ? 2 : t.type === 12 ? 8 : 4);
  const ifdAt = 8;
  let dataAt = ifdAt + 2 + tags.length * 12 + 4;
  const extra: { at: number; t: T }[] = [];
  for (const t of tags) {
    if (size(t) > 4) {
      extra.push({ at: dataAt, t });
      dataAt += size(t) + (size(t) % 2);
    }
  }
  const stripAt: number[] = [];
  for (const s of strips) {
    stripAt.push(dataAt);
    dataAt += s.length;
  }
  const off = tags.find((t) => t.tag === 273);
  if (off) off.values = stripAt;
  const buf = new Uint8Array(dataAt);
  const v = new DataView(buf.buffer);
  buf.set([0x49, 0x49]);
  v.setUint16(2, 42, true);
  v.setUint32(4, ifdAt, true);
  v.setUint16(ifdAt, tags.length, true);
  const put = (t: T, at: number) => {
    if (typeof t.values === 'string') {
      buf.set(new TextEncoder().encode(t.values), at);
      return;
    }
    t.values.forEach((x, i) => {
      if (t.type === 3) v.setUint16(at + i * 2, x, true);
      else if (t.type === 12) v.setFloat64(at + i * 8, x, true);
      else v.setUint32(at + i * 4, x, true);
    });
  };
  tags.forEach((t, i) => {
    const e = ifdAt + 2 + i * 12;
    v.setUint16(e, t.tag, true);
    v.setUint16(e + 2, t.type, true);
    v.setUint32(e + 4, typeof t.values === 'string' ? t.values.length + 1 : t.values.length, true);
    const x = extra.find((q) => q.t === t);
    if (x) {
      v.setUint32(e + 8, x.at, true);
      put(t, x.at);
    } else put(t, e + 8);
  });
  strips.forEach((s, i) => {
    buf.set(s, stripAt[i] ?? 0);
  });
  return buf;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const segment = (marker: number, payload: Uint8Array) => {
  const head = new Uint8Array(4);
  head[0] = 0xff;
  head[1] = marker;
  new DataView(head.buffer).setUint16(2, payload.length + 2);
  return concat([head, payload]);
};

/**
 * Insert EXIF (and XMP) segments right after the SOI of a JPEG. With no JPEG given, a header-only
 * stub (SOI, APP1s, SOF0 with the size, EOI) is returned, enough for metadata tests.
 */
export function withExif(o: FixtureExif, jpeg?: Uint8Array): Uint8Array {
  const segs = [segment(0xe1, exifSegment(o))];
  if (o.dji) segs.push(segment(0xe1, xmpSegment(o.dji)));
  if (jpeg) return concat([jpeg.subarray(0, 2), ...segs, jpeg.subarray(2)]);
  const sof = new Uint8Array(15);
  const sv = new DataView(sof.buffer);
  sof[0] = 8;
  sv.setUint16(1, o.height ?? 3000);
  sv.setUint16(3, o.width ?? 4000);
  sof[5] = 3;
  return concat([
    new Uint8Array([0xff, 0xd8]),
    ...segs,
    segment(0xc0, sof),
    new Uint8Array([0xff, 0xd9]),
  ]);
}
