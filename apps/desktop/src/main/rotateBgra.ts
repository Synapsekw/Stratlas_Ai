import type { Quat } from '@aio/schema';

/**
 * Clockwise 90 degrees of a BGRA bitmap, y down. The new width is the old height.
 * Old pixel (x, y) lands at (height - 1 - y, x).
 */
export function rotateBgra90(src: Buffer, width: number, height: number): Buffer {
  if (width < 1 || height < 1 || src.length !== width * height * 4) {
    throw new Error('The image bitmap size does not match.');
  }
  const dst = Buffer.alloc(src.length);
  const newW = height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = height - 1 - y;
      const ny = x;
      const si = (y * width + x) * 4;
      const di = (ny * newW + nx) * 4;
      dst[di] = src[si] ?? 0;
      dst[di + 1] = src[si + 1] ?? 0;
      dst[di + 2] = src[si + 2] ?? 0;
      dst[di + 3] = src[si + 3] ?? 0;
    }
  }
  return dst;
}

interface PinholeLens {
  model: 'pinhole';
  hfovDeg: number;
  aspect: number;
  cx?: number | undefined;
  cy?: number | undefined;
  k1?: number | undefined;
  k2?: number | undefined;
  k3?: number | undefined;
  p1?: number | undefined;
  p2?: number | undefined;
}
interface FthetaLens {
  model: 'ftheta';
  hfovDeg: number;
  aspect: number;
  k?: number[] | undefined;
}
type Lens = PinholeLens | FthetaLens;

/** New camera axes for clockwise pixels: q' = q * Rz(90), preserving world rays. */
export function turnQuat90([x, y, z, w]: Quat): Quat {
  const s = Math.SQRT1_2;
  return [(x + y) * s, (y - x) * s, (z + w) * s, (w - z) * s];
}

/**
 * A lens after the picture is turned 90 degrees clockwise. Aspect follows the new pixel size.
 * A pinhole's horizontal field of view becomes what was vertical, and a principal point turns
 * with the pixels. Refuse a field of view that cannot fit the lens schema.
 */
export function turnLens90<T extends Lens>(lens: T, width: number, height: number): T {
  const aspect = height / width;
  if (lens.model === 'ftheta') {
    const hfovDeg = (lens.hfovDeg * height) / width;
    if (!(hfovDeg > 0 && hfovDeg <= 360)) {
      throw new Error('This camera field of view cannot be represented after rotation.');
    }
    return { ...lens, aspect, hfovDeg };
  }
  const hfov = (lens.hfovDeg * Math.PI) / 180;
  const vfov = 2 * Math.atan((Math.tan(hfov / 2) * height) / width);
  const hfovDeg = (vfov * 180) / Math.PI;
  const next: PinholeLens = {
    ...lens,
    aspect,
    hfovDeg: hfovDeg > 0 && hfovDeg < 180 ? hfovDeg : lens.hfovDeg,
  };
  if (lens.cx !== undefined || lens.cy !== undefined) {
    next.cx = height - (lens.cy ?? height / 2);
    next.cy = lens.cx ?? width / 2;
  }
  if (lens.p1 !== undefined || lens.p2 !== undefined) {
    next.p1 = lens.p2 ?? 0;
    next.p2 = -(lens.p1 ?? 0);
  }
  return next as T;
}
