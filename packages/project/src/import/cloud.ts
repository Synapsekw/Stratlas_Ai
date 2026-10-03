import { mapPoint, type FrameMap } from './frames';

/**
 * `kit-packed` point cloud (data-conventions section 4), the Asset Inspection Kit layout:
 * N x (int16 x, int16 y, int16 z) little-endian in millimetres, followed by N x uint8 intensity.
 * Byte length is 7 * N.
 */
export interface KitCloud {
  count: number;
  /** Interleaved x, y, z in millimetres. */
  xyz: Int16Array;
  intensity: Uint8Array;
}

export function decodeKitCloud(bytes: Uint8Array): KitCloud {
  if (bytes.length % 7 !== 0) {
    throw new Error(`kit-packed cloud length ${bytes.length} is not a multiple of 7 bytes`);
  }
  const n = bytes.length / 7;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const xyz = new Int16Array(n * 3);
  for (let i = 0; i < n * 3; i++) xyz[i] = view.getInt16(i * 2, true);
  return { count: n, xyz, intensity: bytes.slice(n * 6, n * 7) };
}

export function encodeKitCloud(c: KitCloud): Uint8Array {
  const out = new Uint8Array(c.count * 7);
  const view = new DataView(out.buffer);
  for (let i = 0; i < c.count * 3; i++) view.setInt16(i * 2, c.xyz[i] ?? 0, true);
  out.set(c.intensity.subarray(0, c.count), c.count * 6);
  return out;
}

const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

/** Re-express a kit-packed cloud in another frame (positions rounded to the millimetre). */
export function convertKitCloud(bytes: Uint8Array, frame: FrameMap): Uint8Array {
  const c = decodeKitCloud(bytes);
  const xyz = new Int16Array(c.count * 3);
  for (let i = 0; i < c.count; i++) {
    const p = mapPoint(frame, [
      (c.xyz[i * 3] ?? 0) / 1000,
      (c.xyz[i * 3 + 1] ?? 0) / 1000,
      (c.xyz[i * 3 + 2] ?? 0) / 1000,
    ]);
    xyz[i * 3] = clamp16(p[0] * 1000);
    xyz[i * 3 + 1] = clamp16(p[1] * 1000);
    xyz[i * 3 + 2] = clamp16(p[2] * 1000);
  }
  return encodeKitCloud({ count: c.count, xyz, intensity: c.intensity });
}

/** Axis-aligned bounds in metres. */
export function kitCloudBounds(c: KitCloud): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < c.count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = (c.xyz[i * 3 + a] ?? 0) / 1000;
      lo[a] = Math.min(lo[a] ?? v, v);
      hi[a] = Math.max(hi[a] ?? v, v);
    }
  }
  return {
    min: [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0],
    max: [hi[0] ?? 0, hi[1] ?? 0, hi[2] ?? 0],
  };
}
