import { open, stat } from 'node:fs/promises';
import { readPhotoMeta, type PhotoMeta } from './exif';
import type { PanoFrameMeta } from './panoGroups';

/** Bytes read from the head of a frame: EXIF and DJI XMP sit in the first segments. */
export const PANO_HEAD_BYTES = 512 * 1024;

async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = new Uint8Array(bytes);
    const { bytesRead } = await fh.read(b, 0, bytes, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The grouping's view of a photo's metadata (DJI XMP position first, then EXIF GPS). */
export function panoFrameMeta(file: string, bytes: number, meta: PhotoMeta): PanoFrameMeta {
  const out: PanoFrameMeta = { file, bytes };
  if (meta.takenAt) out.takenAt = meta.takenAt;
  const lat = meta.dji?.lat ?? meta.gps?.lat;
  const lon = meta.dji?.lon ?? meta.gps?.lon;
  if (lat !== undefined && lon !== undefined) {
    out.lat = lat;
    out.lon = lon;
  }
  const abs = meta.dji?.absAlt ?? meta.gps?.alt;
  if (abs !== undefined) out.absAlt = abs;
  if (meta.dji?.relAlt !== undefined) out.relAlt = meta.dji.relAlt;
  if (meta.dji?.gimbal) out.gimbal = { ...meta.dji.gimbal };
  if (meta.width !== undefined && meta.height !== undefined) {
    out.width = meta.width;
    out.height = meta.height;
  }
  if (meta.gpano?.projection.toLowerCase() === 'equirectangular') out.gpano = true;
  return out;
}

/** Read one JPEG's head; a file that is not a JPEG (or cannot be read) is `unreadable`. */
export async function readPanoFrameMeta(file: string): Promise<PanoFrameMeta> {
  let bytes = 0;
  try {
    bytes = (await stat(file)).size;
    return panoFrameMeta(file, bytes, readPhotoMeta(await readHead(file, PANO_HEAD_BYTES)));
  } catch {
    return { file, bytes, unreadable: true };
  }
}
