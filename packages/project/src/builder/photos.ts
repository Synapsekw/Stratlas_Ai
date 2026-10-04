import { cameraQuatFromGimbal, fromWgs84, gridConvergenceDeg, lensFromFocal35 } from '@aio/geo';
import type { LensModel, PhotoRef, Vec3 } from '@aio/schema';
import type { PhotoMeta } from './exif';

export interface PhotoFrame {
  epsg: number;
  origin: Vec3;
  /** Camera clock offset from UTC, minutes, when EXIF has no OffsetTimeOriginal. */
  utcOffsetMin: number;
}

const DJI_MAKES = /^(dji|hasselblad)/i;

/**
 * Pinhole lens from the 35 mm equivalent focal length. DJI cameras crop wide photo modes (16:9)
 * from a 4:3 sensor at full width; other cameras use their own frame.
 */
export function photoLens(meta: PhotoMeta): LensModel | undefined {
  if (!meta.focal35 || !meta.width || !meta.height) return undefined;
  const aspect = meta.width / meta.height;
  const dji = DJI_MAKES.test(meta.make ?? '') || meta.dji !== undefined;
  const sensor = dji && aspect > 1.6 ? 4 / 3 : aspect;
  return lensFromFocal35(meta.focal35, aspect, sensor);
}

function offsetText(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/**
 * A photo layer item from its metadata: position in the local frame from GPS (DJI XMP first,
 * then EXIF), orientation from DJI gimbal angles (true north turned to grid north), lens from the
 * focal length and capture time with its UTC offset. Photos without GPS stay unplaced.
 */
export function photoRef(id: string, path: string, meta: PhotoMeta, f: PhotoFrame): PhotoRef {
  const ref: PhotoRef = { id, src: { path } };
  if (meta.takenAt) {
    const off = /^[+-]\d{2}:\d{2}$/.test(meta.utcOffset ?? '')
      ? (meta.utcOffset ?? '')
      : offsetText(f.utcOffsetMin);
    ref.takenAt = `${meta.takenAt}${off}`;
  }
  const lat = meta.dji?.lat ?? meta.gps?.lat;
  const lon = meta.dji?.lon ?? meta.gps?.lon;
  if (lat === undefined || lon === undefined) return ref;
  const h = meta.dji?.absAlt ?? meta.gps?.alt ?? f.origin[2];
  const p = fromWgs84([lon, lat, h], f.epsg);
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  ref.pos = [r(p[0] - f.origin[0]), r(p[2] - f.origin[2]), r(0 - (p[1] - f.origin[1]))];
  const g = meta.dji?.gimbal;
  if (g) {
    const conv = gridConvergenceDeg(lon, lat, f.epsg);
    const q = cameraQuatFromGimbal(g.yaw - conv, g.pitch, g.roll);
    ref.q = [q[0], q[1], q[2], q[3]].map((v) => Math.round(v * 1e7) / 1e7) as [
      number,
      number,
      number,
      number,
    ];
  }
  const lens = photoLens(meta);
  if (lens) ref.lens = lens;
  return ref;
}
