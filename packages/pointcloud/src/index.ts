import type { Vec3 } from '@aio/schema';

export interface DecodedCloud {
  /** xyz in metres, local frame, 3 floats per point. */
  positions: Float32Array;
  /** 0..255 per point. */
  intensity: Uint8Array;
  count: number;
}

/** Bytes per point in the kit packed format: int16 x, y, z (millimetres) + uint8 intensity. */
export const KIT_PACKED_STRIDE = 7;

/**
 * Decode the kit packed cloud (HCl Tank artifacts): little-endian int16 xyz in millimetres,
 * then a uint8 intensity, 7 bytes per point. `scale` converts stored units to metres.
 */
export function decodeKitPacked(
  buf: ArrayBuffer,
  scale = 0.001,
  offset: Vec3 = [0, 0, 0],
): DecodedCloud {
  if (buf.byteLength % KIT_PACKED_STRIDE !== 0) {
    throw new Error(
      `Packed cloud size ${buf.byteLength} is not a multiple of ${KIT_PACKED_STRIDE} bytes`,
    );
  }
  const count = buf.byteLength / KIT_PACKED_STRIDE;
  const view = new DataView(buf);
  const positions = new Float32Array(count * 3);
  const intensity = new Uint8Array(count);
  for (let i = 0, o = 0; i < count; i++, o += KIT_PACKED_STRIDE) {
    positions[i * 3] = view.getInt16(o, true) * scale + offset[0];
    positions[i * 3 + 1] = view.getInt16(o + 2, true) * scale + offset[1];
    positions[i * 3 + 2] = view.getInt16(o + 4, true) * scale + offset[2];
    intensity[i] = view.getUint8(o + 6);
  }
  return { positions, intensity, count };
}
