/** COPC node decoding: LAS point records to quantised local-frame arrays. Pure, worker side. */
import { readScalar, type ScalarField } from './extraBytes';
import { sampleHeights } from './heights';

type V3 = readonly [number, number, number];

/** What decoding needs from the LAS header. */
export interface LasLayout {
  pointDataRecordFormat: number;
  pointDataRecordLength: number;
  scale: V3;
  offset: V3;
  /** One float extra-bytes dimension decoded with every point (cloud change: `Distance`). */
  scalar?: ScalarField;
}

export interface DecodedCopcNode {
  count: number;
  /** uint16 per axis over the node box: local = quant.offset + quant.scale * u. */
  position: Uint16Array;
  quant: { offset: [number, number, number]; scale: [number, number, number] };
  rgb?: Uint8Array;
  intensity?: Uint8Array;
  classification?: Uint8Array;
  /** Point count per ASPRS class code. */
  classes: Record<number, number>;
  /** Tight bounds in the local frame. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** A spread sample of the points' local heights (Y), unquantised. */
  heights: Float32Array;
  /** The layout's scalar per point (non-finite values as 0). */
  scalar?: Float32Array;
}

/** Byte offsets of the fields read here, per point data record format (LAS 1.4 R15). */
function fields(pdrf: number): { intensity: number; cls: number; rgb: number | null } {
  switch (pdrf) {
    case 6:
      return { intensity: 12, cls: 16, rgb: null };
    case 7:
    case 8:
      return { intensity: 12, cls: 16, rgb: 30 };
    default:
      throw new Error(`COPC point format ${pdrf} is not supported (expected 6, 7 or 8)`);
  }
}

/**
 * Decode `count` uncompressed LAS records into the local frame (x east, y up, z south from
 * `origin` = [E, N, H]), quantised to uint16 over `box` (the node bounds in the local frame).
 * 16-bit colour and intensity are reduced to 8 bits when any value exceeds 255.
 */
export function decodeLasRecords(
  data: Uint8Array,
  layout: LasLayout,
  count: number,
  origin: V3,
  box: { min: V3; max: V3 },
): DecodedCopcNode {
  const f = fields(layout.pointDataRecordFormat);
  const len = layout.pointDataRecordLength;
  if (data.byteLength < len * count) {
    throw new Error(`COPC node holds ${data.byteLength} bytes, ${len * count} expected`);
  }
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const [sx, sy, sz] = layout.scale;
  const [ox, oy, oz] = layout.offset;
  const step: [number, number, number] = [0, 1, 2].map(
    (a) => Math.max((box.max[a] ?? 0) - (box.min[a] ?? 0), 1e-6) / 65535,
  ) as [number, number, number];
  const lo: [number, number, number] = [box.min[0], box.min[1], box.min[2]];

  const position = new Uint16Array(count * 3);
  const intensity16 = new Uint16Array(count);
  const classification = new Uint8Array(count);
  const rgb16 = f.rgb === null ? null : new Uint16Array(count * 3);
  const sf = layout.scalar;
  const scalar = sf ? new Float32Array(count) : null;
  const classes: Record<number, number> = {};
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let iMax = 0;
  let cMax = 0;
  const q = (x: number, a: 0 | 1 | 2) => {
    const u = Math.round((x - lo[a]) / step[a]);
    return u < 0 ? 0 : u > 65535 ? 65535 : u;
  };

  for (let k = 0; k < count; k++) {
    const o = k * len;
    const lx = v.getInt32(o, true) * sx + ox - origin[0];
    const lz = origin[1] - (v.getInt32(o + 4, true) * sy + oy);
    const ly = v.getInt32(o + 8, true) * sz + oz - origin[2];
    position[3 * k] = q(lx, 0);
    position[3 * k + 1] = q(ly, 1);
    position[3 * k + 2] = q(lz, 2);
    if (lx < min[0]) min[0] = lx;
    if (ly < min[1]) min[1] = ly;
    if (lz < min[2]) min[2] = lz;
    if (lx > max[0]) max[0] = lx;
    if (ly > max[1]) max[1] = ly;
    if (lz > max[2]) max[2] = lz;
    const it = v.getUint16(o + f.intensity, true);
    intensity16[k] = it;
    if (it > iMax) iMax = it;
    const c = v.getUint8(o + f.cls);
    classification[k] = c;
    classes[c] = (classes[c] ?? 0) + 1;
    if (scalar && sf) {
      const x = readScalar(v, o, sf);
      scalar[k] = Number.isFinite(x) ? x : 0;
    }
    if (rgb16 && f.rgb !== null) {
      for (let b = 0; b < 3; b++) {
        const x = v.getUint16(o + f.rgb + 2 * b, true);
        rgb16[3 * k + b] = x;
        if (x > cMax) cMax = x;
      }
    }
  }

  const to8 = (src: Uint16Array, wide: boolean) => {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = wide ? (src[i] ?? 0) >> 8 : (src[i] ?? 0);
    return out;
  };
  const out: DecodedCopcNode = {
    count,
    position,
    quant: { offset: lo, scale: step },
    intensity: to8(intensity16, iMax > 255),
    classification,
    classes,
    bounds: count ? { min, max } : { min: [...lo], max: [...lo] },
    heights: sampleHeights(count, (k) => v.getInt32(k * len + 8, true) * sz + oz - origin[2]),
  };
  if (rgb16) out.rgb = to8(rgb16, cMax > 255);
  if (scalar) out.scalar = scalar;
  return out;
}

/** The parts of the laz-perf module used to decompress one COPC chunk. */
export interface LazPerfLike {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(p: number): void;
  ChunkDecoder: new () => {
    open(pdrf: number, len: number, ptr: number): void;
    getPoint(ptr: number): void;
    delete(): void;
  };
}

/** Decompress one LAZ chunk (a COPC node) into raw point records. */
export function decompressChunk(
  compressed: Uint8Array,
  layout: LasLayout,
  count: number,
  laz: LazPerfLike,
): Uint8Array {
  const len = layout.pointDataRecordLength;
  const out = new Uint8Array(count * len);
  let blob = 0;
  let point = 0;
  const decoder = new laz.ChunkDecoder();
  try {
    blob = laz._malloc(compressed.byteLength);
    point = laz._malloc(len);
    laz.HEAPU8.set(compressed, blob);
    decoder.open(layout.pointDataRecordFormat, len, blob);
    for (let i = 0; i < count; i++) {
      decoder.getPoint(point);
      // HEAPU8 may be replaced when the WASM memory grows, so read it each time
      out.set(laz.HEAPU8.subarray(point, point + len), i * len);
    }
  } finally {
    if (blob) laz._free(blob);
    if (point) laz._free(point);
    decoder.delete();
  }
  return out;
}
