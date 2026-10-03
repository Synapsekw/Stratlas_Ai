import type { Vec3 } from '@aio/schema';

/** Axis-aligned box in the local frame, metres. */
export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

/** metres = offset + scale * stored integer, per axis. */
export interface Quantisation {
  offset: Vec3;
  scale: Vec3;
}

export interface DecodedKitCloud {
  /** xyz in metres, local frame, 3 floats per point. */
  positions: Float32Array;
  /** The stored int16 xyz (millimetres); upload this with `scale` to save GPU memory. */
  raw: Int16Array;
  /** 0..255 per point. */
  intensity: Uint8Array;
  count: number;
  bounds: Bounds3;
}

export interface DecodedPngChunk {
  /** xyz in metres, local frame, 3 floats per point. */
  positions: Float32Array;
  /** The stored uint16 xyz; metres = quant.offset + quant.scale * raw. */
  raw: Uint16Array;
  /** 8-bit sRGB per point, 3 bytes per point. */
  rgb: Uint8Array;
  count: number;
  bounds: Bounds3;
  quant: Quantisation;
}

/** Bytes per point in the kit packed format: int16 x, y, z (millimetres) + uint8 intensity. */
export const KIT_PACKED_STRIDE = 7;

/** Bytes per point in a png-packed chunk: uint16 x, y, z + uint8 r, g, b. */
export const PNG_PACKED_STRIDE = 9;

function boundsOf(positions: Float32Array, count: number): Bounds3 {
  if (count === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count * 3; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a] ?? 0;
      if (v < (min[a] ?? 0)) min[a] = v;
      if (v > (max[a] ?? 0)) max[a] = v;
    }
  }
  // float32 rounding: report the bounds as float64 of the float32 values, rounded to 1e-6 m
  const r = (v: number | undefined) => Math.round((v ?? 0) * 1e6) / 1e6;
  return { min: [r(min[0]), r(min[1]), r(min[2])], max: [r(max[0]), r(max[1]), r(max[2])] };
}

/**
 * Decode the kit packed cloud (HCl Tank artifacts, `cloud.bin`). Layout, no header, little-endian:
 * block A = N x int16 x, y, z interleaved per point (bytes 0 .. 6N-1), block B = N x uint8
 * intensity (bytes 6N .. 7N-1). `scale` converts stored units to metres.
 */
export function decodeKitPacked(
  buf: ArrayBuffer,
  scale = 0.001,
  offset: Vec3 = [0, 0, 0],
): DecodedKitCloud {
  if (buf.byteLength % KIT_PACKED_STRIDE !== 0) {
    throw new Error(
      `Packed cloud size ${buf.byteLength} is not a multiple of ${KIT_PACKED_STRIDE} bytes`,
    );
  }
  const count = buf.byteLength / KIT_PACKED_STRIDE;
  // Int16Array needs 2-byte alignment; byte 0 of a fresh ArrayBuffer always is.
  const raw = new Int16Array(buf.slice(0, count * 6));
  const intensity = new Uint8Array(buf.slice(count * 6, count * 7));
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i += 3) {
    positions[i] = (raw[i] ?? 0) * scale + offset[0];
    positions[i + 1] = (raw[i + 1] ?? 0) * scale + offset[1];
    positions[i + 2] = (raw[i + 2] ?? 0) * scale + offset[2];
  }
  return { positions, raw, intensity, count, bounds: boundsOf(positions, count) };
}

/** The quantisation that maps uint16 0..65535 onto `bounds` per axis. */
export function quantFromBounds(b: Bounds3): Quantisation {
  const s = (a: 0 | 1 | 2) => (b.max[a] - b.min[a]) / 65535;
  return { offset: [...b.min], scale: [s(0), s(1), s(2)] };
}

function isQuant(q: Quantisation | Bounds3): q is Quantisation {
  return 'offset' in q;
}

/**
 * Decode one png-packed chunk from its RGBA pixels (as returned by `getImageData`).
 *
 * The chunk is a byte stream laid into the R, G, B channels of consecutive pixels in row-major
 * order (alpha is ignored). For N points the stream holds nine planes of N bytes each:
 * x lo, x hi, y lo, y hi, z lo, z hi, r, g, b. Position = offset + scale * uint16 per axis.
 * `q` is either an explicit quantisation or the chunk bounds (uint16 spans min..max).
 * `count` defaults to the most points the image can hold.
 */
export function decodePngChunk(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  q: Quantisation | Bounds3,
  count?: number,
): DecodedPngChunk {
  const capacity = Math.floor((width * height * 3) / PNG_PACKED_STRIDE);
  const n = count ?? capacity;
  if (n > capacity || rgba.length < width * height * 4) {
    throw new Error(`PNG chunk ${width}x${height} is too small for ${n} points`);
  }
  const quant = isQuant(q) ? q : quantFromBounds(q);
  const need = n * PNG_PACKED_STRIDE;
  const b = new Uint8Array(need);
  for (let i = 0, j = 0; j < need; i += 4) {
    b[j++] = rgba[i] ?? 0;
    if (j < need) b[j++] = rgba[i + 1] ?? 0;
    if (j < need) b[j++] = rgba[i + 2] ?? 0;
  }
  const raw = new Uint16Array(n * 3);
  const rgb = new Uint8Array(n * 3);
  const positions = new Float32Array(n * 3);
  const [ox, oy, oz] = quant.offset;
  const [sx, sy, sz] = quant.scale;
  for (let i = 0; i < n; i++) {
    const x = (b[i] ?? 0) | ((b[n + i] ?? 0) << 8);
    const y = (b[2 * n + i] ?? 0) | ((b[3 * n + i] ?? 0) << 8);
    const z = (b[4 * n + i] ?? 0) | ((b[5 * n + i] ?? 0) << 8);
    raw[i * 3] = x;
    raw[i * 3 + 1] = y;
    raw[i * 3 + 2] = z;
    positions[i * 3] = ox + sx * x;
    positions[i * 3 + 1] = oy + sy * y;
    positions[i * 3 + 2] = oz + sz * z;
    rgb[i * 3] = b[6 * n + i] ?? 0;
    rgb[i * 3 + 1] = b[7 * n + i] ?? 0;
    rgb[i * 3 + 2] = b[8 * n + i] ?? 0;
  }
  return { positions, raw, rgb, count: n, bounds: boundsOf(positions, n), quant };
}
