// Byte-exact file writers for the change and modelling demo (build-change-demo.mjs): PNG with our
// own deflate, LAS 1.2 point clouds. Everything here is plain JavaScript with no codec library, so
// the same input gives the same bytes on every machine and Node version (no zlib build, no SIMD
// paths, no tool version, time or path written into a file).

// ------------------------------------------------------------------ checksums

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO 3309, as PNG and ZIP use it). */
export function crc32(buf, crc = 0) {
  let c = ~crc >>> 0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length;) {
    const end = Math.min(buf.length, i + 3800);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ------------------------------------------------------------------ deflate (RFC 1951)

class BitWriter {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.pos = 0;
    this.bits = 0;
    this.count = 0;
  }

  /** Write `n` bits of `v`, least significant first. */
  put(v, n) {
    this.bits |= v << this.count;
    this.count += n;
    while (this.count >= 8) {
      if (this.pos === this.buf.length) {
        const next = new Uint8Array(this.buf.length * 2);
        next.set(this.buf);
        this.buf = next;
      }
      this.buf[this.pos++] = this.bits & 0xff;
      this.bits >>>= 8;
      this.count -= 8;
    }
  }

  /** Write a Huffman code (most significant bit first). */
  code(c, n) {
    let r = 0;
    for (let i = 0; i < n; i++) r |= ((c >> i) & 1) << (n - 1 - i);
    this.put(r, n);
  }

  done() {
    if (this.count > 0) this.put(0, 8 - this.count);
    return this.buf.subarray(0, this.pos);
  }
}

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** Fixed Huffman code of a literal/length symbol. */
function litCode(w, sym) {
  if (sym < 144) w.code(0x30 + sym, 8);
  else if (sym < 256) w.code(0x190 + sym - 144, 9);
  else if (sym < 280) w.code(sym - 256, 7);
  else w.code(0xc0 + sym - 280, 8);
}

function lastLE(table, v) {
  let i = table.length - 1;
  while (table[i] > v) i--;
  return i;
}

/**
 * zlib stream (RFC 1950) of `data`: one fixed-Huffman block, greedy LZ77 over a 32 KB window.
 * Smaller than stored blocks and fully deterministic (our own code, no zlib build differences).
 */
export function deflateZlib(data) {
  const src = data instanceof Uint8Array ? data : new Uint8Array(data);
  const n = src.length;
  const w = new BitWriter(Math.max(1024, n >> 1));
  w.put(0x78, 8);
  w.put(0x01, 8);
  w.put(1, 1); // BFINAL
  w.put(1, 2); // fixed Huffman
  const WIN = 32768;
  const HBITS = 15;
  const head = new Int32Array(1 << HBITS).fill(-1);
  const prev = new Int32Array(WIN);
  const hash = (i) => ((src[i] << 10) ^ (src[i + 1] << 5) ^ src[i + 2]) & ((1 << HBITS) - 1);
  const insert = (i) => {
    if (i + 2 >= n) return;
    const h = hash(i);
    prev[i & (WIN - 1)] = head[h];
    head[h] = i;
  };
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 2 < n) {
      let cand = head[hash(i)];
      let chain = 48;
      const max = Math.min(258, n - i);
      while (cand >= 0 && i - cand <= WIN && chain-- > 0) {
        if (src[cand + bestLen] === src[i + bestLen]) {
          let l = 0;
          while (l < max && src[cand + l] === src[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l === max) break;
          }
        }
        const p = prev[cand & (WIN - 1)];
        if (p >= cand) break;
        cand = p;
      }
    }
    if (bestLen >= 3) {
      const li = lastLE(LEN_BASE, bestLen);
      litCode(w, 257 + li);
      if (LEN_EXTRA[li]) w.put(bestLen - LEN_BASE[li], LEN_EXTRA[li]);
      const di = lastLE(DIST_BASE, bestDist);
      w.code(di, 5);
      if (DIST_EXTRA[di]) w.put(bestDist - DIST_BASE[di], DIST_EXTRA[di]);
      for (let k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
    } else {
      litCode(w, src[i]);
      insert(i);
      i++;
    }
  }
  litCode(w, 256);
  const body = w.done();
  const out = Buffer.alloc(body.length + 4);
  out.set(body);
  out.writeUInt32BE(adler32(src), body.length);
  return out;
}

// ------------------------------------------------------------------ PNG

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, data, crc]);
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * A PNG with no metadata chunks. `data`: 8-bit samples (Uint8Array, row-major, interleaved) or
 * 16-bit samples (Uint16Array, values, written big-endian). `channels` 1 (grey), 3 (RGB) or 4.
 * Each row takes the filter (none, sub, up, average, Paeth) with the smallest sum of magnitudes.
 */
export function encodePng({ width, height, channels, depth = 8, data }) {
  const type = { 1: 0, 3: 2, 4: 6 }[channels];
  if (type === undefined) throw new Error(`PNG: ${channels} channels`);
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  const raw = Buffer.alloc(stride * height);
  if (depth === 16)
    for (let i = 0; i < width * height * channels; i++) raw.writeUInt16BE(data[i], 2 * i);
  else raw.set(data.subarray ? data.subarray(0, raw.length) : data);
  const out = Buffer.alloc((stride + 1) * height);
  const cand = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = up ? up[x] : 0;
        const c = up && x >= bpp ? up[x - bpp] : 0;
        const pred =
          f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[x] - pred) & 0xff;
        cand[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        out[y * (stride + 1)] = f;
        cand.copy(out, y * (stride + 1) + 1);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = type;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateZlib(out)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ LAS 1.2

const dayOfYear = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
};

/**
 * LAS 1.2, point format 2 (XYZ, intensity, classification, RGB), coordinates in the project CRS
 * (`xyz` Float64Array of E, N, H), millimetre scale, with a GeoTIFF key directory naming `epsg`.
 * The header names the generator only as "Quadrion AI demo" and the capture `date` (no clock, no
 * machine, no tool version).
 */
export function writeLas({ xyz, rgb, classification, intensity, epsg, date }) {
  const n = xyz.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      const v = xyz[3 * i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  const scale = 0.001;
  const offset = min.map((v) => (Number.isFinite(v) ? Math.floor(v / 100) * 100 : 0));
  const q = (v, a) => Math.round((v - offset[a]) / scale);
  const keys = [
    [1024, 0, 1, 1], // GTModelTypeGeoKey: projected
    [1025, 0, 1, 1], // GTRasterTypeGeoKey: pixel is area
    [3072, 0, 1, epsg], // ProjectedCSTypeGeoKey
    [3076, 0, 1, 9001], // ProjLinearUnitsGeoKey: metre
    [4099, 0, 1, 9001], // VerticalUnitsGeoKey: metre
  ];
  const geo = Buffer.alloc(8 * (keys.length + 1));
  [1, 1, 0, keys.length].forEach((v, k) => geo.writeUInt16LE(v, 2 * k));
  keys.forEach((key, j) => key.forEach((v, k) => geo.writeUInt16LE(v, 8 + 8 * j + 2 * k)));
  const vlr = Buffer.alloc(54);
  vlr.write('LASF_Projection', 2, 'latin1');
  vlr.writeUInt16LE(34735, 18);
  vlr.writeUInt16LE(geo.length, 20);
  vlr.write('GeoKeyDirectoryTag', 22, 'latin1');
  const HEADER = 227;
  const REC = 26;
  const h = Buffer.alloc(HEADER);
  h.write('LASF', 0, 'latin1');
  h[24] = 1;
  h[25] = 2;
  h.write('Quadrion AI demo (synthetic)', 26, 'latin1');
  h.write('Quadrion AI demo builder', 58, 'latin1');
  h.writeUInt16LE(dayOfYear(date), 90);
  h.writeUInt16LE(Number(date.slice(0, 4)), 92);
  h.writeUInt16LE(HEADER, 94);
  h.writeUInt32LE(HEADER + vlr.length + geo.length, 96);
  h.writeUInt32LE(1, 100);
  h[104] = 2;
  h.writeUInt16LE(REC, 105);
  h.writeUInt32LE(n, 107);
  h.writeUInt32LE(n, 111);
  for (let a = 0; a < 3; a++) {
    h.writeDoubleLE(scale, 131 + 8 * a);
    h.writeDoubleLE(offset[a], 155 + 8 * a);
    // stored extents are the quantised values, so readers agree with the records exactly
    h.writeDoubleLE(n ? q(max[a], a) * scale + offset[a] : 0, 179 + 16 * a);
    h.writeDoubleLE(n ? q(min[a], a) * scale + offset[a] : 0, 187 + 16 * a);
  }
  const pts = Buffer.alloc(n * REC);
  for (let i = 0; i < n; i++) {
    const o = i * REC;
    pts.writeInt32LE(q(xyz[3 * i], 0), o);
    pts.writeInt32LE(q(xyz[3 * i + 1], 1), o + 4);
    pts.writeInt32LE(q(xyz[3 * i + 2], 2), o + 8);
    pts.writeUInt16LE(intensity ? intensity[i] : 0, o + 12);
    pts[o + 14] = 1 | (1 << 3); // return 1 of 1
    pts[o + 15] = classification ? classification[i] : 1;
    for (let c = 0; c < 3; c++) pts.writeUInt16LE((rgb ? rgb[3 * i + c] : 0) * 257, o + 20 + 2 * c);
  }
  return Buffer.concat([h, vlr, geo, pts]);
}

/** Read back what writeLas wrote (header, EPSG, and every point's XYZ to the millimetre). */
export function readLasHeader(buf) {
  const head = {
    signature: buf.toString('latin1', 0, 4),
    version: `${buf[24]}.${buf[25]}`,
    day: buf.readUInt16LE(90),
    year: buf.readUInt16LE(92),
    headerSize: buf.readUInt16LE(94),
    offset: buf.readUInt32LE(96),
    vlrs: buf.readUInt32LE(100),
    format: buf[104],
    recordLength: buf.readUInt16LE(105),
    points: buf.readUInt32LE(107),
    scale: [0, 1, 2].map((a) => buf.readDoubleLE(131 + 8 * a)),
    origin: [0, 1, 2].map((a) => buf.readDoubleLE(155 + 8 * a)),
    max: [0, 1, 2].map((a) => buf.readDoubleLE(179 + 16 * a)),
    min: [0, 1, 2].map((a) => buf.readDoubleLE(187 + 16 * a)),
    epsg: null,
    points3: [],
  };
  let p = head.headerSize;
  for (let v = 0; v < head.vlrs; v++) {
    const len = buf.readUInt16LE(p + 20);
    if (buf.readUInt16LE(p + 18) === 34735) {
      const k = buf.readUInt16LE(p + 54 + 6);
      for (let j = 0; j < k; j++) {
        const o = p + 54 + 8 + 8 * j;
        if (buf.readUInt16LE(o) === 3072) head.epsg = buf.readUInt16LE(o + 6);
      }
    }
    p += 54 + len;
  }
  const r = (v) => Math.round(v * 1000) / 1000;
  for (let i = 0; i < head.points; i++) {
    const o = head.offset + i * head.recordLength;
    head.points3.push(
      [0, 1, 2].map((a) => r(buf.readInt32LE(o + 4 * a) * head.scale[a] + head.origin[a])),
    );
  }
  return head;
}
