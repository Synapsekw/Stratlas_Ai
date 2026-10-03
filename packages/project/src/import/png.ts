import { deflateSync, inflateSync } from 'node:zlib';

/** Minimal PNG codec for 8-bit RGB/RGBA, non-interlaced images (point cloud chunks). */
export interface RawImage {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA). */
  channels: 3 | 4;
  data: Uint8Array;
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function decodePng(buf: Uint8Array): RawImage {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('Not a PNG');
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (p + 8 <= buf.length) {
    const len = v.getUint32(p);
    const type = String.fromCharCode(
      buf[p + 4] ?? 0,
      buf[p + 5] ?? 0,
      buf[p + 6] ?? 0,
      buf[p + 7] ?? 0,
    );
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = v.getUint32(p + 8);
      height = v.getUint32(p + 12);
      const depth = buf[p + 16];
      colorType = buf[p + 17] ?? 0;
      const interlace = buf[p + 20];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(
          `Unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`,
        );
      }
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const channels: 3 | 4 = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = data.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (out[x - channels] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= channels ? (prev[x - channels] ?? 0) : 0;
      const r = line[x] ?? 0;
      let val: number;
      switch (f) {
        case 0:
          val = r;
          break;
        case 1:
          val = r + a;
          break;
        case 2:
          val = r + b;
          break;
        case 3:
          val = r + ((a + b) >> 1);
          break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          val = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`Bad PNG filter ${f}`);
      }
      out[x] = val & 0xff;
    }
    prev = out;
  }
  return { width, height, channels, data };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encode 8-bit RGB or RGBA (filter 0 on every row; data is already noise-like). */
export function encodePng(img: RawImage): Uint8Array {
  const stride = img.width * img.channels;
  const raw = new Uint8Array(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) {
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, img.width);
  hv.setUint32(4, img.height);
  ihdr[8] = 8;
  ihdr[9] = img.channels === 4 ? 6 : 2;
  return Buffer.concat([
    Uint8Array.from(SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
