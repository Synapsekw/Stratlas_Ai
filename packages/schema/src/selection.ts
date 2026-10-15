import { z } from 'zod';

/**
 * Point selection files (`selections/<name>.sel`, data-conventions section 35): the points of a
 * point cloud inside a placed finding, as float32 x, y, z in the project local frame (metres).
 * Little-endian: 8 bytes ASCII magic `AIOSEL01`, uint32 point count, uint32 octree depth (lod),
 * then count x 3 float32. Coordinates, not chunk indices: they survive a re-tiling of the cloud.
 */
export const SELECTION_MAGIC = 'AIOSEL01';
export const SELECTION_HEADER_BYTES = 16;
/** 2 million points, 24 MB: far more than one finding holds at loaded detail. */
export const SELECTION_MAX_POINTS = 2_000_000;

/** File name of a selection without `.sel`: letters, digits, dash and underscore. */
export const SelectionName = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/, {
  message: 'A selection name is letters, digits, dash and underscore (at most 120)',
});

export function selectionByteLength(count: number): number {
  return SELECTION_HEADER_BYTES + count * 12;
}

export function encodeSelection(positions: Float32Array, lod: number): Uint8Array {
  if (positions.length % 3 !== 0) throw new Error('A selection holds whole points (x, y, z)');
  const count = positions.length / 3;
  const out = new Uint8Array(selectionByteLength(count));
  out.set(new TextEncoder().encode(SELECTION_MAGIC), 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, count, true);
  view.setUint32(12, Math.max(0, Math.floor(lod)), true);
  for (let i = 0; i < positions.length; i++)
    view.setFloat32(SELECTION_HEADER_BYTES + i * 4, positions[i] ?? 0, true);
  return out;
}

/** The points and depth of a selection file; null when it is not one. */
export function decodeSelection(
  bytes: Uint8Array,
): { positions: Float32Array; lod: number } | null {
  if (bytes.byteLength < SELECTION_HEADER_BYTES) return null;
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== SELECTION_MAGIC) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const lod = view.getUint32(12, true);
  if (count > SELECTION_MAX_POINTS || bytes.byteLength !== selectionByteLength(count)) return null;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < positions.length; i++)
    positions[i] = view.getFloat32(SELECTION_HEADER_BYTES + i * 4, true);
  return { positions, lod };
}
